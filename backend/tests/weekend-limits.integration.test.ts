import "dotenv/config";

import { beforeEach, expect, test } from "bun:test";
import type { Address } from "viem";

import { db } from "../src/db";
import { migrate } from "../src/db/migrate";
import { WeekendWalletLimits, type WeekendLimitOptions } from "../src/markets/weekend-limits";

const options: WeekendLimitOptions = { enabled: true, capBps: 2_500, cooldownSeconds: 300 };
const HOUSE = "0xa1329c69e8eda292cda849babb990fbd05198cdb" as Address;
const WHALE = "0x00000000000000000000000000000000000000aa" as Address;
const OTHER = "0x00000000000000000000000000000000000000bb" as Address;
const SATURDAY = new Date("2026-10-24T15:00:00.000Z");
const THURSDAY = new Date("2026-10-22T15:00:00.000Z");
const usdg = (dollars: number) => BigInt(dollars) * 1_000_000n;
const at = (minutes: number) => new Date(SATURDAY.getTime() + minutes * 60_000);

beforeEach(async () => {
  await migrate();
  await db.query("TRUNCATE public.weekend_quotes");
});

function limits(executed: Set<bigint>, house: Address = HOUSE) {
  return new WeekendWalletLimits(db, house, options, async (_trader, nonce) => executed.has(nonce));
}

test("does not limit wallets while the underlying can trade", async () => {
  const guard = limits(new Set());
  expect(await guard.allowance("NVDA", WHALE, THURSDAY)).toBeNull();
  expect(await guard.refusal("NVDA", WHALE, usdg(50_000), THURSDAY)).toBeNull();
});

test("caps each wallet at a quarter of the market ticket per closure", async () => {
  const guard = limits(new Set());
  // NVDA's max ticket is $50,000, so the weekend allowance is $12,500.
  expect(await guard.refusal("NVDA", WHALE, usdg(12_500), at(0))).toBeNull();
  expect(await guard.refusal("NVDA", WHALE, usdg(12_501), at(0)))
    .toBe("While NVDA's underlying is closed, each wallet can add up to $12,500.00 per market. You have $12,500.00 left until trading resumes; you can still close.");

  // An unexpired quote reserves its notional so parallel quotes cannot stack.
  await guard.record("NVDA", WHALE, 1n, usdg(10_000), at(2), at(0));
  expect(await guard.refusal("NVDA", WHALE, usdg(3_000), at(1))).toContain("You have $2,500.00 left");
  expect(await guard.refusal("NVDA", WHALE, usdg(2_500), at(1))).toBeNull();
  // Other wallets and markets have their own allowance.
  expect(await guard.refusal("NVDA", OTHER, usdg(12_500), at(1))).toBeNull();
  expect(await guard.refusal("TSLA", WHALE, usdg(2_500), at(1))).toBeNull();
}, 60_000);

test("releases unexecuted quotes and applies a cooldown after executed opens", async () => {
  const executed = new Set<bigint>([2n]);
  const guard = limits(executed);
  await guard.record("NVDA", WHALE, 1n, usdg(6_000), at(2), at(0)); // never executed
  await guard.record("NVDA", WHALE, 2n, usdg(4_000), at(12), at(10)); // executed

  const expired = (await guard.allowance("NVDA", WHALE, at(13)))!;
  expect(expired.usedUsdg).toBe(usdg(4_000));
  expect(expired.pendingUsdg).toBe(0n);
  expect(expired.cooldownUntil?.toISOString()).toBe(at(15).toISOString());
  expect(await guard.refusal("NVDA", WHALE, usdg(1_000), at(13)))
    .toBe("While NVDA's underlying is closed, each wallet can open once every 5 minutes. Try again in 2 minutes; you can still close.");

  expect(await guard.refusal("NVDA", WHALE, usdg(8_500), at(16))).toBeNull();
  expect(await guard.refusal("NVDA", WHALE, usdg(8_501), at(16))).toContain("You have $8,500.00 left");

  // Settled results are stored, so later reads do not depend on the chain.
  const settled = await db.query<{ nonce: string; executed: boolean }>("SELECT nonce::text, executed FROM public.weekend_quotes ORDER BY nonce");
  expect(settled.rows).toEqual([{ nonce: "1", executed: false }, { nonce: "2", executed: true }]);
  const view = limits(new Set()).view("NVDA", expired);
  expect(view).toMatchObject({ market: "NVDA", cap_usdg: "12500.000000", used_usdg: "4000.000000", remaining_usdg: "8500.000000" });
}, 60_000);

test("counts allowance per deployment and per closure", async () => {
  await limits(new Set()).record("NVDA", WHALE, 7n, usdg(12_500), at(2), at(0));
  const otherHouse = limits(new Set(), "0xc197d8f546cc56a4148b30a74d3a2c5975255c6a");
  expect(await otherHouse.refusal("NVDA", WHALE, usdg(12_500), at(1))).toBeNull();
  // The next weekend starts with a fresh allowance.
  expect(await limits(new Set()).refusal("NVDA", WHALE, usdg(12_500), new Date("2026-10-31T15:00:00.000Z"))).toBeNull();
}, 60_000);
