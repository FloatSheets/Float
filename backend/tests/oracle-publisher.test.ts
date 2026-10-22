import { expect, test } from "bun:test";
import { encodeFunctionResult, parseAbi, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Pool } from "pg";

import { loadConfig } from "../src/config";
import { OraclePublisher, shouldPublishGoldlakeMarket, snapshotTimeOnChain } from "../src/oracle/publisher";
import type { RpcTransport } from "../src/chain/rpc";

const key = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const account = privateKeyToAccount(key).address;
const config = loadConfig({
  ADMIN_EOA_ADDRESS: "0x1111111111111111111111111111111111111111",
  FLOAT_CLEARING_HOUSE_ADDRESS: "0x2222222222222222222222222222222222222222",
  FLOAT_ORACLE_ADDRESS: "0x3333333333333333333333333333333333333333",
  FLOAT_VAULT_ADDRESS: "0x4444444444444444444444444444444444444444",
  MASTER_ADMIN_KEY: "test-master-admin-key-012345678901234567890123456789",
  USDG_ADDRESS: "0x5555555555555555555555555555555555555555",
  FRONTEND_URL: "https://floatsheets.app", LOG_LEVEL: "info", MARKET_POLL_INTERVAL_MS: "15000", NODE_ENV: "test",
  ORACLE_PRICE_MAX_AGE_SECONDS: "120", ORACLE_PUBLISHER_ADDRESS: account, ORACLE_PUBLISHER_PRIVATE_KEY: key,
  ORACLE_PUBLISH_INTERVAL_SECONDS: "110", ORACLE_SIGNER_ADDRESS: account, ORACLE_SIGNER_PRIVATE_KEY: key,
  QUOTE_TTL_SECONDS: "15", QUOTE_SIGNER_ADDRESS: account, QUOTE_SIGNER_PRIVATE_KEY: key,
  RHC_ID: "4663", RHC_RPC_URL: "https://rpc.mainnet.chain.robinhood.com", UNISWAP_TWAP_WINDOW_SECONDS: "1800"
});

test("does not spend publisher gas on inactive markets", async () => {
  const database = {
    query: async (sql: string) => sql.includes("WHERE m.symbol=$1")
      ? { rows: [{ status: "disabled", oracle_tradable: false }] }
      : { rows: [{ symbol: "HIMS", observed_at: new Date(), twap_price_usdg: "30", spot_price_usdg: "30" }] }
  } as unknown as Pool;
  const exposureAbi = parseAbi(["function marketExposure(bytes32) view returns (uint256 longBaseE18,uint256 shortBaseE18)"]);
  const marketAbi = parseAbi(["function markets(bytes32) view returns (uint8,uint64,uint64,uint64,uint64,uint128)"]);
  const exposureSelector = toFunctionSelector("marketExposure(bytes32)");
  const marketSelector = toFunctionSelector("markets(bytes32)");
  let exposureCalls = 0;
  let unexpectedCalls = 0;
  const rpc: RpcTransport = {
    call: async ({ data }) => {
      if (data.startsWith(marketSelector)) {
        return encodeFunctionResult({ abi: marketAbi, functionName: "markets", result: [1, 0n, 0n, 0n, 0n, 0n] });
      }
      if (data.startsWith(exposureSelector)) {
        exposureCalls += 1;
        return encodeFunctionResult({ abi: exposureAbi, functionName: "marketExposure", result: [0n, 0n] });
      }
      unexpectedCalls += 1;
      throw new Error("unexpected oracle read for a market with no exposure");
    }
  };

  await new OraclePublisher(database, rpc, config).publishFreshMarkets();

  // Every deployment checks exposure so close-only positions keep getting marks.
  expect(exposureCalls).toBe(6);
  expect(unexpectedCalls).toBe(0);
});

test("converts backend snapshot time into chain time when the server clock leads", () => {
  const snapshotAt = new Date(995_000);
  const chainTimestamp = snapshotTimeOnChain(snapshotAt, 1_000n, 990n);
  expect(chainTimestamp).toBe(985n);
  expect(990n - chainTimestamp).toBe(5n);
});

test("keeps oracle marks running for Goldlake close-only markets with open positions", () => {
  expect(shouldPublishGoldlakeMarket({
    state: 2, status: "restricted", oracleTradable: false, longBaseE18: 1n, shortBaseE18: 0n
  })).toBe(true);
  expect(shouldPublishGoldlakeMarket({
    state: 2, status: "restricted", oracleTradable: false, longBaseE18: 0n, shortBaseE18: 0n
  })).toBe(false);
  expect(shouldPublishGoldlakeMarket({
    state: 1, status: "active", oracleTradable: true, longBaseE18: 0n, shortBaseE18: 0n
  })).toBe(true);
});
