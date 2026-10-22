import express from "express";
import { afterAll, expect, test } from "bun:test";
import request from "supertest";
import type { Server } from "node:http";
import { encodeFunctionData, encodeFunctionResult, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Pool } from "pg";

import { loadConfig } from "../src/config";
import { createProtocolRouter } from "../src/routes/protocol";
import { createProtocolTransactionsRouter } from "../src/routes/protocol-transactions";
import type { RpcTransport } from "../src/chain/rpc";
import { marketId } from "../src/chain/protocol";

const signerKey = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const signer = privateKeyToAccount(signerKey).address;
const config = loadConfig({
  ADMIN_EOA_ADDRESS: "0x1111111111111111111111111111111111111111",
  FLOAT_CLEARING_HOUSE_ADDRESS: "0x2222222222222222222222222222222222222222",
  FLOAT_ORACLE_ADDRESS: "0x3333333333333333333333333333333333333333",
  FLOAT_VAULT_ADDRESS: "0x4444444444444444444444444444444444444444",
  MEADOW_FLOAT_CLEARING_HOUSE_ADDRESS: "0x2222222222222222222222222222222222222222",
  MEADOW_FLOAT_ORACLE_ADDRESS: "0x3333333333333333333333333333333333333333",
  MEADOW_FLOAT_VAULT_ADDRESS: "0x4444444444444444444444444444444444444444",
  JASPER_FLOAT_CLEARING_HOUSE_ADDRESS: "0x6666666666666666666666666666666666666666",
  JASPER_FLOAT_ORACLE_ADDRESS: "0x7777777777777777777777777777777777777777",
  JASPER_FLOAT_VAULT_ADDRESS: "0x8888888888888888888888888888888888888888",
  AMBER_FLOAT_CLEARING_HOUSE_ADDRESS: "0x6666666666666666666666666666666666666666",
  AMBER_FLOAT_ORACLE_ADDRESS: "0x7777777777777777777777777777777777777777",
  AMBER_FLOAT_VAULT_ADDRESS: "0x8888888888888888888888888888888888888888",
  GOLDLAKE_FLOAT_CLEARING_HOUSE_ADDRESS: "0x9999999999999999999999999999999999999999",
  GOLDLAKE_FLOAT_ORACLE_ADDRESS: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  GOLDLAKE_FLOAT_VAULT_ADDRESS: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  LEGACY_ORION_FLOAT_CLEARING_HOUSE_ADDRESS: "0x2222222222222222222222222222222222222222",
  LEGACY_ORION_FLOAT_ORACLE_ADDRESS: "0x3333333333333333333333333333333333333333",
  LEGACY_ORION_FLOAT_VAULT_ADDRESS: "0x4444444444444444444444444444444444444444",
  MASTER_ADMIN_KEY: "test-master-admin-key-012345678901234567890123456789",
  USDG_ADDRESS: "0x5555555555555555555555555555555555555555",
  FRONTEND_URL: "https://floatsheets.app",
  LOG_LEVEL: "info",
  MARKET_POLL_INTERVAL_MS: "15000",
  NODE_ENV: "test",
  ORACLE_PRICE_MAX_AGE_SECONDS: "120",
  ORACLE_PUBLISHER_ADDRESS: signer,
  ORACLE_PUBLISHER_PRIVATE_KEY: signerKey,
  ORACLE_PUBLISH_INTERVAL_SECONDS: "90",
  ORACLE_SIGNER_ADDRESS: signer,
  ORACLE_SIGNER_PRIVATE_KEY: signerKey,
  QUOTE_TTL_SECONDS: "15",
  QUOTE_SIGNER_ADDRESS: signer,
  QUOTE_SIGNER_PRIVATE_KEY: signerKey,
  RHC_ID: "4663",
  RHC_RPC_URL: "https://rpc.mainnet.chain.robinhood.com",
  UNISWAP_TWAP_WINDOW_SECONDS: "300",
  // Weekend bands depend on the wall clock; their behavior is covered in weekend-bands tests.
  WEEKEND_BANDS_ENABLED: "false",
  WEEKEND_WALLET_LIMITS_ENABLED: "false"
});

