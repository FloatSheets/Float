import type { Pool } from 'pg';
import { decodeFunctionResult, encodeFunctionData, formatUnits, parseAbi, type Address } from 'viem';
import { contractConfigForVersion, contractVersionSchema, type AppConfig, type ContractVersion } from '../config';
import { marketId } from '../chain/protocol';
import { readOraclePrice } from '../chain/protocol-read';
import type { RpcTransport } from '../chain/rpc';

// The first three return values are shared by Orion and all newer releases.
const positionAbi = parseAbi(['function getPosition(address,bytes32) view returns (int256,uint256,uint256)']);

export async function telegramPositionReports(database: Pool, config: AppConfig, rpc: RpcTransport, chatId: string, version?: ContractVersion): Promise<string[]> {
  // The signed linking flow is the only source of wallet addresses. Pausing
  // notifications does not remove the wallet link or disable read-only commands.
  const { rows: wallets } = await database.query<{ wallet_address: Address }>(
    'SELECT wallet_address FROM public.liquidation_telegram_links WHERE telegram_chat_id=$1 ORDER BY wallet_address', [chatId]
  );
  if (!wallets.length) return ['Link your wallet in FloatSheets Dashboard → Settings → Telegram, then try /positions again.'];
  const { rows: markets } = await database.query<{ symbol: string }>('SELECT symbol FROM public.markets ORDER BY symbol');
  if (!markets.length) return ['Market data is unavailable. Please try /positions again shortly.'];
  const messages: string[] = [];
  for (const wallet of wallets) {
    const label = `${wallet.wallet_address.slice(0, 6)}…${wallet.wallet_address.slice(-4)}`;
    let found = 0, failed = 0, checked = 0;
    for (const selected of version ? [version] : contractVersionSchema.options) {
      let deployment: AppConfig;
      try { deployment = contractConfigForVersion(config, selected); } catch { continue; }
      checked++;
      for (const { symbol } of markets) {
        let position: readonly [bigint, bigint, bigint];
        try {
          const data = encodeFunctionData({ abi: positionAbi, functionName: 'getPosition', args: [wallet.wallet_address, marketId(symbol)] });
          const result = await rpc.call({ to: deployment.FLOAT_CLEARING_HOUSE_ADDRESS as Address, data });
          position = decodeFunctionResult({ abi: positionAbi, functionName: 'getPosition', data: result });
        } catch { failed++; continue; }
        const [size, entry, margin] = position;
        if (size === 0n) continue;
        found++;
        let markText = 'Mark / unrealized PnL: unavailable';
        try {
          const mark = await readOraclePrice(rpc, deployment.FLOAT_ORACLE_ADDRESS as Address, marketId(symbol));
          if (mark.priceE18 > 0n && mark.timestamp > 0n) {
            const pnl = size * (mark.priceE18 - entry) / (10n ** 30n);
            const stale = BigInt(Math.floor(Date.now() / 1000)) > mark.timestamp + BigInt(config.ORACLE_PRICE_MAX_AGE_SECONDS);
            markText = `Mark: ${formatUnits(mark.priceE18, 18)} USDG${stale ? ' (stale)' : ''}${mark.circuitBroken ? ' (breaker active)' : ''}\nUnrealized PnL: ${pnl > 0n ? '+' : ''}${formatUnits(pnl, 6)} USDG\nBefore fees and borrow charges.`;
          }
        } catch { /* Show the position even when its oracle cannot be read. */ }
        messages.push(`${symbol} · ${size > 0n ? 'LONG' : 'SHORT'}\n${selected} · ${label}\nMargin: ${formatUnits(margin, 6)} USDG\nBase size: ${formatUnits(size < 0n ? -size : size, 18)}\nEntry: ${formatUnits(entry, 18)} USDG\n${markText}`);
      }
    }
    if (!checked) messages.push(`${label}: this deployment is not configured.`);
    else if (!found) messages.push(failed ? `${label}: position lookup is incomplete. Please retry shortly.` : `${label}: no open positions${version ? ` on ${version}` : ''}.`);
    else if (failed) messages.push(`${label}: some markets could not be read. Results above are incomplete.`);
  }
  return messages;
}
