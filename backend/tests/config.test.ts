import { expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";

import { contractConfigForVersion, loadConfig } from "../src/config";

const testPrivateKey = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const validEnvironment = {
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
  ORACLE_PUBLISHER_ADDRESS: privateKeyToAccount(testPrivateKey).address,
  ORACLE_PUBLISHER_PRIVATE_KEY: testPrivateKey,
  ORACLE_PUBLISH_INTERVAL_SECONDS: "90",
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

test("uses the current Amber addresses in production when no override is set", () => {
  const amber = contractConfigForVersion(loadConfig({ ...validEnvironment, NODE_ENV: "production" }), "amber");
  expect(amber.FLOAT_CLEARING_HOUSE_ADDRESS).toBe("0x022Cc8DFf79414DcB56812Bd93601854E2b7A700");
  expect(amber.FLOAT_ORACLE_ADDRESS).toBe("0x71B5FBd2df7eF976d02A4b4090450EEE24F77Ce0");
  expect(amber.FLOAT_VAULT_ADDRESS).toBe("0xD5B0461F09C0Cb67AEd9Ca8e73569EAfa3a2E445");
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

test("keeps quote TTL inside the deployed oracle freshness limit", () => {
  expect(loadConfig({ ...validEnvironment, QUOTE_TTL_SECONDS: "105" }).QUOTE_TTL_SECONDS).toBe(105);
  expect(() => loadConfig({ ...validEnvironment, QUOTE_TTL_SECONDS: "106" })).toThrow();
});
