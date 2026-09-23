export type MarketRiskInput = {
  maxHalfSpreadBps: number;
  marketStatus: "active" | "restricted" | "pilot" | "disabled";
  quoteBps: number[];
  oracleTradable: boolean | null;
  snapshotAgeSeconds: number | null;
  usdgBalance: bigint | null;
};

export type MarketRiskState = "active" | "restricted" | "pilot" | "close_only" | "paused";

export function assessMarketRisk(input: MarketRiskInput, maxPriceAgeSeconds: number): MarketRiskState {
  if (input.marketStatus === "disabled") return "paused";
  if (input.snapshotAgeSeconds === null || input.snapshotAgeSeconds > maxPriceAgeSeconds) return "close_only";
  if (input.usdgBalance === null || input.usdgBalance <= 0n) return "close_only";
  if (input.oracleTradable !== true) return "close_only";
  if (input.quoteBps.length !== 10 || input.quoteBps.some((value) => !Number.isFinite(value))) return "close_only";
  if (Math.max(...input.quoteBps) > input.maxHalfSpreadBps) return "close_only";
  return input.marketStatus;
}
