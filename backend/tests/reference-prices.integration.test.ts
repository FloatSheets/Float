import "dotenv/config";

import { afterEach, beforeEach, expect, test } from "bun:test";
import express from "express";
import request from "supertest";
import { encodeAbiParameters, type Address, type Hex } from "viem";

import { db } from "../src/db";
import { migrate } from "../src/db/migrate";
import {
  aggregateReference, assertOfficialStockTokens, fetchPythPrices, fetchRobinhoodQuotes, ReferencePriceMonitor,
  referenceQuoteSamples, ROBINHOOD_STOCK_TOKEN_BEACON, type SourceQuote
} from "../src/prices/reference";
import { createMarketsRouter } from "../src/routes/markets";
import { circuitBroken, frozenSpotE18, oracleCatchUp, oraclePublishRequired } from "../src/oracle/publisher";
import type { RpcTransport } from "../src/chain/rpc";

const RCAT = "0xFDE6b5d9BB419B10C23268c74e369AbFF39C0460";
const now = new Date("2026-10-22T16:00:00.000Z");
const quote = (source: SourceQuote["source"], mid: number, ageSeconds = 5, extra: Partial<SourceQuote> = {}): SourceQuote => ({
  source, mid, bid: null, ask: null, sourceTime: new Date(now.getTime() - ageSeconds * 1_000), halted: false, ...extra
});
const options = { now, maxAgeSeconds: 90, maxDispersionBps: 150, minSourcesForOpen: 2, minHalfSpreadBps: 50, tokenPaused: false, pendingMultiplier: false };

beforeEach(async () => {
  await migrate();
});

afterEach(async () => {
  await db.query("DELETE FROM public.reference_quotes");
  await db.query("DELETE FROM public.quote_samples WHERE market_id IN (SELECT id FROM public.markets WHERE price_source='reference')");
  await db.query("DELETE FROM public.pool_snapshots WHERE source='reference'");
});

test("uses the median of fresh agreeing sources and opens with two of them", () => {
  const result = aggregateReference([quote("robinhood", 4.50, 5, { bid: 4.49, ask: 4.51 }), quote("pyth", 4.52)], options);
  expect(result.mid).toBeCloseTo(4.51, 6);
  expect(result.sourcesUsed).toBe(2);
  expect(result.tradable).toBe(true);
  expect(result.halfSpreadBps).toBe(50); // quoted half spread (~22 bps) is below the market floor
});

test("refuses opens when sources disagree, are stale, halted, paused or too few", () => {
  // Disagreement: opens stop, Robinhood's own token quote becomes the mark, nothing freezes.
  const split = aggregateReference([quote("robinhood", 4.50), quote("pyth", 4.70)], options);
  expect(split).toMatchObject({ mid: 4.50, tradable: false, frozen: false });
  expect(split.frozenReason).toContain("disagree");
  // Spread is measured pairwise (max - min), not against the median: 10.00 vs 10.29 is 290 bps.
  expect(aggregateReference([quote("robinhood", 10.00), quote("pyth", 10.29)], options).dispersionBps).toBe(290);
  const stale = aggregateReference([quote("robinhood", 4.50), quote("pyth", 4.51, 600)], options);
  expect(stale.sourcesUsed).toBe(1);
  expect(stale.frozenReason).toBe("1 of 2 required price sources are live");
  const halted = aggregateReference([quote("robinhood", 4.5, 5, { halted: true }), quote("pyth", 4.5)], options);
  expect(halted).toMatchObject({ frozen: true, halfSpreadBps: 700 });
  expect(halted.frozenReason).toContain("halt");
  expect(aggregateReference([quote("robinhood", 4.5), quote("pyth", 4.5)], { ...options, tokenPaused: true })).toMatchObject({ frozen: true });
  expect(aggregateReference([quote("robinhood", 4.5), quote("pyth", 4.5)], { ...options, pendingMultiplier: true }).frozenReason).toContain("multiplier");
  expect(aggregateReference([], options)).toMatchObject({ mid: null, tradable: false, frozen: true, frozenReason: "no live price source" });
  // A one-source market (tier 2) can open on Robinhood alone.
  expect(aggregateReference([quote("robinhood", 2.33, 5, { bid: 2.33, ask: 2.34 })], { ...options, minSourcesForOpen: 1 }).tradable).toBe(true);
  // A quote stamped in the future is ignored.
  expect(aggregateReference([quote("robinhood", 4.5, -60)], { ...options, minSourcesForOpen: 1 }).sourcesUsed).toBe(0);
});

