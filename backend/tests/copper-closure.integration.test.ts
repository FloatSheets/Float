import "dotenv/config";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { RpcTransport } from "../src/chain/rpc";
import { loadConfig } from "../src/config";
import { db } from "../src/db";
import { migrate } from "../src/db/migrate";
import { CopperClosureWatch } from "../src/markets/copper-closure";

const key = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const signer = privateKeyToAccount(key).address;
const OWNER = "0x2241d50bfe090beb20a2521bdaf351c42446d73c";
const config = loadConfig({
  ADMIN_EOA_ADDRESS: "0x1111111111111111111111111111111111111111", FLOAT_CLEARING_HOUSE_ADDRESS: "0x2222222222222222222222222222222222222222",
  FLOAT_ORACLE_ADDRESS: "0x3333333333333333333333333333333333333333", FLOAT_VAULT_ADDRESS: "0x4444444444444444444444444444444444444444",
  COPPER_FLOAT_CLEARING_HOUSE_ADDRESS: "0xD81E638b19E2e4Fff0C88958F9e0b6d0969AcFfE", COPPER_FLOAT_ORACLE_ADDRESS: "0x4533F3a3bFF4DF0060810186182520A903A5d656",
  COPPER_FLOAT_VAULT_ADDRESS: "0x920F5eEc51E0361615Fc0B861A1Fe0C1F4cf62f0",
  MASTER_ADMIN_KEY: "test-master-admin-key-012345678901234567890123456789", USDG_ADDRESS: "0x5555555555555555555555555555555555555555",
  FRONTEND_URL: "https://floatsheets.app", LOG_LEVEL: "info", MARKET_POLL_INTERVAL_MS: "15000", NODE_ENV: "test",
  ORACLE_PRICE_MAX_AGE_SECONDS: "120", ORACLE_PUBLISHER_ADDRESS: signer, ORACLE_PUBLISHER_PRIVATE_KEY: key,
  ORACLE_SIGNER_ADDRESS: signer, ORACLE_SIGNER_PRIVATE_KEY: key, QUOTE_TTL_SECONDS: "15", QUOTE_SIGNER_ADDRESS: signer, QUOTE_SIGNER_PRIVATE_KEY: key,
  RHC_ID: "4663", RHC_RPC_URL: "https://rpc.mainnet.chain.robinhood.com", UNISWAP_TWAP_WINDOW_SECONDS: "300",
  TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_BOT_USERNAME: "floatsheets_test_bot"
});

const abi = parseAbi([
  "function markets(bytes32) view returns (uint8,uint64,uint64,uint64,uint64,uint128)",
  "function owner() view returns (address)"
]);
let leverage = 5n;
const rpc: RpcTransport = {
  call: async ({ data }) => {
    const { functionName } = decodeFunctionData({ abi, data });
    const result = functionName === "owner" ? OWNER : [1, leverage * 10n ** 18n, 500n, 750n, 50n, 40_000_000n];
    return encodeFunctionResult({ abi, functionName, result } as never) as Hex;
  }
};

// Friday 23 October 2026 (EDT): the closure starts at 20:00 ET, the profile is due 6h earlier.
const WEDNESDAY = new Date("2026-10-21T16:00:00.000Z");
const FRIDAY_15_ET = new Date("2026-10-23T19:00:00.000Z");
const SATURDAY = new Date("2026-10-24T15:00:00.000Z");
const MONDAY_10_ET = new Date("2026-10-26T14:00:00.000Z");
const realFetch = globalThis.fetch;
const sent: { chat_id: string; text: string }[] = [];

beforeEach(async () => {
  await migrate();
  await db.query("TRUNCATE public.copper_closure_reminders");
  await db.query("DELETE FROM public.liquidation_telegram_links WHERE wallet_address=$1", [OWNER]);
  await db.query("INSERT INTO public.liquidation_telegram_links (wallet_address, telegram_chat_id) VALUES ($1, 'owner-chat')", [OWNER]);
  leverage = 5n;
  sent.length = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, result: {} });
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await db.query("DELETE FROM public.liquidation_telegram_links WHERE wallet_address=$1", [OWNER]);
});

test("asks for the closure profile before a weekend and flags it if missed", async () => {
  const watch = new CopperClosureWatch(db, rpc, config);
  const midweek = (await watch.state(WEDNESDAY))!;
  expect(midweek).toMatchObject({ phase: "open", action: null, profile_due_at: "2026-10-23T18:00:00.000Z", closes_at: "2026-10-24T00:00:00.000Z" });

  const due = (await watch.state(FRIDAY_15_ET))!;
  expect(due).toMatchObject({ phase: "closure_due", action: "apply_closure", command: "contracts/script/copper-profile.sh closure" });
  expect(due.summary).toContain("before Fri 8:00 PM ET");

  const missed = (await watch.state(SATURDAY))!;
  expect(missed).toMatchObject({ phase: "closed", action: "apply_closure" });
  expect(missed.summary).toContain("was not applied");

  // Applied: nothing to do during the closure.
  leverage = 3n;
  expect((await watch.state(SATURDAY))!.action).toBeNull();
}, 60_000);

test("asks to restore the launch profile after the reopen", async () => {
  leverage = 3n;
  const watch = new CopperClosureWatch(db, rpc, config);
  expect((await watch.state(MONDAY_10_ET))!).toMatchObject({ phase: "open", action: "restore_launch", command: "contracts/script/copper-profile.sh launch" });
  leverage = 5n;
  expect((await watch.state(MONDAY_10_ET))!.action).toBeNull();
}, 60_000);

test("reminds the owner's linked Telegram once per window", async () => {
  const watch = new CopperClosureWatch(db, rpc, config);
  await watch.remind(FRIDAY_15_ET);
  await watch.remind(FRIDAY_15_ET);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.chat_id).toBe("owner-chat");
  expect(sent[0]!.text).toContain("contracts/script/copper-profile.sh closure");

  // No reminder when nothing is due.
  await watch.remind(WEDNESDAY);
  expect(sent).toHaveLength(1);
}, 60_000);
