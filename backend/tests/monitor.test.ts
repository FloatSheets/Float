import { expect, test } from "bun:test";

import { quoteNotionalsForMarketCap } from "../src/markets/monitor";

test("quote matrices stop at each market's configured ticket cap", () => {
  expect(quoteNotionalsForMarketCap("1000.000000")).toEqual([5, 10, 100, 500, 1_000]);
  expect(quoteNotionalsForMarketCap("10000.000000")).toEqual([5, 10, 1_000, 5_000, 10_000]);
  expect(quoteNotionalsForMarketCap("25000.000000")).toEqual([5, 10, 2_500, 12_500, 25_000]);
});

test("rejects market caps too small for five distinct quote sizes", () => {
  expect(() => quoteNotionalsForMarketCap("99")).toThrow("at least $100");
});