test("quotes the ask side for buys and the bid side for sells, against the live mark", () => {
  const [small, large] = referenceQuoteSamples({ mid: 5, halfSpreadBps: 50, notionals: [5, 1_000], virtualDepthUsdg: 250_000 });
  expect(small!.buyBps).toBe(51); // 50 bps half spread + ~0.1 bps impact, rounded up
  expect(large!.buyBps).toBe(70); // + 20 bps impact at $1,000
  expect(large!.sellBps).toBe(70);
  const [frozen] = referenceQuoteSamples({ mid: 5, halfSpreadBps: 700, notionals: [5], virtualDepthUsdg: 250_000 });
  expect(frozen!.buyBps).toBeGreaterThanOrEqual(700);
  expect(frozen!.buyBps).toBeLessThan(750); // inside the protocol's 750 bps execution bound
});

test("parses Robinhood quotes by official contract address and Pyth prices by feed id", async () => {
  const robinhood = await fetchRobinhoodQuotes("https://example.test/rhj/prices/", (async () => Response.json({ quotes: [
    { tokenSymbol: "RCAT", deployments: [{ contractAddress: RCAT, chainId: 4663 }], tokenBid: "4.49", tokenAsk: "4.52", isTradingHalt: false, generatedAt: now.toISOString() },
    { tokenSymbol: "BAD", deployments: [{ contractAddress: "0x0000000000000000000000000000000000000001", chainId: 1 }], tokenBid: "1", tokenAsk: "1", generatedAt: now.toISOString() },
    { tokenSymbol: "X", deployments: [{ contractAddress: "0x0000000000000000000000000000000000000002", chainId: 4663 }], tokenBid: "2", tokenAsk: "1", generatedAt: now.toISOString() }
  ] })) as unknown as typeof fetch);
  expect([...robinhood.keys()]).toEqual([RCAT.toLowerCase()]);
  expect(robinhood.get(RCAT.toLowerCase())).toMatchObject({ bid: 4.49, ask: 4.52, halted: false });

  let requested = "";
  const pyth = await fetchPythPrices("https://hermes.example.test/", ["abc"], "key", (async (url: string, init?: RequestInit) => {
    requested = url;
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer key");
    return Response.json({ parsed: [{ id: "ABC", price: { price: "450500000", conf: "50000", expo: -8, publish_time: now.getTime() / 1_000 } }] });
  }) as unknown as typeof fetch);
  expect(requested).toBe("https://hermes.example.test/v2/updates/price/latest?ids[]=abc&parsed=true");
  expect(pyth.get("abc")?.price).toBeCloseTo(4.505, 6);
});

test("frozen marks set the on-chain breaker and moved marks republish", () => {
  const mark = 5n * 10n ** 18n;
  expect(circuitBroken(mark, frozenSpotE18(mark, 300n), 300n)).toBe(true);
  // The oracle floors (spot - price) * 1e4 / price: check arbitrary-wei marks, both bands.
  let seed = 123456789n;
  for (let i = 0; i < 2_000; i++) {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
    const randomMark = 10n ** 15n + seed * 1_000_003n;
    for (const band of [50n, 300n]) {
      const spot = frozenSpotE18(randomMark, band);
      expect((spot - randomMark) * 10_000n / randomMark > band).toBe(true);
    }
  }
  expect(circuitBroken(mark, mark, 300n)).toBe(false);
  const base = { sequence: 3n, currentTimestamp: 1_000n, chainNow: 1_010n, currentCircuitBroken: false, nextCircuitBroken: false };
  expect(oraclePublishRequired(base)).toBe(false);
  expect(oraclePublishRequired({ ...base, markMoveBps: 20n, republishBps: 25n })).toBe(false);
  expect(oraclePublishRequired({ ...base, markMoveBps: 26n, republishBps: 25n })).toBe(true);
});

test("uses per-market oracle thresholds for the breaker and the catch-up walk", () => {
  const e18 = (value: number) => BigInt(Math.round(value * 1e6)) * 10n ** 12n;
  expect(circuitBroken(e18(5), e18(5.1))).toBe(true); // 200 bps vs the 50 bps default
  expect(circuitBroken(e18(5), e18(5.1), 300n)).toBe(false);
  // A 30% gap is inside Copper's 40% guard: published directly, no stepping.
  expect(oracleCatchUp(e18(5), e18(3.5), e18(3.5), 1_900n, 4_000n)).toEqual({ twapE18: e18(3.5), spotE18: e18(3.5), stepping: false });
  // A step can never exceed a tighter guard than the configured step size.
  expect(oracleCatchUp(e18(100), e18(200), e18(200), 1_900n, 1_000n)).toEqual({ twapE18: e18(109), spotE18: e18(109), stepping: true });
});

