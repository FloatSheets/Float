import "dotenv/config";

import { beforeAll, expect, test } from "bun:test";
import express from "express";
import request from "supertest";
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Address, type Hex } from "viem";

import { marketId } from "../src/chain/protocol";
import type { RpcTransport } from "../src/chain/rpc";
import { db } from "../src/db";
import { migrate } from "../src/db/migrate";
import { createSolvencyRouter } from "../src/routes/solvency";
import { SolvencyReader } from "../src/solvency/solvency";

const addresses = {
  usdg: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address,
  vault: "0x24b530f2ef4c76d10003e861182208cea4120c45" as Address,
  clearingHouse: "0xa1329c69e8eda292cda849babb990fbd05198cdb" as Address,
  oracle: "0xe47c7ab6e236e44cb888ab08ce96f5839887c5ec" as Address
};
const abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function insuranceAssets() view returns (uint256)",
  "function totalPayoutOwed() view returns (uint256)",
  "function totalWithdrawalOwed() view returns (uint256)",
  "function pendingDepositAssets() view returns (uint256)",
  "function availableLiquidity() view returns (uint256)",
  "function unrealizedPnlUsdg() view returns (int256)",
  "function totalOpenPositionMarginUsdg() view returns (uint256)",
  "function badDebtUsdg() view returns (uint256)",
  "function activePositionCount() view returns (uint256)",
  "function marketCount() view returns (uint256)",
  "function marketIdAt(uint256) view returns (bytes32)",
  "function marketExposure(bytes32) view returns (uint256,uint256)",
  "function getPrice(bytes32) view returns (uint256,uint256,uint256,uint256,uint64,uint64,bool)"
]);
const usdg = (dollars: number) => BigInt(dollars) * 1_000_000n;
const e18 = (value: number) => BigInt(value) * 10n ** 18n;
const NVDA = marketId("NVDA");
const TSLA = marketId("TSLA");

// A $100,000 vault: $110,000 cash with $5,000 insurance and $5,000 owed to
// withdrawals; NVDA is net long $10,000 and TSLA is balanced.
const values: Record<string, unknown> = {
  totalAssets: usdg(98_000), totalShares: 100_000_000_000n, insuranceAssets: usdg(5_000), totalPayoutOwed: 0n,
  totalWithdrawalOwed: usdg(5_000), pendingDepositAssets: 0n, availableLiquidity: usdg(95_500),
  unrealizedPnlUsdg: usdg(2_000), totalOpenPositionMarginUsdg: usdg(6_000), badDebtUsdg: 0n,
  activePositionCount: 3n, marketCount: 2n
};
const rpc: RpcTransport = {
  call: async ({ to, data }) => {
    const { functionName, args } = decodeFunctionData({ abi, data });
    const result = (() => {
      if (functionName === "balanceOf") return (args![0] as string).toLowerCase() === addresses.vault ? usdg(110_000) : usdg(6_500);
      if (functionName === "marketIdAt") return [NVDA, TSLA][Number(args![0])];
      if (functionName === "marketExposure") return args![0] === NVDA ? [e18(60), e18(10)] : [e18(25), e18(25)];
      if (functionName === "getPrice") return [args![0] === NVDA ? e18(200) : e18(400), 0n, 25n, 0n, 1n, 4n, false];
      return values[functionName];
    })();
    void to;
    return encodeFunctionResult({ abi, functionName, result } as never) as Hex;
  }
};

beforeAll(async () => { await migrate(); });

test("reports vault, trader and risk figures from on-chain reads", async () => {
  const report = await new SolvencyReader(db, rpc, addresses).report();
  expect(report.vault).toMatchObject({
    cash_usdg: "110000.000000", nav_usdg: "98000.000000", insurance_usdg: "5000.000000",
    withdrawals_owed_usdg: "5000.000000", free_cash_usdg: "100000.000000"
  });
  expect(report.traders).toEqual({
    open_positions: 3, margin_owed_usdg: "6000.000000", margin_held_usdg: "6500.000000", margin_fully_backed: true,
    unrealized_pnl_usdg: "2000.000000", bad_debt_usdg: "0.000000"
  });
  // Open interest: NVDA 70 x $200 = $14,000; TSLA 50 x $400 = $20,000.
  expect(report.risk).toMatchObject({
    open_interest_usdg: "34000.000000", utilization_pct: 34.6938, utilization_cap_pct: 50,
    // Stress: NVDA net long $10,000 moving 25% = $2,500; TSLA is balanced.
    stress_loss_usdg: "2500.000000", stress_coverage_ratio: 42, current_trader_profit_coverage_ratio: 52.5
  });
  expect(report.markets[0]).toMatchObject({
    market: "NVDA", price_usdg: "200.000000", long_open_interest_usdg: "12000.000000", short_open_interest_usdg: "2000.000000",
    skew_usdg: "10000.000000", net_side: "long", open_interest_cap_used_pct: 95.2380, skew_cap_used_pct: 102.0408
  });
  expect(report.markets[1]).toMatchObject({ market: "TSLA", net_side: null, skew_usdg: "0.000000" });
}, 60_000);

test("serves the report and hides provider errors", async () => {
  const app = express();
  app.use("/v1/solvency", createSolvencyRouter(new SolvencyReader(db, rpc, addresses)));
  const ok = await request(app).get("/v1/solvency");
  expect(ok.status).toBe(200);
  expect(ok.body.contracts.vault).toBe(addresses.vault);

  const failing = express();
  failing.use("/v1/solvency", createSolvencyRouter({ report: async () => { throw new Error("request to https://rpc.example/secret failed"); } }));
  const error = await request(failing).get("/v1/solvency");
  expect(error.status).toBe(503);
  expect(JSON.stringify(error.body)).not.toContain("secret");
}, 60_000);
