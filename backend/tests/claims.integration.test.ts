import "dotenv/config";

import { beforeAll, expect, test } from "bun:test";
import express from "express";
import request from "supertest";
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { marketId } from "../src/chain/protocol";
import type { RpcTransport } from "../src/chain/rpc";
import { ClaimCenter } from "../src/claims/claims";
import { loadConfig } from "../src/config";
import { db } from "../src/db";
import { migrate } from "../src/db/migrate";
import { createClaimsRouter } from "../src/routes/claims";

const key = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const signer = privateKeyToAccount(key).address;
const GOLD_HOUSE = "0x9999999999999999999999999999999999999999";
const GOLD_VAULT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const AMBER_HOUSE = "0x6666666666666666666666666666666666666666";
const AMBER_VAULT = "0x8888888888888888888888888888888888888888";
const config = loadConfig({
  ADMIN_EOA_ADDRESS: "0x1111111111111111111111111111111111111111",
  FLOAT_CLEARING_HOUSE_ADDRESS: "0x2222222222222222222222222222222222222222",
  FLOAT_ORACLE_ADDRESS: "0x3333333333333333333333333333333333333333",
  FLOAT_VAULT_ADDRESS: "0x4444444444444444444444444444444444444444",
  GOLDLAKE_FLOAT_CLEARING_HOUSE_ADDRESS: GOLD_HOUSE, GOLDLAKE_FLOAT_ORACLE_ADDRESS: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", GOLDLAKE_FLOAT_VAULT_ADDRESS: GOLD_VAULT,
  AMBER_FLOAT_CLEARING_HOUSE_ADDRESS: AMBER_HOUSE, AMBER_FLOAT_ORACLE_ADDRESS: "0x7777777777777777777777777777777777777777", AMBER_FLOAT_VAULT_ADDRESS: AMBER_VAULT,
  MASTER_ADMIN_KEY: "test-master-admin-key-012345678901234567890123456789", USDG_ADDRESS: "0x5555555555555555555555555555555555555555",
  FRONTEND_URL: "https://floatsheets.app", LOG_LEVEL: "info", MARKET_POLL_INTERVAL_MS: "15000", NODE_ENV: "test",
  ORACLE_PRICE_MAX_AGE_SECONDS: "120", ORACLE_PUBLISHER_ADDRESS: signer, ORACLE_PUBLISHER_PRIVATE_KEY: key,
  ORACLE_SIGNER_ADDRESS: signer, ORACLE_SIGNER_PRIVATE_KEY: key, QUOTE_TTL_SECONDS: "15", QUOTE_SIGNER_ADDRESS: signer, QUOTE_SIGNER_PRIVATE_KEY: key,
  RHC_ID: "4663", RHC_RPC_URL: "https://rpc.mainnet.chain.robinhood.com", UNISWAP_TWAP_WINDOW_SECONDS: "300"
});

const abi = parseAbi([
  "function claimableBalance(address) view returns (uint256)", "function deferredClaim(address) view returns (uint256)",
  "function pendingPayout(address) view returns (uint256)", "function getPosition(address,bytes32) view returns (int256,uint256,uint256,uint64)",
  "function totalAssets() view returns (uint256)", "function totalShares() view returns (uint256)", "function balanceOf(address) view returns (uint256)",
  "function lockedWithdrawalShares(address) view returns (uint256)", "function queueEpoch() view returns (uint64)",
  "function queueEpochStartedAt() view returns (uint64)", "function queueEpochSettled() view returns (bool)", "function QUEUE_EPOCH_DURATION() view returns (uint256)",
  "function queuedDepositOf(uint64,address) view returns (uint256)", "function queuedWithdrawalOf(uint64,address) view returns (uint256)",
  "function depositClaimed(uint64,address) view returns (bool)", "function withdrawalClaimed(uint64,address) view returns (bool)",
  "function queueSettlements(uint64) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)"
]);
const WALLET = "0x00000000000000000000000000000000000000c1" as Address;
const NOW = new Date("2026-11-10T12:00:00.000Z");
const usdg = (dollars: number) => BigInt(dollars) * 1_000_000n;

