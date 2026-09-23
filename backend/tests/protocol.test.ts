import express from "express";
import { expect, test } from "bun:test";
import request from "supertest";
import { privateKeyToAccount } from "viem/accounts";

import { loadConfig } from "../src/config";
import { createProtocolRouter } from "../src/routes/protocol";
import { createProtocolTransactionsRouter } from "../src/routes/protocol-transactions";

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

test("publishes the deployed protocol addresses for integrations", async () => {
  const response = await request(app).get("/v1/protocol");
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
  const response = await request(app).post("/v1/protocol/transactions/approve").send({ amountUsdg: "1000000" });
  expect(response.status).toBe(200);
  expect(response.body.transaction.to).toBe(config.USDG_ADDRESS);
  expect(response.body.transaction.chainId).toBe(4663);
  expect(response.body.transaction.data).toMatch(/^0x095ea7b3/);
});

test("rejects signer issuance without the master admin key", async () => {
  const response = await request(app).post("/v1/protocol/transactions/quote").send({
    marketId: "0x" + "11".repeat(32), trader: "0x1111111111111111111111111111111111111111", isLong: true,
    notionalUsdg: "1000000", executionPriceE18: "1000000000000000000", feeUsdg: "0", maxLeverageE18: "5000000000000000000",
    oracleSequence: "1", nonce: "1", expiry: "2000000000"
  });
  expect(response.status).toBe(401);
});

test("signs an oracle attestation only with the master admin key", async () => {
  const response = await request(app).post("/v1/protocol/transactions/oracle-attestation")
    .set("x-master-admin-key", config.MASTER_ADMIN_KEY)
    .send({ marketId: "0x" + "11".repeat(32), priceE18: "1000000000000000000", confidenceBps: "50", timestamp: "1900000000", sequence: "1", expiry: "1900000060" });
  expect(response.status).toBe(200);
  expect(response.body.signature).toMatch(/^0x[0-9a-f]{130}$/);
  expect(response.body.transaction.to).toBe(config.FLOAT_ORACLE_ADDRESS);
});
