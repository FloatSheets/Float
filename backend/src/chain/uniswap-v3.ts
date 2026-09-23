import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  type Address
} from "viem";

import { USDG_ADDRESS, USDG_DECIMALS } from "./constants";
import { UNISWAP_V3_QUOTER_V2 } from "./constants";
import type { RpcTransport } from "./rpc";

const poolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)"
]);

const erc20Abi = parseAbi(["function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"]);
const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"
]);

export type PoolTwap = {
  assetAddress: Address;
  assetDecimals: number;
  liquidity: bigint;
  sqrtPriceX96: bigint;
  usdgBalance: bigint;
  meanTick: number;
  priceUsdg: number;
  token0: Address;
  token1: Address;
};

function floorDivision(dividend: bigint, divisor: bigint): bigint {
  const quotient = dividend / divisor;
  return dividend < 0n && dividend % divisor !== 0n ? quotient - 1n : quotient;
}

export function arithmeticMeanTick(tickCumulatives: readonly bigint[], windowSeconds: number): number {
  if (tickCumulatives.length !== 2) throw new Error("Uniswap observe must return two tick cumulatives");
  const delta = tickCumulatives[1] - tickCumulatives[0];
  return Number(floorDivision(delta, BigInt(windowSeconds)));
}

export function priceUsdgFromTick(
  meanTick: number,
  token0: Address,
  token1: Address,
  token0Decimals: number,
  token1Decimals: number
): number {
  const token1PerToken0Raw = Math.pow(1.0001, meanTick);
  const isToken0Usdg = token0.toLowerCase() === USDG_ADDRESS.toLowerCase();
  const isToken1Usdg = token1.toLowerCase() === USDG_ADDRESS.toLowerCase();
  if (!isToken0Usdg && !isToken1Usdg) throw new Error("Pool is not a direct USDG pool");

  if (isToken1Usdg) {
    return token1PerToken0Raw * Math.pow(10, token0Decimals - USDG_DECIMALS);
  }

  const token1PerUsdg = token1PerToken0Raw * Math.pow(10, USDG_DECIMALS - token1Decimals);
  return 1 / token1PerUsdg;
}

export async function readPoolTwap(
  rpc: RpcTransport,
  poolAddress: Address,
  windowSeconds: number
): Promise<PoolTwap> {
  const token0Data = encodeFunctionData({ abi: poolAbi, functionName: "token0" });
  const token1Data = encodeFunctionData({ abi: poolAbi, functionName: "token1" });
  const liquidityData = encodeFunctionData({ abi: poolAbi, functionName: "liquidity" });
  const slot0Data = encodeFunctionData({ abi: poolAbi, functionName: "slot0" });
  const observeData = encodeFunctionData({
    abi: poolAbi,
    args: [[windowSeconds, 0]],
    functionName: "observe"
  });

  const [token0Result, token1Result, liquidityResult, slot0Result, observeResult] = await Promise.all([
    rpc.call({ data: token0Data, to: poolAddress }),
    rpc.call({ data: token1Data, to: poolAddress }),
    rpc.call({ data: liquidityData, to: poolAddress }),
    rpc.call({ data: slot0Data, to: poolAddress }),
    rpc.call({ data: observeData, to: poolAddress })
  ]);

  const token0 = decodeFunctionResult({ abi: poolAbi, data: token0Result, functionName: "token0" });
  const token1 = decodeFunctionResult({ abi: poolAbi, data: token1Result, functionName: "token1" });
  const liquidity = decodeFunctionResult({ abi: poolAbi, data: liquidityResult, functionName: "liquidity" });
  const [sqrtPriceX96] = decodeFunctionResult({ abi: poolAbi, data: slot0Result, functionName: "slot0" });
  const [tickCumulatives] = decodeFunctionResult({ abi: poolAbi, data: observeResult, functionName: "observe" });
  const [token0DecimalsResult, token1DecimalsResult] = await Promise.all([
    rpc.call({
      data: encodeFunctionData({ abi: erc20Abi, functionName: "decimals" }),
      to: token0
    }),
    rpc.call({
      data: encodeFunctionData({ abi: erc20Abi, functionName: "decimals" }),
      to: token1
    })
  ]);
  const token0Decimals = Number(
    decodeFunctionResult({ abi: erc20Abi, data: token0DecimalsResult, functionName: "decimals" })
  );
  const token1Decimals = Number(
    decodeFunctionResult({ abi: erc20Abi, data: token1DecimalsResult, functionName: "decimals" })
  );
  const meanTick = arithmeticMeanTick(tickCumulatives, windowSeconds);
  const assetIsToken0 = token1.toLowerCase() === USDG_ADDRESS.toLowerCase();
  const usdgBalance = decodeFunctionResult({
    abi: erc20Abi,
    data: await rpc.call({ data: encodeFunctionData({ abi: erc20Abi, args: [poolAddress], functionName: "balanceOf" }), to: USDG_ADDRESS }),
    functionName: "balanceOf"
  });

  return {
    assetAddress: (assetIsToken0 ? token0 : token1) as Address,
    assetDecimals: assetIsToken0 ? token0Decimals : token1Decimals,
    liquidity,
    sqrtPriceX96,
    usdgBalance,
    meanTick,
    priceUsdg: priceUsdgFromTick(meanTick, token0, token1, token0Decimals, token1Decimals),
    token0,
    token1
  };
}

export async function quoteExactInputSingle(
  rpc: RpcTransport,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  fee: number
): Promise<bigint> {
  const data = encodeFunctionData({
    abi: quoterAbi,
    args: [{ amountIn, fee, sqrtPriceLimitX96: 0n, tokenIn, tokenOut }],
    functionName: "quoteExactInputSingle"
  });
  const result = await rpc.call({ data, to: UNISWAP_V3_QUOTER_V2 });
  const [amountOut] = decodeFunctionResult({ abi: quoterAbi, data: result, functionName: "quoteExactInputSingle" });
  return amountOut;
}