// Goldlake (current): a $40 balance to claim and an LP deposit waiting on epoch 3's settlement.
// Amber (retired): $250 deferred, idle NVDA margin, an open TSLA position, a settled
// withdrawal in epoch 1, and 1,000,000,000 free LP shares.
function answer(to: string, functionName: string, args: readonly unknown[]): unknown {
  const gold = to === GOLD_HOUSE || to === GOLD_VAULT;
  switch (functionName) {
    case "claimableBalance": return gold ? usdg(40) : 0n;
    case "deferredClaim": return gold ? 0n : usdg(250);
    case "pendingPayout": return gold ? 0n : usdg(75);
    case "getPosition": {
      if (gold) return [0n, 0n, 0n, 0n];
      if (args[1] === marketId("NVDA")) return [0n, 0n, usdg(120), 0n];
      if (args[1] === marketId("TSLA")) return [10n ** 18n, 4n * 10n ** 20n, usdg(80), 1n];
      return [0n, 0n, 0n, 0n];
    }
    case "totalAssets": return gold ? usdg(1_000) : usdg(5_000);
    case "totalShares": return gold ? 0n : 5_000_000_000n;
    case "balanceOf": return gold ? 0n : 1_500_000_000n;
    case "lockedWithdrawalShares": return gold ? 0n : 500_000_000n;
    case "queueEpoch": return gold ? 3n : 2n;
    case "queueEpochStartedAt": return BigInt(Math.floor(NOW.getTime() / 1_000)) - 90_000n;
    case "queueEpochSettled": return false;
    case "QUEUE_EPOCH_DURATION": return 86_400n;
    case "queuedDepositOf": return gold && args[0] === 3n ? usdg(101) : 0n;
    case "queuedWithdrawalOf": return !gold && args[0] === 1n ? 500_000_000n : 0n;
    case "depositClaimed": case "withdrawalClaimed": return false;
    case "queueSettlements": return !gold && args[0] === 1n
      ? [usdg(5_000), 5_000_000_000n, 0n, 0n, 0n, 0n, 0n, 0n, true]
      : [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, false];
    default: throw new Error(`unexpected ${functionName}`);
  }
}

const rpc: RpcTransport = {
  call: async ({ to, data }) => {
    const target = to.toLowerCase();
    if (![GOLD_HOUSE, GOLD_VAULT, AMBER_HOUSE, AMBER_VAULT].includes(target)) throw new Error("execution reverted");
    const { functionName, args } = decodeFunctionData({ abi, data });
    return encodeFunctionResult({ abi, functionName, result: answer(target, functionName, args ?? []) } as never) as Hex;
  }
};

beforeAll(async () => { await migrate(); });

test("collects every claim across current and retired deployments", async () => {
  const report = await new ClaimCenter(db, rpc, config).forAccount(WALLET, NOW);
  expect(report.deployments.map((item) => item.version)).toEqual(["goldlake", "amber"]);

  const gold = report.deployments[0]!;
  expect(gold.items.map((item) => [item.kind, item.amount_usdg])).toEqual([
    ["claim_balance", "40.000000"],
    ["settle_epoch", null]
  ]);
  expect(gold.items[0]!.transaction).toMatchObject({ to: GOLD_HOUSE, chainId: 4663, activity: "claim" });

  const amber = report.deployments[1]!;
  expect(amber.pending_payout_usdg).toBe("75.000000");
  expect(amber.items.map((item) => [item.kind, item.market, item.amount_usdg])).toEqual([
    ["claim_deferred", null, "250.000000"],
    ["withdraw_margin", "NVDA", "120.000000"],
    ["close_position", "TSLA", "80.000000"],
    // Share values include the vault's 1e6 virtual shares: 500e6 x (5,000e6 + 1) / (5,000e6 + 1e6).
    ["claim_lp_withdrawal", null, "499.900020"],
    ["queue_lp_withdrawal", null, "999.800040"]
  ]);
  // Closing needs a fresh signed quote, so no calldata is prepared for it.
  expect(amber.items.find((item) => item.kind === "close_position")!.transaction).toBeNull();
  expect(amber.items.find((item) => item.kind === "withdraw_margin")!.transaction).toMatchObject({ to: AMBER_HOUSE, market: "NVDA" });

  // Balances, deferred payouts, idle margin and settled withdrawals are claimable now.
  expect(report.claimable_now_usdg).toBe("909.900020");
  expect(report.action_count).toBe(7);
}, 60_000);

test("serves claims per wallet and rejects invalid addresses", async () => {
  const app = express();
  app.use("/v1/claims", createClaimsRouter({ forAccount: (account) => new ClaimCenter(db, rpc, config).forAccount(account, NOW) }));
  const ok = await request(app).get(`/v1/claims/${WALLET}`);
  expect(ok.status).toBe(200);
  expect(ok.body.claimable_now_usdg).toBe("909.900020");
  expect((await request(app).get("/v1/claims/not-a-wallet")).status).toBe(400);
}, 60_000);
