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

const signerKey = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const signer = privateKeyToAccount(signerKey).address;
const config = loadConfig({
  ADMIN_EOA_ADDRESS: "0x1111111111111111111111111111111111111111",
  FLOAT_CLEARING_HOUSE_ADDRESS: "0x2222222222222222222222222222222222222222",
  FLOAT_ORACLE_ADDRESS: "0x3333333333333333333333333333333333333333",
  FLOAT_VAULT_ADDRESS: "0x4444444444444444444444444444444444444444",
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
  UNISWAP_TWAP_WINDOW_SECONDS: "1800"
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

test("publishes the deployed protocol addresses for integrations", async () => {
  const response = await request(server).get("/v1/protocol");
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    chain_id: 4663,
    settlement_asset: "USDG",
    settlement_asset_address: config.USDG_ADDRESS,
    oracle: config.FLOAT_ORACLE_ADDRESS,
    vault: config.FLOAT_VAULT_ADDRESS,
    clearing_house: config.FLOAT_CLEARING_HOUSE_ADDRESS,
    oracle_signer: config.ORACLE_SIGNER_ADDRESS,
    quote_signer: config.QUOTE_SIGNER_ADDRESS
  });
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
  expect(vaultDeposit.body.transaction.to).toBe(config.FLOAT_VAULT_ADDRESS);
  expect(vaultDeposit.body.transaction.data).toMatch(/^0x6e553f65/);

  const vaultWithdraw = await request(server).post("/v1/protocol/transactions/vault-withdraw").send({
    shares: "1000000000000", receiver: "0x1111111111111111111111111111111111111111"
  });
  expect(vaultWithdraw.status).toBe(200);
  expect(vaultWithdraw.body.transaction.to).toBe(config.FLOAT_VAULT_ADDRESS);
  expect(vaultWithdraw.body.transaction.data).toMatch(/^0x00f714ce/);
});

test("rejects signer issuance without the master admin key", async () => {
  const response = await request(server).post("/v1/protocol/transactions/quote").send({
    market: "HIMS", marketId: "0x" + "11".repeat(32), trader: "0x1111111111111111111111111111111111111111",
    sizeDeltaE18: "1000000000000000000", executionPriceE18: "1000000000000000000", feeUsdg: "0", maxLeverageE18: "5000000000000000000",
    oracleSequence: "1", nonce: "1", expiry: "2000000000"
  });
  expect(response.status).toBe(401);
});

test("signs an oracle attestation only with the master admin key", async () => {
  const response = await request(server).post("/v1/protocol/transactions/oracle-attestation")
    .set("x-master-admin-key", config.MASTER_ADMIN_KEY)
    .send({ marketId: "0x" + "11".repeat(32), priceE18: "1000000000000000000", spotPriceE18: "1000000000000000000", confidenceBps: "50", timestamp: "1900000000", sequence: "1", expiry: "1900000060" });
  expect(response.status).toBe(200);
  expect(response.body.signature).toMatch(/^0x[0-9a-f]{130}$/);
  expect(response.body.transaction.to).toBe(config.FLOAT_ORACLE_ADDRESS);
});

test("builds a trader quote and execution transaction without exposing the quote signer", async () => {
  const clearingAbi = parseAbi([
    "function markets(bytes32) view returns (uint8,uint64,uint64,uint64,uint64,uint128)",
    "function getPosition(address,bytes32) view returns (int256,uint256,uint256)"
  ]);
  const oracleAbi = parseAbi(["function getPrice(bytes32) view returns (uint256,uint256,uint256,uint256,uint64,uint64,bool)"]);
  const database = {
    query: async (sql: string, args?: unknown[]) => {
      if (sql.includes("FROM public.markets")) return { rows: [{ id: "market-1", status: "active", max_ticket_usdg: "50000", max_half_spread_bps: 100, observed_at: new Date(), oracle_tradable: true }] };
      if (sql.includes("SELECT notional_usdg")) {
        expect(args?.[2]).toBe("1000.000000");
        return { rows: [{ notional_usdg: "1000", execution_degradation_bps: 25 }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }
  } as unknown as Pool;
  const rpc: RpcTransport = {
    call: async ({ to, data }) => {
      if (to.toLowerCase() !== config.FLOAT_CLEARING_HOUSE_ADDRESS.toLowerCase()) {
        return encodeFunctionResult({ abi: oracleAbi, functionName: "getPrice", result: [100_000000000000000000n, 100_000000000000000000n, 25n, 0n, BigInt(Math.floor(Date.now() / 1000)), 9n, false] });
      }
      const positionSelector = "0x" + encodeFunctionData({
        abi: clearingAbi, functionName: "getPosition",
        args: ["0x1111111111111111111111111111111111111111", (`0x${"00".repeat(32)}`) as `0x${string}`]
      }).slice(2, 10);
      return data.startsWith(positionSelector)
        ? encodeFunctionResult({ abi: clearingAbi, functionName: "getPosition", result: [10_000000000000000000n, 100_000000000000000000n, 5_000_000000n] })
        : encodeFunctionResult({ abi: clearingAbi, functionName: "markets", result: [1, 5_000000000000000000n, 1_000n, 100n, 50n, 50_000_000000n] });
    }
  };
  const refreshedMarkets: string[] = [];
  const oraclePublisher = { ensureFreshMarket: async (symbol: string) => { refreshedMarkets.push(symbol); } };
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
    expect(response.body.transaction.to).toBe(config.FLOAT_CLEARING_HOUSE_ADDRESS);
    expect(refreshedMarkets).toEqual(["HIMS"]);

    const closeResponse = await request(quoteServer).post("/v1/protocol/transactions/close-quote").send({
      market: "HIMS", trader: "0x1111111111111111111111111111111111111111"
    });
    expect(closeResponse.status).toBe(200);
    expect(closeResponse.body.quote.sizeDeltaE18).toBe("-10000000000000000000");
    expect(closeResponse.body.transaction.to).toBe(config.FLOAT_CLEARING_HOUSE_ADDRESS);
    expect(refreshedMarkets).toEqual(["HIMS", "HIMS"]);
  } finally {
    await new Promise<void>((resolve, reject) => quoteServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("accepts a signed, in-band improvement from the live buy matrix", async () => {
  const clearingAbi = parseAbi(["function markets(bytes32) view returns (uint8,uint64,uint64,uint64,uint64,uint128)"]);
  const oracleAbi = parseAbi(["function getPrice(bytes32) view returns (uint256,uint256,uint256,uint256,uint64,uint64,bool)"]);
  const database = {
    query: async (sql: string) => {
      if (sql.includes("FROM public.markets")) return { rows: [{ id: "market-1", status: "active", max_ticket_usdg: "50000", max_half_spread_bps: 30, observed_at: new Date(), oracle_tradable: true }] };
      if (sql.includes("SELECT notional_usdg")) return { rows: [{ notional_usdg: "5", execution_degradation_bps: -19 }] };
      throw new Error(`unexpected query: ${sql}`);
    }
  } as unknown as Pool;
  const rpc: RpcTransport = {
    call: async ({ to }) => to.toLowerCase() === config.FLOAT_CLEARING_HOUSE_ADDRESS.toLowerCase()
      ? encodeFunctionResult({ abi: clearingAbi, functionName: "markets", result: [1, 5_000000000000000000n, 1_000n, 30n, 50n, 50_000_000000n] })
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
