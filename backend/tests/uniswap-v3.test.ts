import { expect, test } from "bun:test";

import { absoluteDeviationBps, arithmeticMeanTick, priceUsdgFromTick } from "../src/chain/uniswap-v3";

const usdg = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const stock = "0x1111111111111111111111111111111111111111";

test("rounds negative arithmetic ticks toward negative infinity", () => {
  expect(arithmeticMeanTick([0n, -181n], 60)).toBe(-4);
});

test("converts a stock/USDG tick into a USDG price", () => {
  expect(priceUsdgFromTick(0, stock, usdg, 18, 6)).toBe(1_000_000_000_000);
});

test("converts a USDG/stock tick into an inverse USDG price", () => {
  expect(priceUsdgFromTick(0, usdg, stock, 6, 18)).toBe(1_000_000_000_000);
});

test("refuses a pool without USDG", () => {
  expect(() => priceUsdgFromTick(0, stock, "0x2222222222222222222222222222222222222222", 18, 18)).toThrow(
    "direct USDG"
  );
});

test("measures a spot/TWAP circuit-breaker deviation in bps", () => {
  expect(absoluteDeviationBps(100, 100.5)).toBe(50);
  expect(() => absoluteDeviationBps(0, 100)).toThrow("Prices must be finite and positive");
});