const app = express();
app.use(express.json());
app.use("/v1/protocol", createProtocolRouter(config));
app.use("/v1/protocol/transactions", createProtocolTransactionsRouter(config));

async function listening(app: express.Express): Promise<Server> {
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return server;
}

// Bun 1.4 does not make a newly-created Node HTTP server address available
// synchronously. Start it explicitly instead of relying on Supertest's lazy
// listener, which makes these integration-style route tests portable to CI.
const server = await listening(app);
afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

test("publishes Goldlake addresses by default and supports retired and legacy selections", async () => {
  const response = await request(server).get("/v1/protocol");
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    chain_id: 4663,
    settlement_asset: "USDG",
    settlement_asset_address: config.USDG_ADDRESS,
    contract_version: "goldlake",
    contract_name: "FloatSheets Goldlake",
    oracle: config.GOLDLAKE_FLOAT_ORACLE_ADDRESS,
    vault: config.GOLDLAKE_FLOAT_VAULT_ADDRESS,
    clearing_house: config.GOLDLAKE_FLOAT_CLEARING_HOUSE_ADDRESS,
    oracle_signer: config.ORACLE_SIGNER_ADDRESS,
    quote_signer: config.QUOTE_SIGNER_ADDRESS,
    max_position_duration_seconds: 604800,
    lp_actions_locked_while_positions_open: false,
    lp_actions_queued_by_epoch: true
  });
  const meadow = await request(server).get("/v1/protocol").set("x-floatsheets-contract-version", "meadow");
  expect(meadow.body.contract_name).toBe("FloatSheets Meadow");
  expect(meadow.body.vault).toBe(config.MEADOW_FLOAT_VAULT_ADDRESS);
  const legacy = await request(server).get("/v1/protocol").set("x-floatsheets-contract-version", "legacy-orion");
  expect(legacy.body.contract_version).toBe("legacy-orion");
  expect(legacy.body.oracle).toBe(config.LEGACY_ORION_FLOAT_ORACLE_ADDRESS);
  expect(legacy.body.vault).toBe(config.LEGACY_ORION_FLOAT_VAULT_ADDRESS);
  expect(legacy.body.clearing_house).toBe(config.LEGACY_ORION_FLOAT_CLEARING_HOUSE_ADDRESS);
  expect(legacy.body.max_position_duration_seconds).toBeNull();
  expect(legacy.body.lp_actions_locked_while_positions_open).toBe(false);
});

