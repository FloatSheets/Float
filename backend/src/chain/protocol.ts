import { encodeFunctionData, keccak256, parseAbi, stringToHex, type Address, type Hex } from "viem";

import type { TradeQuote } from "../signing/types";

const erc20Abi = parseAbi(["function approve(address spender,uint256 amount)"]);
const vaultAbi = parseAbi([
  "function deposit(uint256 assets,address receiver) returns (uint256 shares)",
  "function withdraw(uint256 shares,address receiver) returns (uint256 assets)"
]);
const oracleAbi = parseAbi([
  "function publish((bytes32 marketId,uint256 priceE18,uint256 spotPriceE18,uint256 confidenceBps,uint64 timestamp,uint64 sequence,uint64 expiry) attestation,bytes signature)",
  "function setMarketEnabled(bytes32 marketId,bool enabled)"
]);
const clearingAbi = parseAbi([
  "function depositMargin(bytes32 marketId,uint256 assets)",
  "function withdrawMargin(bytes32 marketId,uint256 assets)",
  "function execute((bytes32 marketId,address trader,int256 sizeDeltaE18,uint256 executionPriceE18,uint256 feeUsdg,uint256 maxLeverageE18,uint64 oracleSequence,uint64 nonce,uint64 expiry) quote,bytes signature)",
  "function liquidate(address trader,bytes32 marketId)",
  "function claim(address receiver)",
  "function claimDeferred(address receiver)",
  "function setMarket(bytes32 marketId,(uint8 state,uint64 maxLeverageE18,uint64 maintenanceMarginBps,uint64 maxExecutionDeviationBps,uint64 maxOracleConfidenceBps,uint128 maxPositionNotionalUsdg) market)"
]);

export type ProtocolTransaction = { to: Address; data: Hex; value: "0x0"; chainId: 4663 };

const tx = (to: Address, data: Hex): ProtocolTransaction => ({ to, data, value: "0x0", chainId: 4663 });

export function marketId(symbol: string): Hex {
  return keccak256(stringToHex(symbol.trim().toUpperCase()));
}

export function approveUsdG(usdG: Address, clearingHouse: Address, amount: bigint): ProtocolTransaction {
  return tx(usdG, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [clearingHouse, amount] }));
}

export function depositMargin(clearingHouse: Address, id: Hex, amount: bigint): ProtocolTransaction {
  return tx(clearingHouse, encodeFunctionData({ abi: clearingAbi, functionName: "depositMargin", args: [id, amount] }));
}

export function depositVault(vault: Address, assets: bigint, receiver: Address): ProtocolTransaction {
  return tx(vault, encodeFunctionData({ abi: vaultAbi, functionName: "deposit", args: [assets, receiver] }));
}

export function withdrawVault(vault: Address, shares: bigint, receiver: Address): ProtocolTransaction {
  return tx(vault, encodeFunctionData({ abi: vaultAbi, functionName: "withdraw", args: [shares, receiver] }));
}

export function withdrawMargin(clearingHouse: Address, id: Hex, amount: bigint): ProtocolTransaction {
  return tx(clearingHouse, encodeFunctionData({ abi: clearingAbi, functionName: "withdrawMargin", args: [id, amount] }));
}

export function executeTrade(clearingHouse: Address, quote: TradeQuote, signature: Hex): ProtocolTransaction {
  return tx(clearingHouse, encodeFunctionData({ abi: clearingAbi, functionName: "execute", args: [quote, signature] }));
}

export function liquidate(clearingHouse: Address, trader: Address, id: Hex): ProtocolTransaction {
  return tx(clearingHouse, encodeFunctionData({ abi: clearingAbi, functionName: "liquidate", args: [trader, id] }));
}

export function claimProtocolBalance(clearingHouse: Address, receiver: Address): ProtocolTransaction {
  return tx(clearingHouse, encodeFunctionData({ abi: clearingAbi, functionName: "claim", args: [receiver] }));
}

export function claimDeferredPayout(clearingHouse: Address, receiver: Address): ProtocolTransaction {
  return tx(clearingHouse, encodeFunctionData({ abi: clearingAbi, functionName: "claimDeferred", args: [receiver] }));
}

export function publishOracle(oracle: Address, attestation: readonly [Hex, bigint, bigint, bigint, bigint, bigint, bigint], signature: Hex): ProtocolTransaction {
  return tx(oracle, encodeFunctionData({ abi: oracleAbi, functionName: "publish", args: [{ marketId: attestation[0], priceE18: attestation[1], spotPriceE18: attestation[2], confidenceBps: attestation[3], timestamp: attestation[4], sequence: attestation[5], expiry: attestation[6] }, signature] }));
}

export function enableMarket(oracle: Address, id: Hex, enabled: boolean): ProtocolTransaction {
  return tx(oracle, encodeFunctionData({ abi: oracleAbi, functionName: "setMarketEnabled", args: [id, enabled] }));
}

export function configureMarket(clearingHouse: Address, id: Hex, market: readonly [number, bigint, bigint, bigint, bigint, bigint]): ProtocolTransaction {
  return tx(clearingHouse, encodeFunctionData({ abi: clearingAbi, functionName: "setMarket", args: [id, { state: market[0], maxLeverageE18: market[1], maintenanceMarginBps: market[2], maxExecutionDeviationBps: market[3], maxOracleConfidenceBps: market[4], maxPositionNotionalUsdg: market[5] }] }));
}