/** Fake chain: official RCAT token state and an empty pool. */
function fakeRpc(paused = false, official: (address: string) => boolean = (address) => address.toLowerCase() === RCAT.toLowerCase()): RpcTransport {
  const word = (value: bigint) => encodeAbiParameters([{ type: "uint256" }], [value]);
  return {
    async call({ data }: { to: Address; data: Hex }) {
      const selector = data.slice(0, 10);
      if (selector === "0xa60bf13d") return word(10n ** 18n); // uiMultiplier()
      if (selector === "0xdc767007") return word(10n ** 18n); // newUIMultiplier()
      if (selector === "0x97a4064f") return word(0n); // effectiveAt()
      if (selector === "0x7706ba52") return word(paused ? 1n : 0n); // oraclePaused()
      throw new Error("execution reverted");
    },
    async getStorageAt(address: Address) {
      return (official(address)
        ? `0x000000000000000000000000${ROBINHOOD_STOCK_TOKEN_BEACON.slice(2)}`
        : `0x${"0".repeat(64)}`) as Hex;
    }
  };
}

const monitorConfig = {
  ROBINHOOD_PRICES_URL: "https://example.test/rhj/prices/", PYTH_HERMES_URL: "https://hermes.example.test", PYTH_API_KEY: undefined,
  REFERENCE_SOURCE_MAX_AGE_SECONDS: 90, REFERENCE_MAX_SOURCE_DISPERSION_BPS: 150, REFERENCE_TWAP_WINDOW_SECONDS: 900,
  REFERENCE_VIRTUAL_DEPTH_USDG: 250_000, REFERENCE_HOLD_MAX_SECONDS: 432_000, REFERENCE_UNCHANGED_QUOTE_SECONDS: 600,
  REFERENCE_MIN_WINDOW_POINTS: 1
};

test("writes Copper snapshots and a full quote matrix that the markets route lists under Copper only", async () => {
  let tick = 0;
  const fetcher = (async (url: string) => {
    const generatedAt = new Date().toISOString();
    if (url.includes("rhj")) {
      // A Robinhood quote counts only once it has been seen changing.
      const bid = (4.49 + (tick++ % 2) * 0.001).toFixed(3);
      return Response.json({ quotes: [{ tokenSymbol: "RCAT", deployments: [{ contractAddress: RCAT, chainId: 4663 }], tokenBid: bid, tokenAsk: "4.51", isTradingHalt: false, generatedAt }] });
    }
    return Response.json({ parsed: [{ id: "bd4cb54e777668772c77d2824b44262580ed6efa000f612405a13b3c515584bb", price: { price: "450200000", conf: "100000", expo: -8, publish_time: Math.floor(Date.now() / 1_000) } }] });
  }) as unknown as typeof fetch;
  const monitor = new ReferencePriceMonitor(db, fakeRpc(false, () => true), monitorConfig, fetcher);
  await monitor.refreshAll();
  await Bun.sleep(5);
  await monitor.refreshAll();
  const snapshot = await db.query<{ spot_price_usdg: string; oracle_tradable: boolean; sources_used: number; frozen_reason: string | null; usdg_balance: string }>(
    `SELECT s.spot_price_usdg::text, s.oracle_tradable, s.sources_used, s.frozen_reason, s.usdg_balance::text FROM public.pool_snapshots s
     JOIN public.markets m ON m.id = s.market_id WHERE m.symbol='RCAT' AND s.source='reference' ORDER BY s.observed_at DESC LIMIT 1`
  );
  expect(Number(snapshot.rows[0]!.spot_price_usdg)).toBeCloseTo(4.501, 3);
  expect(snapshot.rows[0]).toMatchObject({ oracle_tradable: true, sources_used: 2, frozen_reason: null, usdg_balance: "250000000000" });
  const samples = await db.query<{ count: string }>(
    "SELECT count(*) FROM public.quote_samples q JOIN public.markets m ON m.id=q.market_id WHERE m.symbol='RCAT'"
  );
  expect(samples.rows[0]!.count).toBe("20");
  // Markets with only a Robinhood quote stay one-source; those needing two are frozen with a reason.
  const nne = await db.query<{ frozen_reason: string | null }>(
    `SELECT s.frozen_reason FROM public.pool_snapshots s JOIN public.markets m ON m.id=s.market_id WHERE m.symbol='NNE' AND s.source='reference'`
  );
  expect(nne.rowCount).toBe(0); // NNE had no source at all in this fake feed: nothing to hold yet

  const app = express();
  app.use("/v1/markets", createMarketsRouter(db, 120));
  const copper = await request(app).get("/v1/markets").set("x-floatsheets-contract-version", "copper");
  const goldlake = await request(app).get("/v1/markets");
  const copperSymbols = copper.body.markets.map((row: { symbol: string }) => row.symbol);
  expect(copperSymbols).toEqual(["WYFI", "NNE", "RCAT", "TE", "XNDU", "POET", "FLNC", "QUBT", "RUN", "DJT"]);
  expect(copper.body.markets.find((row: { symbol: string }) => row.symbol === "RCAT")).toMatchObject({ price_source: "reference", listing_class: "penny", sources_used: 2 });
  const goldlakeSymbols = goldlake.body.markets.map((row: { symbol: string }) => row.symbol);
  expect(goldlakeSymbols).toContain("NVDA");
  expect(goldlakeSymbols).toContain("QUBT");
  expect(goldlakeSymbols).not.toContain("RCAT");
});

