import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";

import type { RpcTransport } from "./rpc";

const oracleAbi = parseAbi(["function getPrice(bytes32) view returns (uint256,uint256,uint256,uint256,uint64,uint64,bool)"]);
const clearingAbi = parseAbi([
  "function markets(bytes32) view returns (uint8,uint64,uint64,uint64,uint64,uint128)",
  "function marketExposure(bytes32) view returns (uint256 longBaseE18,uint256 shortBaseE18)",
  "function getPosition(address,bytes32) view returns (int256,uint256,uint256)"
]);
const vaultAbi = parseAbi(["function totalAssets() view returns (uint256)"]);

export type OraclePrice = {
  priceE18: bigint; spotPriceE18: bigint; confidenceBps: bigint; spotTwapDeviationBps: bigint;
  timestamp: bigint; sequence: bigint; circuitBroken: boolean;
};
export type ClearingPosition = { sizeE18: bigint; entryPriceE18: bigint; marginUsdg: bigint };
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
  const [sizeE18, entryPriceE18, marginUsdg] = decodeFunctionResult({ abi: clearingAbi, functionName: "getPosition", data: result });
  return { sizeE18, entryPriceE18, marginUsdg };
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
