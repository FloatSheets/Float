import "dotenv/config";

import { expect, test } from "bun:test";

import { createRpcTransport } from "../src/chain/rpc";
import { readPoolTwap } from "../src/chain/uniswap-v3";

const nvdaUsdgPool = "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3" as const;

test("reads a healthy, live NVDA/USDG TWAP from Robinhood Chain", async () => {
  const rpcUrl = process.env.RHC_RPC_URL;
  const twapWindow = Number(process.env.UNISWAP_TWAP_WINDOW_SECONDS);
  if (!rpcUrl) throw new Error("RHC_RPC_URL must be set for live integration tests");
  expect(rpcUrl).toBeString();
  expect(twapWindow).toBeGreaterThanOrEqual(60);

  const snapshot = await readPoolTwap(createRpcTransport(rpcUrl), nvdaUsdgPool, twapWindow);

  expect(snapshot.assetAddress.toLowerCase()).toBe("0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec");
  expect(snapshot.assetDecimals).toBe(18);
  expect(snapshot.liquidity).toBeGreaterThan(0n);
  expect(snapshot.priceUsdg).toBeGreaterThan(1);
  expect(snapshot.priceUsdg).toBeLessThan(10_000);
});
