/** Integer accounting matches FloatClearingHouse, including USDG's six decimals. */
export const abs = (n: bigint) => n < 0n ? -n : n;
export function unrealizedPnl(size: bigint, entry: bigint, mark: bigint) {
  return size * (mark - entry) / 10n ** 30n;
}

/** Indicative mark where equity equals maintenance, using the current post-fee
 * margin and on-chain maintenance ratio. Contract USDG rounding and oracle
 * availability affect actual liquidation; this is not an execution guarantee. */
export function liquidationPrice(size: bigint, entry: bigint, margin: bigint, maintenanceBps: bigint): bigint | null {
  if (size === 0n) return null;
  if (entry <= 0n || margin < 0n || maintenanceBps <= 0n || maintenanceBps >= 10000n) {
    throw new Error('Invalid liquidation inputs');
  }
  const quantity = abs(size);
  const collateral = margin * 10n ** 30n;
  const numerator = quantity * entry + (size > 0n ? -collateral : collateral);
  if (numerator <= 0n) return null; // Fully collateralized long: no positive boundary.
  return numerator * 10000n / (quantity * (10000n + (size > 0n ? -maintenanceBps : maintenanceBps)));
}

export type AccountEvent = {
  eventName: string;
  args: { marketId: string; assets?: bigint; sizeDeltaE18?: bigint; executionPriceE18?: bigint; feeUsdg?: bigint; pnlUsdg?: bigint; penaltyUsdg?: bigint };
};
export function replayAccount(events: AccountEvent[]) {
  const markets = new Map<string, { size: bigint; entry: bigint; margin: bigint }>();
  let realized = 0n, deposits = 0n;
  for (const { eventName, args: a } of events) {
    const key = a.marketId.toLowerCase();
    const p = markets.get(key) ?? { size: 0n, entry: 0n, margin: 0n };
    if (eventName === 'MarginDeposited') { p.margin += a.assets!; deposits += a.assets!; }
    else if (eventName === 'MarginWithdrawn') p.margin -= a.assets!;
    else if (eventName === 'TradeExecuted') {
      const delta = a.sizeDeltaE18!, price = a.executionPriceE18!, old = p.size;
      if (old === 0n || (old > 0n) === (delta > 0n)) {
        p.entry = (abs(old) * p.entry + abs(delta) * price) / (abs(old) + abs(delta));
      } else {
        const closed = abs(old) < abs(delta) ? abs(old) : abs(delta);
        const gross = unrealizedPnl(old > 0n ? closed : -closed, p.entry, price);
        // Full closes cap losses at the available margin, as the contract does.
        const settled = gross < -p.margin ? -p.margin : gross;
        realized += settled; p.margin += settled;
        if (old + delta === 0n) p.entry = 0n;
        else if ((old + delta > 0n) !== (old > 0n)) p.entry = price;
      }
      p.size += delta;
      p.margin -= a.feeUsdg!;
      realized -= a.feeUsdg!;
    } else if (eventName === 'PositionLiquidated') {
      const settled = a.pnlUsdg! < -p.margin ? -p.margin : a.pnlUsdg!;
      realized += settled - a.penaltyUsdg!;
      p.size = 0n; p.entry = 0n; p.margin = 0n;
    }
    if (p.margin < 0n) throw new Error('Incomplete trading history.');
    markets.set(key, p);
  }
  return { markets, realized, deposits };
}
