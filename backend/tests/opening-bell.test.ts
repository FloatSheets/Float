import { expect, test } from "bun:test";

import { openingBellTerms, openingBellTicket, type OpeningBellOptions } from "../src/markets/opening-bell";
import { openingBell } from "../src/markets/sessions";

const options: OpeningBellOptions = { enabled: true, minutes: 10, extraSpreadBps: 15, ticketBps: 5_000 };

test("covers the first minutes after the 9:30 ET open on trading days only", () => {
  // Monday 26 October 2026 (EDT, UTC-4).
  expect(openingBell(new Date("2026-10-26T13:29:59.000Z"), 10)).toBeNull();
  expect(openingBell(new Date("2026-10-26T13:30:00.000Z"), 10)?.endsAt.toISOString()).toBe("2026-10-26T13:40:00.000Z");
  expect(openingBell(new Date("2026-10-26T13:39:59.000Z"), 10)).not.toBeNull();
  expect(openingBell(new Date("2026-10-26T13:40:00.000Z"), 10)).toBeNull();
  // After clocks fall back, 9:30 ET is 14:30 UTC.
  expect(openingBell(new Date("2026-11-02T14:31:00.000Z"), 10)?.startsAt.toISOString()).toBe("2026-11-02T14:30:00.000Z");
  expect(openingBell(new Date("2026-11-02T13:31:00.000Z"), 10)).toBeNull();
  // No bell on weekends or NYSE holidays.
  expect(openingBell(new Date("2026-10-24T13:31:00.000Z"), 10)).toBeNull();
  expect(openingBell(new Date("2026-11-26T14:31:00.000Z"), 10)).toBeNull();
});

test("applies configured terms and ticket share", () => {
  const terms = openingBellTerms(options, new Date("2026-10-26T13:35:00.000Z"))!;
  expect(terms.extraSpreadBps).toBe(15);
  expect(openingBellTicket(50_000_000_000n, terms)).toBe(25_000_000_000n);
  expect(openingBellTerms({ ...options, enabled: false }, new Date("2026-10-26T13:35:00.000Z"))).toBeNull();
  expect(openingBellTerms({ ...options, minutes: 0 }, new Date("2026-10-26T13:35:00.000Z"))).toBeNull();
});
