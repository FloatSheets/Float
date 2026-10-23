import "dotenv/config";

import { afterEach, beforeEach, expect, test } from "bun:test";
import express from "express";
import request from "supertest";
import { encodeFunctionResult, parseAbi } from "viem";

import { loadConfig } from "../src/config";
import { db } from "../src/db";
import { migrate } from "../src/db/migrate";
import type { RpcTransport } from "../src/chain/rpc";
import { createStatusRouter } from "../src/routes/status";
import { StatusMonitor, type StatusDependencies } from "../src/status/status";

const oracleAbi = parseAbi(["function getPrice(bytes32) view returns (uint256,uint256,uint256,uint256,uint64,uint64,bool)"]);
const NOW = new Date("2027-03-01T15:00:00.000Z");
const minute = (n: number) => new Date(NOW.getTime() + n * 60_000);
const inserted: Date[] = [];

let circuitBroken = false;
let rpcDown = false;
let keeperRun: string | null = NOW.toISOString();
const rpc: RpcTransport = {
  call: async () => {
    if (rpcDown) throw new Error("Robinhood RPC returned HTTP 502");
    return encodeFunctionResult({ abi: oracleAbi, functionName: "getPrice", result: [10n ** 20n, 10n ** 20n, 25n, 0n, 1n, 5n, circuitBroken] });
  }
};

const deps: StatusDependencies = {
  rpc, oracle: "0xe47c7ab6e236e44CB888Ab08CE96f5839887C5Ec",
  marketPollIntervalMs: 15_000, keeperIntervalSeconds: 30, keeperEnabled: true,
  haltFeedEnabled: true, haltPollSeconds: 60,
  corporateActions: { enabled: true, splitCloseOnlyDays: 7, largeDividendBps: 200 }, corporateActionPollSeconds: 3_600,
  keeperStatus: async () => ({ last_run_finished_at: keeperRun, last_error: null })
};

async function freshSamples(at: Date, except: string[] = []): Promise<void> {
  await db.query(
    `INSERT INTO public.pool_snapshots (market_id, observed_at, sqrt_price_x96, liquidity, usdg_balance, twap_price_usdg, spot_price_usdg, spot_twap_deviation_bps, oracle_tradable)
     SELECT id, $1, 1, 1, 1, 100, 100, 0, true FROM public.markets WHERE listed = TRUE AND status <> 'disabled' AND NOT (symbol = ANY($2::text[]))`, [at, except]
  );
  inserted.push(at);
}

beforeEach(async () => {
  await migrate();
  await db.query("TRUNCATE public.status_checks, public.status_incidents, public.exchange_halts, public.exchange_halt_feed, public.corporate_actions, public.corporate_action_feed");
  await db.query("INSERT INTO public.exchange_halt_feed (id, last_success_at) VALUES (true, $1)", [NOW]);
  await db.query("INSERT INTO public.corporate_action_feed (id, last_success_at) VALUES (true, $1)", [NOW]);
  circuitBroken = false;
  rpcDown = false;
  keeperRun = NOW.toISOString();
});

afterEach(async () => {
  // Future-dated samples must never remain as a market's latest price.
  if (inserted.length) await db.query("DELETE FROM public.pool_snapshots WHERE observed_at = ANY($1::timestamptz[])", [inserted]);
  inserted.length = 0;
});

test("reports every component operational when healthy", async () => {
  await freshSamples(NOW);
  const results = await new StatusMonitor(db, deps).check(NOW);
  expect(Object.values(results).every((result) => result.status === "operational")).toBe(true);
}, 60_000);

test("flags stale data, a stopped keeper and circuit-broken marks", async () => {
  await freshSamples(minute(-30));
  circuitBroken = true;
  keeperRun = minute(-10).toISOString();
  const results = await new StatusMonitor(db, deps).check(NOW);
  expect(results.market_data).toMatchObject({ status: "outage" });
  expect(results.oracle.status).toBe("degraded");
  expect(results.oracle.detail).toContain("Circuit breaker holding the last good price");
  expect(results.keeper).toEqual({ status: "outage", detail: "Last keeper run 10 min ago" });
  rpcDown = true;
  expect((await new StatusMonitor(db, deps).check(NOW)).chain).toEqual({ status: "outage", detail: "Robinhood RPC returned HTTP 502" });
}, 60_000);

test("treats a penny market waiting on its quote as a restriction, not a sampler failure", async () => {
  // RUN is reference-priced: its quote has not updated, so it has no recent price yet.
  await freshSamples(NOW, ["RUN"]);
  const monitor = new StatusMonitor(db, deps);
  expect((await monitor.check(NOW)).market_data).toEqual({ status: "operational", detail: null });
  const report = await monitor.report(NOW);
  expect(report.market_events).toContainEqual(expect.objectContaining({ market: "RUN", kind: "awaiting_price" }));

  // With no penny-stock prices at all, the reference feed itself is reported.
  const pennies = await db.query<{ symbol: string }>("SELECT symbol FROM public.markets WHERE price_source = 'reference' AND listed = TRUE AND status <> 'disabled'");
  await db.query("DELETE FROM public.pool_snapshots WHERE observed_at = $1", [NOW]);
  await freshSamples(NOW, pennies.rows.map((row) => row.symbol));
  expect((await monitor.check(NOW)).market_data).toEqual({ status: "degraded", detail: "No live penny-stock prices from the reference quote feeds" });
}, 60_000);

