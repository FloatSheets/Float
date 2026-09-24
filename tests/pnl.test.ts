import { describe, expect, test } from 'bun:test';
import { replayAccount, unrealizedPnl, type AccountEvent } from '../src/lib/pnl';
import '../public/dashboard/pnl-display.js';

const E18 = 10n ** 18n, USDG = 10n ** 6n;
const deposit = (assets: bigint, marketId = 'NVDA'): AccountEvent => ({ eventName: 'MarginDeposited', args: { marketId, assets } });
const trade = (size: bigint, price: bigint, fee = 0n, marketId = 'NVDA'): AccountEvent => ({ eventName: 'TradeExecuted', args: { marketId, sizeDeltaE18: size, executionPriceE18: price, feeUsdg: fee } });
const display = (globalThis as any).FloatSheetsPnlDisplay;

describe('settlement-precision PnL', () => {
  test('keeps tiny gains/losses and values beyond Number precision', () => {
    expect(display.signedDecimal(1n)).toBe('+0.000001');
    expect(display.signedDecimal(-199n)).toBe('−0.000199');
    expect(display.signedDecimal(9007199254740993123456n)).toBe('+9007199254740993.123456');
    expect(display.signedDecimal(0n)).toBe('+0.000000');
  });
  test('percent is return on margin; zero margin is undefined', () => {
    expect(display.percentage(-199n, 24926n)).toBe('−0.798363%');
    expect(display.percentage(1n, 1n)).toBe('+100.000000%');
    expect(display.percentage(0n, 0n)).toBe('—');
  });
  test('matches contract truncation for long and short', () => {
    expect(unrealizedPnl(E18, 100n * E18, 110n * E18)).toBe(10n * USDG);
    expect(unrealizedPnl(-E18, 100n * E18, 110n * E18)).toBe(-10n * USDG);
    expect(unrealizedPnl(1n, E18, 0n)).toBe(0n);
  });
});

describe('realized accounting from contract events', () => {
  test('includes paid entry fees immediately, but no unrealized gains', () => {
    const result = replayAccount([deposit(20n * USDG), trade(E18, 100n * E18, 60000n)]);
    expect(result.realized).toBe(-60000n);
    expect(result.markets.get('nvda')?.margin).toBe(19940000n);
  });
  test('weighted additions, partial close and full close including fees', () => {
    const result = replayAccount([deposit(100n * USDG), trade(E18, 100n * E18), trade(E18, 120n * E18), trade(-E18, 130n * E18, USDG), trade(-E18, 100n * E18, USDG)]);
    expect(result.realized).toBe(8n * USDG);
    expect(result.markets.get('nvda')).toEqual({ size: 0n, entry: 0n, margin: 108n * USDG });
  });
  test('short gains and side flips reset entry correctly', () => {
    const result = replayAccount([deposit(100n * USDG), trade(-E18, 100n * E18), trade(2n * E18, 80n * E18)]);
    expect(result.realized).toBe(20n * USDG);
    expect(result.markets.get('nvda')).toEqual({ size: E18, entry: 80n * E18, margin: 120n * USDG });
  });
  test('full-close losses cannot exceed actual margin collected', () => {
    const result = replayAccount([deposit(10n * USDG), trade(E18, 100n * E18), trade(-E18, 50n * E18)]);
    expect(result.realized).toBe(-10n * USDG);
    expect(result.markets.get('nvda')?.margin).toBe(0n);
  });
  test('liquidation includes penalties and resets exposure', () => {
    const result = replayAccount([deposit(20n * USDG), trade(E18, 100n * E18), { eventName: 'PositionLiquidated', args: { marketId: 'NVDA', pnlUsdg: -15n * USDG, penaltyUsdg: USDG } }]);
    expect(result.realized).toBe(-16n * USDG);
    expect(result.markets.get('nvda')).toEqual({ size: 0n, entry: 0n, margin: 0n });
  });
  test('bad-debt liquidation caps loss; withdrawal is not PnL', () => {
    const result = replayAccount([deposit(20n * USDG), { eventName: 'MarginWithdrawn', args: { marketId: 'NVDA', assets: 10n * USDG } }, trade(E18, 100n * E18), { eventName: 'PositionLiquidated', args: { marketId: 'NVDA', pnlUsdg: -30n * USDG, penaltyUsdg: 0n } }]);
    expect(result.realized).toBe(-10n * USDG);
    expect(result.deposits).toBe(20n * USDG);
  });
  test('keeps separate cost bases across markets and rejects incomplete margin history', () => {
    const result = replayAccount([deposit(20n * USDG), deposit(30n * USDG, 'SPCX'), trade(E18, 100n * E18), trade(E18, 150n * E18, 0n, 'SPCX')]);
    expect(result.markets.get('nvda')?.entry).toBe(100n * E18);
    expect(result.markets.get('spcx')?.entry).toBe(150n * E18);
    expect(() => replayAccount([trade(E18, E18, USDG)])).toThrow('Incomplete trading history');
  });
});