test("builds a real USDG approval transaction", async () => {
  const response = await request(server).post("/v1/protocol/transactions/approve").send({ amountUsdg: "1000000" });
  expect(response.status).toBe(200);
  expect(response.body.transaction.to).toBe(config.USDG_ADDRESS);
  expect(response.body.transaction.chainId).toBe(4663);
  expect(response.body.transaction.data).toMatch(/^0x095ea7b3/);

  const vaultApproval = await request(server).post("/v1/protocol/transactions/vault-approve").send({ amountUsdg: "1000000" });
  expect(vaultApproval.status).toBe(200);
  expect(vaultApproval.body.transaction.to).toBe(config.USDG_ADDRESS);
  expect(vaultApproval.body.transaction.data).toMatch(/^0x095ea7b3/);

  const vaultDeposit = await request(server).post("/v1/protocol/transactions/vault-deposit").send({
    amountUsdg: "1000000", receiver: "0x1111111111111111111111111111111111111111"
  });
  expect(vaultDeposit.status).toBe(200);
  expect(vaultDeposit.body.transaction.to).toBe(config.GOLDLAKE_FLOAT_VAULT_ADDRESS);
  expect(vaultDeposit.body.transaction.data).toMatch(/^0x6e553f65/);

  const vaultWithdraw = await request(server).post("/v1/protocol/transactions/vault-withdraw").send({
    shares: "1000000000000", receiver: "0x1111111111111111111111111111111111111111"
  });
  expect(vaultWithdraw.status).toBe(200);
  expect(vaultWithdraw.body.transaction.to).toBe(config.GOLDLAKE_FLOAT_VAULT_ADDRESS);
  expect(vaultWithdraw.body.transaction.data).toMatch(/^0x00f714ce/);

  const settleQueue = await request(server).post("/v1/protocol/transactions/vault-settle-queue").send({});
  expect(settleQueue.status).toBe(200);
  expect(settleQueue.body.transaction.to).toBe(config.GOLDLAKE_FLOAT_VAULT_ADDRESS);
  const claimDeposit = await request(server).post("/v1/protocol/transactions/vault-claim-deposit").send({ epoch: "3" });
  expect(claimDeposit.status).toBe(200);
  expect(claimDeposit.body.transaction.to).toBe(config.GOLDLAKE_FLOAT_VAULT_ADDRESS);
  const claimWithdrawal = await request(server).post("/v1/protocol/transactions/vault-claim-withdrawal").send({
    epoch: "3", receiver: "0x1111111111111111111111111111111111111111"
  });
  expect(claimWithdrawal.status).toBe(200);
  expect(claimWithdrawal.body.transaction.to).toBe(config.GOLDLAKE_FLOAT_VAULT_ADDRESS);
  const cancelWithdrawal = await request(server).post("/v1/protocol/transactions/vault-cancel-withdrawal").send({ epoch: "3" });
  expect(cancelWithdrawal.status).toBe(200);
  expect(cancelWithdrawal.body.transaction.to).toBe(config.GOLDLAKE_FLOAT_VAULT_ADDRESS);
  expect(cancelWithdrawal.body.transaction.data).toMatch(/^0x20cbeedf/);

  const claim = await request(server).post("/v1/protocol/transactions/claim").send({ receiver: "0x1111111111111111111111111111111111111111" });
  expect(claim.status).toBe(200);
  expect(claim.body.transaction.data.length).toBeGreaterThan(10);
  const deferred = await request(server).post("/v1/protocol/transactions/claim-deferred").send({ receiver: "0x1111111111111111111111111111111111111111" });
  expect(deferred.status).toBe(200);
  expect(deferred.body.transaction.data.length).toBeGreaterThan(10);
});

test("blocks new position issuance for every non-Goldlake version", async () => {
  for (const version of ["silverlake", "amber", "jasper", "meadow", "legacy-orion"] as const) {
    const response = await request(server)
      .post("/v1/protocol/transactions/trade-quote")
      .set("x-floatsheets-contract-version", version)
      .send({ market: "NVDA", trader: "0x1111111111111111111111111111111111111111", isLong: true, notionalUsdg: "1000000" });
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("Goldlake");
  }
});

test("blocks all new deposits outside Goldlake while preserving legacy withdrawals", async () => {
  for (const version of ["silverlake", "amber", "jasper", "meadow", "legacy-orion"] as const) {
    for (const path of ["approve", "deposit", "vault-approve", "vault-deposit"]) {
      const body = path === "approve" || path === "vault-approve"
        ? { amountUsdg: "1000000" }
        : path === "deposit"
          ? { market: "NVDA", amountUsdg: "1000000" }
          : { amountUsdg: "1000000", receiver: "0x1111111111111111111111111111111111111111" };
      const response = await request(server).post(`/v1/protocol/transactions/${path}`)
        .set("x-floatsheets-contract-version", version)
        .send(body);
      expect(response.status).toBe(409);
      expect(response.body.error).toContain("deposits are disabled");
    }
  }

  const response = await request(server).post("/v1/protocol/transactions/vault-withdraw")
    .set("x-floatsheets-contract-version", "legacy-orion")
    .send({ shares: "1000000000000", receiver: "0x1111111111111111111111111111111111111111" });
  expect(response.status).toBe(200);
  expect(response.body.transaction.to).toBe(config.LEGACY_ORION_FLOAT_VAULT_ADDRESS);
});

test("rejects signer issuance without the master admin key", async () => {
  const response = await request(server).post("/v1/protocol/transactions/quote").send({
    market: "HIMS", marketId: "0x" + "11".repeat(32), trader: "0x1111111111111111111111111111111111111111",
    sizeDeltaE18: "1000000000000000000", executionPriceE18: "1000000000000000000", feeUsdg: "0", maxLeverageE18: "5000000000000000000",
    oracleSequence: "1", nonce: "1", expiry: "2000000000"
  });
  expect(response.status).toBe(401);
});

