import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";

import type { RpcTransport } from "../chain/rpc";

/** FloatClearingHouse exposure limits, in basis points of vault assets. */
const BPS = 10_000n;
const MARKET_OPEN_INTEREST_BPS = 1_500n;
const MARKET_SKEW_BPS = 1_000n;
const GLOBAL_UTILIZATION_BPS = 5_000n;
/** Quotes execute slightly away from the mark; keep a margin so the shown size fits. */
const SAFETY_BPS = 100n;
const E18 = 10n ** 18n;
const E12 = 10n ** 12n;

const abi = parseAbi([
  "function vault() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function marketCount() view returns (uint256)",
  "function marketIdAt(uint256) view returns (bytes32)",
  "function marketExposure(bytes32) view returns (uint256,uint256)",
  "function getPrice(bytes32) view returns (uint256,uint256,uint256,uint256,uint64,uint64,bool)"
]);

export type MarketExposureUsdg = { longOi: bigint; shortOi: bigint };

export type Capacity = {
  /** Largest new long / short notional the contract accepts right now, in USDG units. */
  longUsdg: bigint;
  shortUsdg: bigint;
  vaultUsdg: bigint;
};

function clamp(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

/**
 * The largest new position the clearing house would accept in one market, from
 * the same limits it enforces on execution: one-sided skew within 10% of the
 * vault, market open interest within 15%, all markets within 50%, and the
 * market's per-position cap. Users see this before trading instead of a
 * capacity error after signing.
 */
export function maxNewPosition(input: {
  vaultUsdg: bigint; market: MarketExposureUsdg; globalOiUsdg: bigint; positionCapUsdg: bigint;
}): { longUsdg: bigint; shortUsdg: bigint } {
  const { vaultUsdg, market, globalOiUsdg, positionCapUsdg } = input;
  const oiRoom = vaultUsdg * MARKET_OPEN_INTEREST_BPS / BPS - (market.longOi + market.shortOi);
  const globalRoom = vaultUsdg * GLOBAL_UTILIZATION_BPS / BPS - globalOiUsdg;
  const skewLimit = vaultUsdg * MARKET_SKEW_BPS / BPS;
  // A new long widens a long skew, or first unwinds a short one.
  const longSkewRoom = skewLimit - (market.longOi - market.shortOi);
  const shortSkewRoom = skewLimit - (market.shortOi - market.longOi);
  const withSafety = (value: bigint) => clamp(value) * (BPS - SAFETY_BPS) / BPS;
  const pick = (skewRoom: bigint) => {
    let room = skewRoom < oiRoom ? skewRoom : oiRoom;
    if (globalRoom < room) room = globalRoom;
    const sized = withSafety(room);
    return positionCapUsdg < sized ? positionCapUsdg : sized;
  };
  return { longUsdg: pick(longSkewRoom), shortUsdg: pick(shortSkewRoom) };
}

/** Reads every registered market's exposure once and returns capacity per market id. */
export async function readCapacities(
  rpc: RpcTransport, clearingHouse: Address, oracle: Address, positionCaps: Map<string, bigint>
): Promise<Map<string, Capacity>> {
  const call = async (to: Address, functionName: string, args: readonly unknown[] = []): Promise<any> => {
    const data = encodeFunctionData({ abi, functionName, args } as any);
    return decodeFunctionResult({ abi, functionName, data: await rpc.call({ to, data }) } as any);
  };
  const vault = await call(clearingHouse, "vault") as Address;
  const [vaultUsdg, count] = await Promise.all([call(vault, "totalAssets") as Promise<bigint>, call(clearingHouse, "marketCount") as Promise<bigint>]);
  const ids = await Promise.all(Array.from({ length: Number(count) }, (_, index) => call(clearingHouse, "marketIdAt", [BigInt(index)]) as Promise<Hex>));
  const exposures = new Map<string, MarketExposureUsdg>();
  await Promise.all(ids.map(async (id) => {
    const [[longBase, shortBase], price] = await Promise.all([
      call(clearingHouse, "marketExposure", [id]) as Promise<[bigint, bigint]>,
      call(oracle, "getPrice", [id]) as Promise<readonly [bigint, ...unknown[]]>
    ]);
    const mark = price[0];
    exposures.set(id.toLowerCase(), { longOi: longBase * mark / E18 / E12, shortOi: shortBase * mark / E18 / E12 });
  }));
  const globalOiUsdg = [...exposures.values()].reduce((sum, item) => sum + item.longOi + item.shortOi, 0n);
  const result = new Map<string, Capacity>();
  for (const [id, cap] of positionCaps) {
    const market = exposures.get(id.toLowerCase());
    if (!market) continue;
    const room = maxNewPosition({ vaultUsdg, market, globalOiUsdg, positionCapUsdg: cap });
    result.set(id.toLowerCase(), { ...room, vaultUsdg });
  }
  return result;
}
