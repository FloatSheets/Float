import { expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";

import { signPriceAttestation, signTradeQuote, verifyTradeQuote } from "../src/signing/signer";

const key = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const contract = "0x1111111111111111111111111111111111111111" as const;
const quote = { marketId: "0x0000000000000000000000000000000000000000000000000000000000000001", trader: "0x2222222222222222222222222222222222222222", sizeDeltaE18: 4_385_964_912_280_701n, executionPriceE18: 228_000000000000000000n, feeUsdg: 500n, maxLeverageE18: 5_000000000000000000n, oracleSequence: 1n, nonce: 1n, expiry: 2_000_000_000n } as const;

test("signs the exact price-attestation shape accepted by FloatOracle", async () => {
  const signature = await signPriceAttestation(key, contract, {
    marketId: quote.marketId, priceE18: quote.executionPriceE18, spotPriceE18: quote.executionPriceE18, confidenceBps: 50n,
    timestamp: 1_900_000_000n, sequence: 1n, expiry: 1_900_000_060n
  });
  expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
});

test("signs and verifies a contract-bound trade quote", async () => {
  const signature = await signTradeQuote(key, contract, quote);
  expect(await verifyTradeQuote(privateKeyToAccount(key).address, contract, quote, signature)).toBe(true);
});

test("rejects quote replay against a different clearing contract", async () => {
  const signature = await signTradeQuote(key, contract, quote);
  expect(await verifyTradeQuote(privateKeyToAccount(key).address, "0x3333333333333333333333333333333333333333", quote, signature)).toBe(false);
});