test("rejects oracle signing without live snapshot validation dependencies", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const response = await request(server).post("/v1/protocol/transactions/oracle-attestation")
    .set("x-master-admin-key", config.MASTER_ADMIN_KEY)
    .send({ marketId: "0x" + "11".repeat(32), priceE18: "1000000000000000000", spotPriceE18: "1000000000000000000", confidenceBps: "50", timestamp: String(now), sequence: "1", expiry: String(now + 60) });
  expect(response.status).toBe(400);
  expect(response.body.error).toContain("validation dependencies");
});

test("refuses admin oracle attestations that differ from the latest pool snapshot", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const database = {
    query: async (sql: string) => sql.includes("INSERT INTO public.api_rate_limits")
      ? { rows: [{ hits: 1 }], rowCount: 1 }
      : { rows: [{ symbol: "NVDA", status: "active", observed_at: new Date(), twap_price_usdg: "101", spot_price_usdg: "101", oracle_tradable: true }], rowCount: 1 }
  } as unknown as Pool;
  const routerApp = express();
  routerApp.use(express.json());
  routerApp.use("/v1/protocol/transactions", createProtocolTransactionsRouter(config, database, { call: async () => { throw new Error("unexpected oracle read"); } }));
  const routerServer = await listening(routerApp);
  try {
    const response = await request(routerServer).post("/v1/protocol/transactions/oracle-attestation")
      .set("x-master-admin-key", config.MASTER_ADMIN_KEY)
      .send({ marketId: marketId("NVDA"), priceE18: "100000000000000000000", spotPriceE18: "100000000000000000000", confidenceBps: "50", timestamp: String(now), sequence: "1", expiry: String(now + 60) });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("latest tradable market snapshot");
  } finally {
    await new Promise<void>((resolve, reject) => routerServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("bounds and database-rate-limits admin market configuration", async () => {
  let hits = 0;
  const database = { query: async () => ({ rows: [{ hits: ++hits }], rowCount: 1 }) } as unknown as Pool;
  const limitedApp = express();
  limitedApp.use(express.json());
  limitedApp.use("/v1/protocol/transactions", createProtocolTransactionsRouter(config, database));
  const limitedServer = await listening(limitedApp);
  try {
    const send = () => request(limitedServer).post("/v1/protocol/transactions/admin/configure-market")
      .set("x-master-admin-key", config.MASTER_ADMIN_KEY)
      .send({ market: "NVDA", state: 1, maxLeverageE18: "5000000000000000000", maintenanceMarginBps: "1000", maxExecutionDeviationBps: "751", maxOracleConfidenceBps: "50", maxPositionNotionalUsdg: "100000000" });
    for (let i = 0; i < 10; i++) expect((await send()).status).toBe(400);
    expect((await send()).status).toBe(429);
  } finally {
    await new Promise<void>((resolve, reject) => limitedServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("builds a trader quote and execution transaction without exposing the quote signer", async () => {
  const clearingAbi = parseAbi([
    "function markets(bytes32) view returns (uint8,uint64,uint64,uint64,uint64,uint128)",
    "function getPosition(address,bytes32) view returns (int256,uint256,uint256,uint64)",
    "function badDebtUsdg() view returns (uint256)"
  ]);
  const oracleAbi = parseAbi(["function getPrice(bytes32) view returns (uint256,uint256,uint256,uint256,uint64,uint64,bool)"]);
  const database = {
    query: async (sql: string, args?: unknown[]) => {
      if (sql.includes("FROM public.markets")) return { rows: [{ id: "market-1", status: "active", max_ticket_usdg: "50000", max_half_spread_bps: 100, observed_at: new Date(), oracle_tradable: true }] };
      if (sql.includes("SELECT notional_usdg")) {
        expect(args?.[2]).toBe("1000.000000");
        return { rows: [{ notional_usdg: "1000", execution_degradation_bps: 25 }] };
      }
      if (sql.includes("FROM public.exchange_halts")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    }
  } as unknown as Pool;
  let circuitBroken = false;
  const rpc: RpcTransport = {
    call: async ({ to, data }) => {
      if (to.toLowerCase() !== config.GOLDLAKE_FLOAT_CLEARING_HOUSE_ADDRESS!.toLowerCase()) {
        return encodeFunctionResult({ abi: oracleAbi, functionName: "getPrice", result: [100_000000000000000000n, 100_000000000000000000n, 25n, 0n, BigInt(Math.floor(Date.now() / 1000)), 9n, circuitBroken] });
      }
      const positionSelector = "0x" + encodeFunctionData({
        abi: clearingAbi, functionName: "getPosition",
        args: ["0x1111111111111111111111111111111111111111", (`0x${"00".repeat(32)}`) as `0x${string}`]
      }).slice(2, 10);
      const badDebtSelector = encodeFunctionData({ abi: clearingAbi, functionName: "badDebtUsdg" }).slice(0, 10);
      if (data.startsWith(badDebtSelector)) return encodeFunctionResult({ abi: clearingAbi, functionName: "badDebtUsdg", result: 0n });
      return data.startsWith(positionSelector)
        ? encodeFunctionResult({ abi: clearingAbi, functionName: "getPosition", result: [10_000000000000000000n, 100_000000000000000000n, 5_000_000000n, 1_800_000_000n] })
        : encodeFunctionResult({ abi: clearingAbi, functionName: "markets", result: [1, 5_000000000000000000n, 1_000n, 100n, 50n, 50_000_000000n] });
    }
  };
  const refreshedMarkets: string[] = [];
  const oraclePublisher = { ensureFreshMarket: async (symbol: string, version?: string) => { refreshedMarkets.push(`${version}:${symbol}`); } };
  const quoteApp = express();
  quoteApp.use(express.json());
  quoteApp.use("/v1/protocol/transactions", createProtocolTransactionsRouter(config, database, rpc, oraclePublisher));
  const quoteServer = await listening(quoteApp);
  try {
    const response = await request(quoteServer).post("/v1/protocol/transactions/trade-quote").send({
      market: "HIMS", trader: "0x1111111111111111111111111111111111111111", isLong: true, notionalUsdg: "1000000000"
    });

    expect(response.status).toBe(200);
    expect(response.body.quote.trader).toBe("0x1111111111111111111111111111111111111111");
    expect(response.body.quote.executionPriceE18).toBe("100250000000000000000");
    expect(BigInt(response.body.quote.sizeDeltaE18)).toBeGreaterThan(0n);
    expect(response.body.quote.feeUsdg).toBe("600000");
    expect(BigInt(response.body.quote.expiry) - BigInt(Math.floor(Date.now() / 1_000))).toBeLessThanOrEqual(15n);
    expect(response.body.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(response.body.transaction.to).toBe(config.GOLDLAKE_FLOAT_CLEARING_HOUSE_ADDRESS);
    expect(refreshedMarkets).toEqual(["goldlake:HIMS"]);

    const closeResponse = await request(quoteServer).post("/v1/protocol/transactions/close-quote").send({
      market: "HIMS", trader: "0x1111111111111111111111111111111111111111"
    });
    expect(closeResponse.status).toBe(200);
    expect(closeResponse.body.quote.sizeDeltaE18).toBe("-10000000000000000000");
    expect(closeResponse.body.transaction.to).toBe(config.GOLDLAKE_FLOAT_CLEARING_HOUSE_ADDRESS);
    expect(refreshedMarkets).toEqual(["goldlake:HIMS", "goldlake:HIMS"]);
    circuitBroken = true;
    const breakerClose = await request(quoteServer).post("/v1/protocol/transactions/close-quote").send({
      market: "HIMS", trader: "0x1111111111111111111111111111111111111111"
    });
    expect(breakerClose.status).toBe(200);
    expect(breakerClose.body.quote.executionPriceE18).toBe("100000000000000000000");
    expect(refreshedMarkets).toEqual(["goldlake:HIMS", "goldlake:HIMS", "goldlake:HIMS"]);
  } finally {
    await new Promise<void>((resolve, reject) => quoteServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("accepts a signed, in-band improvement from the live buy matrix", async () => {
  const clearingAbi = parseAbi([
    "function markets(bytes32) view returns (uint8,uint64,uint64,uint64,uint64,uint128)",
    "function getPosition(address,bytes32) view returns (int256,uint256,uint256,uint64)",
    "function badDebtUsdg() view returns (uint256)"
  ]);
  const oracleAbi = parseAbi(["function getPrice(bytes32) view returns (uint256,uint256,uint256,uint256,uint64,uint64,bool)"]);
  const database = {
    query: async (sql: string) => {
      if (sql.includes("FROM public.markets")) return { rows: [{ id: "market-1", status: "active", max_ticket_usdg: "50000", max_half_spread_bps: 30, observed_at: new Date(), oracle_tradable: true }] };
      if (sql.includes("SELECT notional_usdg")) return { rows: [{ notional_usdg: "5", execution_degradation_bps: -19 }] };
      if (sql.includes("FROM public.exchange_halts")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    }
  } as unknown as Pool;
  const rpc: RpcTransport = {
    call: async ({ to, data }) => to.toLowerCase() === config.GOLDLAKE_FLOAT_CLEARING_HOUSE_ADDRESS!.toLowerCase()
      ? data.startsWith(encodeFunctionData({ abi: clearingAbi, functionName: "badDebtUsdg" }).slice(0, 10))
        ? encodeFunctionResult({ abi: clearingAbi, functionName: "badDebtUsdg", result: 0n })
        : data.startsWith(encodeFunctionData({ abi: clearingAbi, functionName: "getPosition", args: ["0x1111111111111111111111111111111111111111", (`0x${"00".repeat(32)}`) as `0x${string}`] }).slice(0, 10))
          ? encodeFunctionResult({ abi: clearingAbi, functionName: "getPosition", result: [0n, 0n, 100_000_000n, 0n] })
          : encodeFunctionResult({ abi: clearingAbi, functionName: "markets", result: [1, 5_000000000000000000n, 1_000n, 30n, 50n, 50_000_000000n] })
      : encodeFunctionResult({ abi: oracleAbi, functionName: "getPrice", result: [100_000000000000000000n, 100_000000000000000000n, 25n, 0n, BigInt(Math.floor(Date.now() / 1000)), 9n, false] })
  };
  const quoteApp = express();
  quoteApp.use(express.json());
  quoteApp.use("/v1/protocol/transactions", createProtocolTransactionsRouter(config, database, rpc, { ensureFreshMarket: async () => {} }));
  const quoteServer = await listening(quoteApp);
  try {
    const response = await request(quoteServer).post("/v1/protocol/transactions/trade-quote").send({
      market: "SPCX", trader: "0x1111111111111111111111111111111111111111", isLong: true, notionalUsdg: "250000"
    });
    expect(response.status).toBe(200);
    expect(response.body.quote.executionPriceE18).toBe("99810000000000000000");
  } finally {
    await new Promise<void>((resolve, reject) => quoteServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("rejects an unfunded or vault-capacity-exceeding opening quote before wallet execution", async () => {
  const clearingAbi = parseAbi([
    "function markets(bytes32) view returns (uint8,uint64,uint64,uint64,uint64,uint128)",
    "function getPosition(address,bytes32) view returns (int256,uint256,uint256,uint64)",
    "function marketExposure(bytes32) view returns (uint256,uint256)",
    "function badDebtUsdg() view returns (uint256)"
  ]);
  const oracleAbi = parseAbi(["function getPrice(bytes32) view returns (uint256,uint256,uint256,uint256,uint64,uint64,bool)"]);
  const vaultAbi = parseAbi(["function totalAssets() view returns (uint256)"]);
  const positionSelector = encodeFunctionData({ abi: clearingAbi, functionName: "getPosition", args: ["0x1111111111111111111111111111111111111111", (`0x${"00".repeat(32)}`) as `0x${string}`] }).slice(0, 10);
  const exposureSelector = encodeFunctionData({ abi: clearingAbi, functionName: "marketExposure", args: [(`0x${"00".repeat(32)}`) as `0x${string}`] }).slice(0, 10);
  const badDebtSelector = encodeFunctionData({ abi: clearingAbi, functionName: "badDebtUsdg" }).slice(0, 10);
  let margin = 0n;
  let halted = false;
  const database = {
    query: async (sql: string) => {
      if (sql.includes("FROM public.markets")) return { rows: [{ id: "market-1", status: "active", max_ticket_usdg: "50000", max_half_spread_bps: 30, observed_at: new Date(), oracle_tradable: true }] };
      if (sql.includes("SELECT notional_usdg")) return { rows: [{ notional_usdg: "5", execution_degradation_bps: -19 }] };
      if (sql.includes("FROM public.exchange_halts")) return { rows: halted ? [{ symbol: "SPCX", listing_market: "NASDAQ", reason_code: "LUDP", halted_at: new Date(), resumption_trade_at: null }] : [] };
      throw new Error(`unexpected query: ${sql}`);
    }
  } as unknown as Pool;
  const rpc: RpcTransport = {
    call: async ({ to, data }) => {
      if (to.toLowerCase() === config.GOLDLAKE_FLOAT_VAULT_ADDRESS!.toLowerCase()) return encodeFunctionResult({ abi: vaultAbi, functionName: "totalAssets", result: 2_750_000n });
      if (to.toLowerCase() === config.GOLDLAKE_FLOAT_ORACLE_ADDRESS!.toLowerCase()) return encodeFunctionResult({ abi: oracleAbi, functionName: "getPrice", result: [100_000000000000000000n, 100_000000000000000000n, 25n, 0n, BigInt(Math.floor(Date.now() / 1000)), 9n, false] });
      if (data.startsWith(positionSelector)) return encodeFunctionResult({ abi: clearingAbi, functionName: "getPosition", result: [0n, 0n, margin, 0n] });
      if (data.startsWith(exposureSelector)) return encodeFunctionResult({ abi: clearingAbi, functionName: "marketExposure", result: [0n, 0n] });
      if (data.startsWith(badDebtSelector)) return encodeFunctionResult({ abi: clearingAbi, functionName: "badDebtUsdg", result: 0n });
      return encodeFunctionResult({ abi: clearingAbi, functionName: "markets", result: [1, 5_000000000000000000n, 1_000n, 30n, 50n, 50_000_000000n] });
    }
  };
  const quoteApp = express();
  quoteApp.use(express.json());
  quoteApp.use("/v1/protocol/transactions", createProtocolTransactionsRouter(config, database, rpc, { ensureFreshMarket: async () => {} }));
  const quoteServer = await listening(quoteApp);
  try {
    const requestQuote = () => request(quoteServer).post("/v1/protocol/transactions/trade-quote").send({
      market: "SPCX", trader: "0x1111111111111111111111111111111111111111", isLong: true, notionalUsdg: "300000"
    });
    const unfunded = await requestQuote();
    expect(unfunded.status).toBe(400);
    expect(unfunded.body.error).toContain("add at least");
    margin = 100_000n;
    const overCapacity = await requestQuote();
    expect(overCapacity.status).toBe(400);
    expect(overCapacity.body.error).toContain("one-sided market capacity");
    // A listing-exchange halt refuses new exposure before any capacity check.
    halted = true;
    const duringHalt = await requestQuote();
    expect(duringHalt.status).toBe(400);
    expect(duringHalt.body.error).toBe("SPCX is halted on NASDAQ (volatility trading pause). New positions are paused until the exchange resumes trading; you can still close.");
  } finally {
    await new Promise<void>((resolve, reject) => quoteServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("provider failures return a sanitized service error", async () => {
  const failedDatabase = { query: async () => { throw new Error("request to https://rpc.example/key-with-secret failed"); } } as unknown as Pool;
  const failingApp = express();
  failingApp.use(express.json());
  failingApp.use("/v1/protocol/transactions", createProtocolTransactionsRouter(config, failedDatabase, { call: async () => "0x" as `0x${string}` }));
  const failingServer = await listening(failingApp);
  try {
    const response = await request(failingServer).post("/v1/protocol/transactions/trade-quote").send({
      market: "HIMS", trader: "0x1111111111111111111111111111111111111111", isLong: true, notionalUsdg: "1000000"
    });
    expect(response.status).toBe(503);
    expect(response.body.error).toBe("Protocol service is temporarily unavailable");
    expect(JSON.stringify(response.body)).not.toContain("key-with-secret");
  } finally {
    await new Promise<void>((resolve, reject) => failingServer.close((error) => error ? reject(error) : resolve()));
  }
});
