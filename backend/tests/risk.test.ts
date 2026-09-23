import { expect, test } from "bun:test";

import { assessMarketRisk } from "../src/markets/risk";

const healthy = { marketStatus: "active" as const, maxHalfSpreadBps: 100, quoteBps: Array(10).fill(50), snapshotAgeSeconds: 30, usdgBalance: 1n };

test("keeps a healthy active market open", () => expect(assessMarketRisk(healthy, 120)).toBe("active"));
test("preserves restricted and pilot markets when healthy", () => {
  expect(assessMarketRisk({ ...healthy, marketStatus: "restricted" }, 120)).toBe("restricted");
  expect(assessMarketRisk({ ...healthy, marketStatus: "pilot" }, 120)).toBe("pilot");
});
test("pauses disabled markets", () => expect(assessMarketRisk({ ...healthy, marketStatus: "disabled" }, 120)).toBe("paused"));
test("moves stale, empty, incomplete, and excessive-impact markets close-only", () => {
  expect(assessMarketRisk({ ...healthy, snapshotAgeSeconds: 121 }, 120)).toBe("close_only");
  expect(assessMarketRisk({ ...healthy, snapshotAgeSeconds: null }, 120)).toBe("close_only");
  expect(assessMarketRisk({ ...healthy, usdgBalance: 0n }, 120)).toBe("close_only");
  expect(assessMarketRisk({ ...healthy, quoteBps: [50] }, 120)).toBe("close_only");
  expect(assessMarketRisk({ ...healthy, quoteBps: Array(10).fill(101) }, 120)).toBe("close_only");
});
