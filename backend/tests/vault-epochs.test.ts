import { expect, test } from "bun:test";

import { loadConfig } from "../src/config";
import { nextEpochAction, VaultEpochKeeper, type VaultEpochChain, type VaultEpochState } from "../src/keeper/vault-epochs";

const key = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("settles a due epoch only with fresh NAV, and always rolls a settled one", () => {
  const base: VaultEpochState = { startedAt: 1_000n, duration: 86_400n, settled: false, epoch: 0n, navFresh: true };
  expect(nextEpochAction(base, 50_000n)).toBeNull();
  expect(nextEpochAction(base, 87_400n)).toBe("settle");
  expect(nextEpochAction({ ...base, navFresh: false }, 87_400n)).toBeNull();
  expect(nextEpochAction({ ...base, settled: true }, 2_000n)).toBe("start_next");
});

test("settles then opens the next epoch on Goldlake and skips retired releases", async () => {
  const { privateKeyToAccount } = await import("viem/accounts");
  const address = privateKeyToAccount(key).address;
  const config = loadConfig({
    ADMIN_EOA_ADDRESS: "0x1111111111111111111111111111111111111111",
    FLOAT_CLEARING_HOUSE_ADDRESS: "0x2222222222222222222222222222222222222222",
    FLOAT_ORACLE_ADDRESS: "0x3333333333333333333333333333333333333333",
    FLOAT_VAULT_ADDRESS: "0x4444444444444444444444444444444444444444",
    MASTER_ADMIN_KEY: "test-master-admin-key-012345678901234567890123456789",
    USDG_ADDRESS: "0x5555555555555555555555555555555555555555",
    FRONTEND_URL: "https://floatsheets.app", LOG_LEVEL: "info", MARKET_POLL_INTERVAL_MS: "15000", NODE_ENV: "production",
    ORACLE_PRICE_MAX_AGE_SECONDS: "120", ORACLE_PUBLISHER_ADDRESS: address, ORACLE_PUBLISHER_PRIVATE_KEY: key,
    ORACLE_SIGNER_ADDRESS: address, ORACLE_SIGNER_PRIVATE_KEY: key, QUOTE_TTL_SECONDS: "15", QUOTE_SIGNER_ADDRESS: address,
    QUOTE_SIGNER_PRIVATE_KEY: key, RHC_ID: "4663", RHC_RPC_URL: "https://rpc.mainnet.chain.robinhood.com", UNISWAP_TWAP_WINDOW_SECONDS: "300"
  });
  let settled = false;
  const sent: string[] = [];
  const chain: VaultEpochChain = {
    now: async () => 200_000n,
    state: async (vault) => {
      expect(vault.toLowerCase()).toBe(config.GOLDLAKE_FLOAT_VAULT_ADDRESS.toLowerCase());
      return { startedAt: 1_000n, duration: 86_400n, settled, epoch: 0n, navFresh: true };
    },
    send: async (_vault, functionName) => { sent.push(functionName); if (functionName === "settleQueue") settled = true; return "0xabc"; }
  };
  const keeper = new VaultEpochKeeper(config, chain);
  expect(keeper.versions()).toEqual(["goldlake"]);
  const results = await keeper.runOnce();
  expect(sent).toEqual(["settleQueue", "startNextQueueEpoch"]);
  expect(results.map((result) => result.action)).toEqual(["settle", "start_next"]);
});
