import "dotenv/config";

import { beforeEach, expect, test } from "bun:test";
import express from "express";
import request from "supertest";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { loadConfig } from "../src/config";
import { db } from "../src/db";
import { migrate } from "../src/db/migrate";
import { KEEPER_START_BLOCKS, MAX_POSITION_DURATION_SECONDS, PositionKeeper, type KeeperChain, type TradeLog } from "../src/keeper/keeper";
import { createKeeperRouter } from "../src/routes/keeper";

const key = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const account = privateKeyToAccount(key).address;
const SILVERLAKE = "0xc197d8f546cc56a4148b30a74d3a2c5975255c6a" as Address;
const config = loadConfig({
  ADMIN_EOA_ADDRESS: "0x1111111111111111111111111111111111111111",
  FLOAT_CLEARING_HOUSE_ADDRESS: "0x2222222222222222222222222222222222222222",
  FLOAT_ORACLE_ADDRESS: "0x3333333333333333333333333333333333333333",
  FLOAT_VAULT_ADDRESS: "0x4444444444444444444444444444444444444444",
  AMBER_FLOAT_CLEARING_HOUSE_ADDRESS: "0xa000000000000000000000000000000000000001",
  AMBER_FLOAT_ORACLE_ADDRESS: "0xa000000000000000000000000000000000000002",
  AMBER_FLOAT_VAULT_ADDRESS: "0xa000000000000000000000000000000000000003",
  MASTER_ADMIN_KEY: "test-master-admin-key-012345678901234567890123456789",
  USDG_ADDRESS: "0x5555555555555555555555555555555555555555",
  FRONTEND_URL: "https://floatsheets.app", LOG_LEVEL: "info", MARKET_POLL_INTERVAL_MS: "15000", NODE_ENV: "test",
  ORACLE_PRICE_MAX_AGE_SECONDS: "120", ORACLE_PUBLISHER_ADDRESS: account, ORACLE_PUBLISHER_PRIVATE_KEY: key,
  ORACLE_SIGNER_ADDRESS: account, ORACLE_SIGNER_PRIVATE_KEY: key,
  QUOTE_TTL_SECONDS: "15", QUOTE_SIGNER_ADDRESS: account, QUOTE_SIGNER_PRIVATE_KEY: key,
  RHC_ID: "4663", RHC_RPC_URL: "https://rpc.mainnet.chain.robinhood.com", UNISWAP_TWAP_WINDOW_SECONDS: "1800"
});

const trader = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const market = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const NOW = 1_800_000_000n;
const LATEST = KEEPER_START_BLOCKS.silverlake + 12_000_000n;

type FakePosition = { sizeE18: bigint; openedAt: bigint; liquidatable: boolean; sendFails?: boolean };

function fakeChain(logs: TradeLog[], positions: Map<string, FakePosition>, options: { maxSpan?: bigint } = {}) {
  const calls = { liquidated: [] as string[], logRanges: [] as [bigint, bigint][] };
  const chain: KeeperChain = {
    address: account,
    latestBlock: async () => ({ number: LATEST, timestamp: NOW }),
    tradeLogs: async (clearingHouse, fromBlock, toBlock) => {
      calls.logRanges.push([fromBlock, toBlock]);
      if (options.maxSpan && toBlock - fromBlock + 1n > options.maxSpan) throw new Error("response too large");
      return clearingHouse.toLowerCase() === SILVERLAKE
        ? logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock)
        : [];
    },
    position: async (_house, who, id) => {
      const position = positions.get(`${who}:${id}`);
      return position ? { sizeE18: position.sizeE18, openedAt: position.openedAt } : { sizeE18: 0n, openedAt: 0n };
    },
    simulateLiquidation: async (_house, who, id) => positions.get(`${who}:${id}`)?.liquidatable
      ? { ok: true }
      : { ok: false, reason: "PositionNotLiquidatable" },
    liquidate: async (_house, who, id) => {
      const position = positions.get(`${who}:${id}`);
      if (position?.sendFails) throw new Error("execution reverted");
      calls.liquidated.push(`${who}:${id}`);
      positions.delete(`${who}:${id}`);
      return `0x${"ab".repeat(32)}` as Hex;
    },
    claimableRewards: async () => 1_500_000n
  };
  return { chain, calls };
}

beforeEach(async () => {
  await migrate();
  await db.query("TRUNCATE public.keeper_cursors, public.keeper_positions, public.keeper_actions");
});

