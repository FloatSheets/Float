import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";

import type { RpcTransport } from "./rpc";

const oracleAbi = parseAbi(["function getPrice(bytes32) view returns (uint256,uint256,uint256,uint256,uint64,uint64,bool)"]);
const clearingAbi = parseAbi([
  "function markets(bytes32) view returns (uint8,uint64,uint64,uint64,uint64,uint128)",
  "function marketExposure(bytes32) view returns (uint256 longBaseE18,uint256 shortBaseE18)",
  "function getPosition(address,bytes32) view returns (int256,uint256,uint256,uint64)",
  "function badDebtUsdg() view returns (uint256)"
]);
const vaultAbi = parseAbi(["function totalAssets() view returns (uint256)"]);
const payoutAbi = parseAbi([
  "function claimableBalance(address) view returns (uint256)",
  "function deferredClaim(address) view returns (uint256)",
  "function pendingPayout(address) view returns (uint256)"
]);

export type OraclePrice = {
  priceE18: bigint; spotPriceE18: bigint; confidenceBps: bigint; spotTwapDeviationBps: bigint;
  timestamp: bigint; sequence: bigint; circuitBroken: boolean;
};
export type ClearingPosition = { sizeE18: bigint; entryPriceE18: bigint; marginUsdg: bigint; openedAt: bigint };
export type ClearingExposure = { longBaseE18: bigint; shortBaseE18: bigint };
export type ClearingMarket = {
  state: number; maxLeverageE18: bigint; maintenanceMarginBps: bigint; maxExecutionDeviationBps: bigint;
  maxOracleConfidenceBps: bigint; maxPositionNotionalUsdg: bigint;
};

export async function readOraclePrice(rpc: RpcTransport, oracle: Address, id: Hex): Promise<OraclePrice> {
  const data = encodeFunctionData({ abi: oracleAbi, functionName: "getPrice", args: [id] });
  const result = await rpc.call({ to: oracle, data });
  const [priceE18, spotPriceE18, confidenceBps, spotTwapDeviationBps, timestamp, sequence, circuitBroken] = decodeFunctionResult({ abi: oracleAbi, functionName: "getPrice", data: result });
  return { priceE18, spotPriceE18, confidenceBps, spotTwapDeviationBps, timestamp: BigInt(timestamp), sequence: BigInt(sequence), circuitBroken };
}

export async function readClearingPosition(rpc: RpcTransport, clearingHouse: Address, trader: Address, id: Hex): Promise<ClearingPosition> {
  const data = encodeFunctionData({ abi: clearingAbi, functionName: "getPosition", args: [trader, id] });
  const result = await rpc.call({ to: clearingHouse, data });
  const [sizeE18, entryPriceE18, marginUsdg, openedAt] = decodeFunctionResult({ abi: clearingAbi, functionName: "getPosition", data: result });
  return { sizeE18, entryPriceE18, marginUsdg, openedAt: BigInt(openedAt) };
}

export async function readBadDebt(rpc: RpcTransport, clearingHouse: Address): Promise<bigint> {
  const data = encodeFunctionData({ abi: clearingAbi, functionName: "badDebtUsdg" });
  const result = await rpc.call({ to: clearingHouse, data });
  return decodeFunctionResult({ abi: clearingAbi, functionName: "badDebtUsdg", data: result });
}

export async function readClearingExposure(rpc: RpcTransport, clearingHouse: Address, id: Hex): Promise<ClearingExposure> {
  const data = encodeFunctionData({ abi: clearingAbi, functionName: "marketExposure", args: [id] });
  const result = await rpc.call({ to: clearingHouse, data });
  const [longBaseE18, shortBaseE18] = decodeFunctionResult({ abi: clearingAbi, functionName: "marketExposure", data: result });
  return { longBaseE18, shortBaseE18 };
}

export async function readClearingMarket(rpc: RpcTransport, clearingHouse: Address, id: Hex): Promise<ClearingMarket> {
  const data = encodeFunctionData({ abi: clearingAbi, functionName: "markets", args: [id] });
  const result = await rpc.call({ to: clearingHouse, data });
  const [state, maxLeverageE18, maintenanceMarginBps, maxExecutionDeviationBps, maxOracleConfidenceBps, maxPositionNotionalUsdg] = decodeFunctionResult({ abi: clearingAbi, functionName: "markets", data: result });
  return { state, maxLeverageE18, maintenanceMarginBps, maxExecutionDeviationBps, maxOracleConfidenceBps, maxPositionNotionalUsdg };
}

export async function readVaultAssets(rpc: RpcTransport, vault: Address): Promise<bigint> {
  const data = encodeFunctionData({ abi: vaultAbi, functionName: "totalAssets" });
  const result = await rpc.call({ to: vault, data });
  return decodeFunctionResult({ abi: vaultAbi, functionName: "totalAssets", data: result });
}

export async function readPayoutBalances(rpc: RpcTransport, clearingHouse: Address, account: Address) {
  const names = ["claimableBalance", "deferredClaim", "pendingPayout"] as const;
  const values = await Promise.all(names.map(async (functionName) => {
    const data = encodeFunctionData({ abi: payoutAbi, functionName, args: [account] });
    const result = await rpc.call({ to: clearingHouse, data });
    return decodeFunctionResult({ abi: payoutAbi, functionName, data: result });
  }));
  return { claimableBalance: values[0], deferredClaim: values[1], pendingPayout: values[2] };
}