test("holds the last mark frozen when every source goes quiet, and treats an unchanged Robinhood quote as stale", async () => {
  const fixed = { tokenBid: "4.49", tokenAsk: "4.51", generatedAt: "" };
  let live = true;
  const fetcher = (async (url: string) => {
    if (url.includes("rhj")) {
      fixed.tokenBid = fixed.tokenBid === "4.49" ? "4.491" : "4.49";
      return Response.json({ quotes: live ? [{ tokenSymbol: "RCAT", deployments: [{ contractAddress: RCAT, chainId: 4663 }], tokenBid: fixed.tokenBid, tokenAsk: fixed.tokenAsk, isTradingHalt: false, generatedAt: new Date().toISOString() }] : [] });
    }
    return Response.json({ parsed: [] });
  }) as unknown as typeof fetch;
  // Tier 2 behaviour for the test: RCAT opens on one source.
  await db.query("UPDATE public.markets SET min_sources_for_open = 1 WHERE symbol = 'RCAT'");
  try {
    const monitor = new ReferencePriceMonitor(db, fakeRpc(false, () => true), { ...monitorConfig, REFERENCE_UNCHANGED_QUOTE_SECONDS: 60 }, fetcher);
    // 1st poll: quote not yet seen changing; 2nd: live (1st averaging point); 3rd: warmed up.
    for (let i = 0; i < 3; i++) { await monitor.refreshAll(); await Bun.sleep(5); }
    const latest = async () => (await db.query<{ spot_price_usdg: string; oracle_tradable: boolean; oracle_frozen: boolean; frozen_reason: string | null }>(
      `SELECT s.spot_price_usdg::text, s.oracle_tradable, s.oracle_frozen, s.frozen_reason FROM public.pool_snapshots s JOIN public.markets m ON m.id=s.market_id
       WHERE m.symbol='RCAT' AND s.source='reference' ORDER BY s.observed_at DESC LIMIT 1`)).rows[0]!;
    expect(await latest()).toMatchObject({ oracle_tradable: true, oracle_frozen: false });
    live = false;
    await Bun.sleep(5);
    await monitor.refreshAll();
    const held = await latest();
    expect(Number(held.spot_price_usdg)).toBeCloseTo(4.50, 2);
    expect(held).toMatchObject({ oracle_tradable: false, oracle_frozen: true, frozen_reason: "no live price source" });
    const frozenSample = await db.query<{ execution_degradation_bps: number }>(
      `SELECT q.execution_degradation_bps FROM public.quote_samples q JOIN public.markets m ON m.id=q.market_id
       WHERE m.symbol='RCAT' ORDER BY q.observed_at DESC, q.notional_usdg ASC LIMIT 1`);
    expect(frozenSample.rows[0]!.execution_degradation_bps).toBeGreaterThanOrEqual(700);
  } finally {
    await db.query("UPDATE public.markets SET min_sources_for_open = 2 WHERE symbol = 'RCAT'");
  }
});

test("after a restart, a Robinhood quote that never changed stays stale", async () => {
  const fetcher = (async (url: string) => url.includes("rhj")
    ? Response.json({ quotes: [{ tokenSymbol: "RCAT", deployments: [{ contractAddress: RCAT, chainId: 4663 }], tokenBid: "4.40", tokenAsk: "4.42", isTradingHalt: false, generatedAt: new Date().toISOString() }] })
    : Response.json({ parsed: [] })) as unknown as typeof fetch;
  await db.query("UPDATE public.markets SET min_sources_for_open = 1 WHERE symbol = 'RCAT'");
  try {
    const fresh = new ReferencePriceMonitor(db, fakeRpc(false, () => true), monitorConfig, fetcher);
    await fresh.refreshAll();
    const used = await db.query<{ used: boolean }>(
      `SELECT q.used FROM public.reference_quotes q JOIN public.markets m ON m.id=q.market_id WHERE m.symbol='RCAT' ORDER BY q.observed_at DESC LIMIT 1`);
    expect(used.rows[0]!.used).toBe(false);
  } finally {
    await db.query("UPDATE public.markets SET min_sources_for_open = 2 WHERE symbol = 'RCAT'");
  }
});

test("disables reference markets whose token is not a Robinhood beacon proxy", async () => {
  const impostors = await assertOfficialStockTokens(db, fakeRpc());
  // Only RCAT is official in the fake chain; the startup guard would disable the rest.
  expect(impostors).not.toContain("RCAT");
  expect(impostors).toContain("DJT");
});
