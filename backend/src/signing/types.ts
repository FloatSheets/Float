import type { Address, Hex } from "viem";

export const ORACLE_DOMAIN_NAME = "FloatSheetsOracle";
export const CLEARING_DOMAIN_NAME = "FloatSheetsClearing";
export const EIP712_VERSION = "1";

export type PriceAttestation = {
  marketId: Hex;
  priceE18: bigint;
  confidenceBps: bigint;
  timestamp: bigint;
  sequence: bigint;
  expiry: bigint;
};

export type TradeQuote = {
  marketId: Hex;
  trader: Address;
  isLong: boolean;
  notionalUsdg: bigint;
  executionPriceE18: bigint;
  feeUsdg: bigint;
  maxLeverageE18: bigint;
  oracleSequence: bigint;
  nonce: bigint;
  expiry: bigint;
};

export const priceAttestationTypes = {
  PriceAttestation: [
    { name: "marketId", type: "bytes32" }, { name: "priceE18", type: "uint256" },
    { name: "confidenceBps", type: "uint256" }, { name: "timestamp", type: "uint64" },
    { name: "sequence", type: "uint64" }, { name: "expiry", type: "uint64" }
  ]
} as const;

export const tradeQuoteTypes = {
  TradeQuote: [
    { name: "marketId", type: "bytes32" }, { name: "trader", type: "address" },
    { name: "isLong", type: "bool" }, { name: "notionalUsdg", type: "uint256" },
    { name: "executionPriceE18", type: "uint256" }, { name: "feeUsdg", type: "uint256" },
    { name: "maxLeverageE18", type: "uint256" }, { name: "oracleSequence", type: "uint64" },
    { name: "nonce", type: "uint64" }, { name: "expiry", type: "uint64" }
  ]
} as const;
