import express from "express";
import { expect, test } from "bun:test";
import request from "supertest";
import { privateKeyToAccount } from "viem/accounts";

import { loadConfig } from "../src/config";
import { createProtocolRouter } from "../src/routes/protocol";

const signerKey = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const signer = privateKeyToAccount(signerKey).address;
const config = loadConfig({
  ADMIN_EOA_ADDRESS: "0x1111111111111111111111111111111111111111",
  FLOAT_CLEARING_HOUSE_ADDRESS: "0x2222222222222222222222222222222222222222",
  FLOAT_ORACLE_ADDRESS: "0x3333333333333333333333333333333333333333",
  FLOAT_VAULT_ADDRESS: "0x4444444444444444444444444444444444444444",
  FRONTEND_URL: "https://floatsheets.app",
  LOG_LEVEL: "info",
  MARKET_POLL_INTERVAL_MS: "15000",
  NODE_ENV: "test",
  ORACLE_PRICE_MAX_AGE_SECONDS: "120",
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
app.use("/v1/protocol", createProtocolRouter(config));

test("publishes the deployed protocol addresses for integrations", async () => {
  const response = await request(app).get("/v1/protocol");
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    chain_id: 4663,
    settlement_asset: "USDG",
    oracle: config.FLOAT_ORACLE_ADDRESS,
    vault: config.FLOAT_VAULT_ADDRESS,
    clearing_house: config.FLOAT_CLEARING_HOUSE_ADDRESS,
    oracle_signer: config.ORACLE_SIGNER_ADDRESS,
    quote_signer: config.QUOTE_SIGNER_ADDRESS
  });
});
