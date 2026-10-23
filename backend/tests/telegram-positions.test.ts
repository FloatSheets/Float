import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { encodeAbiParameters, parseAbiParameters } from 'viem';
import type { AppConfig } from '../src/config';
import { telegramPositionReports } from '../src/alerts/telegram-positions';

const clearing = '0x1111111111111111111111111111111111111111';
const wallet = '0x2222222222222222222222222222222222222222';
const config = {
  JAGUAR_FLOAT_CLEARING_HOUSE_ADDRESS: clearing,
  JAGUAR_FLOAT_ORACLE_ADDRESS: '0x3333333333333333333333333333333333333333',
  JAGUAR_FLOAT_VAULT_ADDRESS: '0x4444444444444444444444444444444444444444',
  ORACLE_PRICE_MAX_AGE_SECONDS: 120,
} as AppConfig;
function database(linked = true) {
  return { query: async (sql: string, params?: string[]) => {
    if (sql.includes('liquidation_telegram_links')) {
      expect(sql).toContain('WHERE telegram_chat_id=$1');
      expect(params).toEqual(['123']);
      return { rows: linked ? [{ wallet_address: wallet }] : [] };
    }
    return { rows: [{ symbol: 'NVDA' }] };
  }} as unknown as Pool;
}
test('unlinked chat cannot cause chain reads or select another wallet', async () => {
  const reports = await telegramPositionReports(database(false), config, { call: async () => { throw Error('must not read'); } }, '123', 'jaguar');
  expect(reports).toHaveLength(1);
  expect(reports[0]).toContain('Link your wallet');
});
test('short profit is positive when mark falls, and stale marks are labeled', async () => {
  const reports = await telegramPositionReports(database(), config, { call: async ({ to, data }) => {
    if (to === clearing) {
      expect(data.toLowerCase()).toContain(wallet.slice(2));
      return encodeAbiParameters(parseAbiParameters('int256,uint256,uint256,uint64'), [-2n * 10n ** 18n, 100n * 10n ** 18n, 50_000_000n, 1n]);
    }
    return encodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256,uint64,uint64,bool'), [90n * 10n ** 18n, 90n * 10n ** 18n, 50n, 0n, 1n, 1n, false]);
  } }, '123', 'jaguar');
  expect(reports[0]).toContain('SHORT');
  expect(reports[0]).toContain('+20 USDG');
  expect(reports[0]).toContain('(stale)');
  expect(reports[0]).toContain('Margin: 50 USDG');
});
test('oracle failure preserves the position with unavailable PnL', async () => {
  const reports = await telegramPositionReports(database(), config, { call: async ({ to }) => {
    if (to !== clearing) throw Error('oracle down');
    return encodeAbiParameters(parseAbiParameters('int256,uint256,uint256'), [10n ** 18n, 100n * 10n ** 18n, 50_000_000n]);
  } }, '123', 'jaguar');
  expect(reports[0]).toContain('LONG');
  expect(reports[0]).toContain('PnL: unavailable');
});
test('failed position reads never claim that the wallet has no positions', async () => {
  const reports = await telegramPositionReports(database(), config, { call: async () => { throw Error('RPC down'); } }, '123', 'jaguar');
  expect(reports.join()).toContain('incomplete');
  expect(reports.join()).not.toContain('no open positions');
});
