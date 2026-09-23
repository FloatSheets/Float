import { expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";

import { loadConfig } from "../src/config";

const testPrivateKey = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const validEnvironment = {
  ADMIN_EOA_ADDRESS: "0x1111111111111111111111111111111111111111",
  FRONTEND_URL: "https://floatsheets.app",
  LOG_LEVEL: "info",
  MARKET_POLL_INTERVAL_MS: "15000",
  NODE_ENV: "test",
  ORACLE_PRICE_MAX_AGE_SECONDS: "120",
  ORACLE_SIGNER_ADDRESS: privateKeyToAccount(testPrivateKey).address,
  ORACLE_SIGNER_PRIVATE_KEY: testPrivateKey,
  QUOTE_TTL_SECONDS: "15",
  QUOTE_SIGNER_ADDRESS: privateKeyToAccount(testPrivateKey).address,
  QUOTE_SIGNER_PRIVATE_KEY: testPrivateKey,
  RHC_ID: "4663",
  RHC_RPC_URL: "https://rpc.mainnet.chain.robinhood.com",
  UNISWAP_TWAP_WINDOW_SECONDS: "1800"
};

test("loads valid Robinhood Chain configuration", () => {
  expect(loadConfig(validEnvironment).RHC_ID).toBe(4663);
});

test("rejects a non-Robinhood chain ID", () => {
  expect(() => loadConfig({ ...validEnvironment, RHC_ID: "1" })).toThrow("4663");
});

test("rejects a signer address that does not match its private key", () => {
  expect(() =>
    loadConfig({ ...validEnvironment, ORACLE_SIGNER_ADDRESS: "0x1111111111111111111111111111111111111111" })
  ).toThrow("does not match");
});

test("rejects a quote signer address that does not match its private key", () => {
  expect(() => loadConfig({
    ...validEnvironment,
    QUOTE_SIGNER_ADDRESS: "0x0000000000000000000000000000000000000001"
  })).toThrow("QUOTE_SIGNER_ADDRESS does not match QUOTE_SIGNER_PRIVATE_KEY");
});
