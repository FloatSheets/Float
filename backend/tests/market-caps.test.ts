import { expect, test } from "bun:test";

import { effectiveMaxTicketUsdg } from "../src/routes/markets";

test("reports the lower backend or on-chain market ticket cap", () => {
  expect(effectiveMaxTicketUsdg("15000.000000", 25_000_000_000n)).toBe(15_000);
  expect(effectiveMaxTicketUsdg("30000.000000", 25_000_000_000n)).toBe(25_000);
});