test.serial("discovers positions from trade logs and closes only eligible ones", async () => {
  const start = KEEPER_START_BLOCKS.silverlake;
  const logs: TradeLog[] = [
    { trader: trader(1), marketId: market(1), blockNumber: start + 10n },
    { trader: trader(2), marketId: market(1), blockNumber: start + 20n },
    { trader: trader(3), marketId: market(2), blockNumber: start + 6_000_000n },
    { trader: trader(4), marketId: market(2), blockNumber: start + 7_000_000n },
    { trader: trader(5), marketId: market(3), blockNumber: start + 8_000_000n }
  ];
  const positions = new Map<string, FakePosition>([
    // Under maintenance margin.
    [`${trader(1)}:${market(1)}`, { sizeE18: 10n ** 18n, openedAt: NOW - 3_600n, liquidatable: true }],
    // Healthy and inside the duration window.
    [`${trader(2)}:${market(1)}`, { sizeE18: -(10n ** 18n), openedAt: NOW - 3_600n, liquidatable: false }],
    // Past the seven-day duration.
    [`${trader(3)}:${market(2)}`, { sizeE18: 10n ** 18n, openedAt: NOW - MAX_POSITION_DURATION_SECONDS - 1n, liquidatable: true }],
    // Eligible, but the transaction reverts (for example, closed by someone else first).
    [`${trader(5)}:${market(3)}`, { sizeE18: 10n ** 18n, openedAt: NOW - 3_600n, liquidatable: true, sendFails: true }]
    // trader(4) has already closed: no position.
  ]);
  const { chain, calls } = fakeChain(logs, positions);
  const keeper = new PositionKeeper(db, chain, config);

  await keeper.runOnce();

  expect(calls.liquidated.sort()).toEqual([`${trader(1)}:${market(1)}`, `${trader(3)}:${market(2)}`].sort());
  const tracked = await db.query<{ trader: string }>("SELECT trader FROM public.keeper_positions ORDER BY trader");
  expect(tracked.rows.map((row) => row.trader)).toEqual([trader(2), trader(5)]);
  const actions = await db.query<{ trader: string; reason: string; status: string }>(
    "SELECT trader, reason, status FROM public.keeper_actions ORDER BY trader"
  );
  expect(actions.rows).toEqual([
    { trader: trader(1), reason: "liquidation", status: "confirmed" },
    { trader: trader(3), reason: "expiry", status: "confirmed" },
    { trader: trader(5), reason: "liquidation", status: "failed" }
  ]);

  // The next run resumes from the saved cursor instead of rescanning history.
  calls.logRanges.length = 0;
  await keeper.runOnce();
  expect(calls.logRanges.every(([from]) => from > LATEST)).toBe(true);
  // A recent failed send is not retried on every run.
  const failures = await db.query("SELECT 1 FROM public.keeper_actions WHERE status='failed'");
  expect(failures.rowCount).toBe(1);
}, 60_000);

test.serial("halves the log range when the provider rejects a dense span", async () => {
  const start = KEEPER_START_BLOCKS.silverlake;
  const logs: TradeLog[] = [{ trader: trader(9), marketId: market(9), blockNumber: start + 4_000_000n }];
  const positions = new Map<string, FakePosition>([[`${trader(9)}:${market(9)}`, { sizeE18: 1n, openedAt: NOW, liquidatable: false }]]);
  const { chain } = fakeChain(logs, positions, { maxSpan: 1_250_000n });
  const keeper = new PositionKeeper(db, chain, config);

  await keeper.runOnce();

  const tracked = await db.query("SELECT 1 FROM public.keeper_positions WHERE trader=$1", [trader(9)]);
  expect(tracked.rowCount).toBe(1);
  const cursor = await db.query<{ next_block: string }>("SELECT next_block FROM public.keeper_cursors WHERE contract_version='silverlake'");
  expect(BigInt(cursor.rows[0]!.next_block)).toBe(LATEST + 1n);
}, 60_000);

test.serial("serves keeper status for the dashboard", async () => {
  const start = KEEPER_START_BLOCKS.silverlake;
  const logs: TradeLog[] = [{ trader: trader(1), marketId: market(1), blockNumber: start + 1n }];
  const positions = new Map<string, FakePosition>([[`${trader(1)}:${market(1)}`, { sizeE18: 1n, openedAt: NOW, liquidatable: true }]]);
  const { chain } = fakeChain(logs, positions);
  const keeper = new PositionKeeper(db, chain, config);
  await keeper.runOnce();

  const app = express();
  app.use("/v1/keeper", createKeeperRouter(keeper));
  const response = await request(app).get("/v1/keeper");

  expect(response.status).toBe(200);
  expect(response.body.enabled).toBe(true);
  expect(response.body.keeper_address).toBe(account);
  expect(response.body.totals).toEqual({ liquidations: 1, expiries: 0, failed: 0 });
  expect(response.body.claimable_rewards_usdg).toBe("1500000");
  expect(response.body.last_error).toBeNull();
  const silverlake = response.body.deployments.find((row: { contract_version: string }) => row.contract_version === "silverlake");
  expect(silverlake).toEqual({ contract_version: "silverlake", scanned_through_block: LATEST.toString(), tracked_positions: 0 });
  expect(response.body.recent_actions[0].reason).toBe("liquidation");
}, 60_000);
