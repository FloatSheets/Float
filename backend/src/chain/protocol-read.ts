import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";

import type { RpcTransport } from "./rpc";

const oracleAbi = parseAbi(["function getPrice(bytes32) view returns (uint256,uint256,uint64,uint64)"]);
const clearingAbi = parseAbi(["function markets(bytes32) view returns (uint8,uint64,uint64,uint64,uint64,uint128)"]);

export type OraclePrice = { priceE18: bigint; confidenceBps: bigint; timestamp: bigint; sequence: bigint };
export type ClearingMarket = {
  state: number; maxLeverageE18: bigint; maintenanceMarginBps: bigint; maxExecutionDeviationBps: bigint;
  maxOracleConfidenceBps: bigint; maxPositionNotionalUsdg: bigint;
};

export async function readOraclePrice(rpc: RpcTransport, oracle: Address, id: Hex): Promise<OraclePrice> {
  const data = encodeFunctionData({ abi: oracleAbi, functionName: "getPrice", args: [id] });
  const result = await rpc.call({ to: oracle, data });
  const [priceE18, confidenceBps, timestamp, sequence] = decodeFunctionResult({ abi: oracleAbi, functionName: "getPrice", data: result });
  return { priceE18, confidenceBps, timestamp: BigInt(timestamp), sequence: BigInt(sequence) };
}

export async function readClearingMarket(rpc: RpcTransport, clearingHouse: Address, id: Hex): Promise<ClearingMarket> {
  const data = encodeFunctionData({ abi: clearingAbi, functionName: "markets", args: [id] });
  const result = await rpc.call({ to: clearingHouse, data });
  const [state, maxLeverageE18, maintenanceMarginBps, maxExecutionDeviationBps, maxOracleConfidenceBps, maxPositionNotionalUsdg] = decodeFunctionResult({ abi: clearingAbi, functionName: "markets", data: result });
  return { state, maxLeverageE18, maintenanceMarginBps, maxExecutionDeviationBps, maxOracleConfidenceBps, maxPositionNotionalUsdg };
}
