/** Integer accounting matches FloatClearingHouse, including USDG's six decimals. */
export const abs = (n: bigint) => n < 0n ? -n : n;
export function unrealizedPnl(size: bigint, entry: bigint, mark: bigint) {
  return size * (mark - entry) / 10n ** 30n;
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