test("opens an incident after two failed checks and resolves it on recovery", async () => {
  await freshSamples(NOW);
  const monitor = new StatusMonitor(db, deps);
  keeperRun = minute(-10).toISOString();

  await monitor.refresh(NOW);
  expect((await db.query("SELECT 1 FROM public.status_incidents")).rowCount).toBe(0); // one failure is not an incident
  keeperRun = minute(-9).toISOString();
  await monitor.refresh(minute(1));
  const open = await db.query<{ title: string; started_at: Date; resolved_at: Date | null }>("SELECT title, started_at, resolved_at FROM public.status_incidents");
  expect(open.rows).toEqual([{ title: "Position keeper outage", started_at: NOW, resolved_at: null }]);

  keeperRun = minute(2).toISOString();
  await freshSamples(minute(2));
  await monitor.refresh(minute(2));
  const resolved = await db.query<{ resolved_at: Date }>("SELECT resolved_at FROM public.status_incidents");
  expect(resolved.rows[0]!.resolved_at).toEqual(minute(2));
}, 60_000);

test("serves the public report and accepts post-mortems from administrators", async () => {
  await freshSamples(NOW);
  const monitor = new StatusMonitor(db, deps);
  await monitor.refresh(NOW);
  await db.query(
    `INSERT INTO public.status_incidents (component, severity, title, detail, started_at, resolved_at)
     VALUES ('halt_feed','degraded','Exchange halt feed degraded','Halt feed not read for 14 min',$1,$2)`, [minute(-90), minute(-60)]
  );
  await db.query(
    "INSERT INTO public.exchange_halts (symbol, halted_at, listing_market, reason_code, active, last_seen_at) VALUES ('QUBT',$1,'NASDAQ','LUDP',true,$1)", [minute(-1)]
  );

  const config = loadConfig({
    ADMIN_EOA_ADDRESS: "0x1111111111111111111111111111111111111111", FLOAT_CLEARING_HOUSE_ADDRESS: "0x2222222222222222222222222222222222222222",
    FLOAT_ORACLE_ADDRESS: "0x3333333333333333333333333333333333333333", FLOAT_VAULT_ADDRESS: "0x4444444444444444444444444444444444444444",
    MASTER_ADMIN_KEY: "test-master-admin-key-012345678901234567890123456789", USDG_ADDRESS: "0x5555555555555555555555555555555555555555",
    FRONTEND_URL: "https://floatsheets.app", LOG_LEVEL: "info", MARKET_POLL_INTERVAL_MS: "15000", NODE_ENV: "test",
    ORACLE_PRICE_MAX_AGE_SECONDS: "120",
    ORACLE_PUBLISHER_ADDRESS: "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720", ORACLE_PUBLISHER_PRIVATE_KEY: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
    ORACLE_SIGNER_ADDRESS: "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720", ORACLE_SIGNER_PRIVATE_KEY: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
    QUOTE_TTL_SECONDS: "15", QUOTE_SIGNER_ADDRESS: "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720", QUOTE_SIGNER_PRIVATE_KEY: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
    RHC_ID: "4663", RHC_RPC_URL: "https://rpc.mainnet.chain.robinhood.com", UNISWAP_TWAP_WINDOW_SECONDS: "300"
  });
  const app = express();
  app.use(express.json());
  app.use("/v1/status", createStatusRouter({ report: () => monitor.report(NOW) }, config, db));

  const report = await request(app).get("/v1/status");
  expect(report.status).toBe(200);
  expect(report.body.overall).toBe("operational");
  expect(report.body.components).toHaveLength(7);
  expect(report.body.components[0]).toMatchObject({ id: "api", status: "operational", uptime_90d: 100, days: [{ day: "2027-03-01", status: "operational" }] });
  expect(report.body.market_events[0]).toMatchObject({ market: "QUBT", kind: "exchange_halt" });
  const incident = report.body.incidents[0];
  expect(incident).toMatchObject({ component_name: "Exchange halt feed", resolved_at: minute(-60).toISOString(), duration_minutes: 30, postmortem: null });

  const denied = await request(app).post(`/v1/status/incidents/${incident.id}/postmortem`).send({ postmortem: "Upstream feed timed out." });
  expect(denied.status).toBe(401);
  const saved = await request(app).post(`/v1/status/incidents/${incident.id}/postmortem`)
    .set("x-master-admin-key", "test-master-admin-key-012345678901234567890123456789")
    .send({ postmortem: "Nasdaq's feed timed out for 30 minutes. Known halts stayed in force; no trades were affected." });
  expect(saved.status).toBe(200);
  expect((await request(app).get("/v1/status")).body.incidents[0].postmortem).toContain("no trades were affected");
}, 60_000);
