/**
 * Penny release (Copper) market discovery.
 *
 * 1. Finds every Uniswap V3 pool on Robinhood Chain that pairs a token with USDG.
 * 2. Reads depth (USDG balance, liquidity), spot and 15-minute TWAP, and a $1k
 *    round-trip cost through the QuoterV2.
 * 3. Joins each Stock Token to the underlying company's market cap from
 *    `--caps <file.json>` (ticker → { marketCapUsd, source, asOf }).
 * 4. Keeps pools that pass the depth gate, sorts by market cap (smallest first)
 *    and writes the top N as JSON plus a ready-to-review SQL seed.
 *
 * Copper prices from reference quotes, so pool depth is reported but is NOT a
 * listing gate by default (pass --require-pool to make it one). Every token must
 * be an official Robinhood Stock Token (a beacon proxy behind
 * ROBINHOOD_STOCK_TOKEN_BEACON): impostor tokens copy names and symbols.
 *
 * Usage:
 *   bun scripts/discover-penny-markets.ts --caps scripts/penny-market-caps.json \
 *     [--top 10] [--require-pool] [--min-usdg 5000] [--max-roundtrip-bps 400] \
 *     [--pools-cache pools.json] [--out ./penny-markets.json] [--sql ./penny-markets.sql]
 *
 * Read-only: it never signs or sends a transaction.
 */
import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { readFileSync, writeFileSync } from "node:fs";

import { UNISWAP_V3_FACTORY, UNISWAP_V3_QUOTER_V2, USDG_ADDRESS } from "../src/chain/constants";
import { ROBINHOOD_STOCK_TOKEN_BEACON } from "../src/prices/reference";

const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const HERMES = process.env.PYTH_HERMES_URL ?? "https://hermes.pyth.network";

const RPC = process.env.RHC_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const POOL_CREATED = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";
const MAX_LOG_SPAN = 9_900_000n;
const TWAP_WINDOW_SECONDS = 900;

const erc20 = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)"
]);
const pool = parseAbi([
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)"
]);
const quoter = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"
]);

export type CapEntry = { marketCapUsd: number; source: string; asOf: string; company?: string };
export type PoolRow = {
  symbol: string;
  name: string;
  token: Address;
  pool: Address;
  feeTier: number;
  usdgDepth: number;
  liquidity: string;
  spotUsdg: number;
  twapUsdg: number | null;
  spotTwapDeviationBps: number | null;
  roundTrip1kBps: number | null;
  observationCardinality: number;
};
export type Candidate = PoolRow & {
  marketCapUsd: number | null; capSource: string | null; capAsOf: string | null; eligible: boolean; reason: string;
  pythFeedId?: string | null;
};

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

let id = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const payload = response.status === 429
      ? { error: { message: "Too Many Requests" } }
      : await response.json() as { result?: T; error?: { message?: string } };
    if (payload.error) {
      // The public RPC rate-limits bursts; back off and retry.
      if (attempt < 8 && /rate|limit|timeout|too many/i.test(payload.error.message ?? "")) { await Bun.sleep(750 * 2 ** Math.min(attempt, 4)); continue; }
      throw new Error(`${method}: ${payload.error.message}`);
    }
    return payload.result as T;
  }
}
const call = (to: Address, data: Hex) => rpc<Hex>("eth_call", [{ to, data }, "latest"]);

async function read<T>(to: Address, abi: readonly unknown[], functionName: string, args: unknown[] = []): Promise<T> {
  const data = encodeFunctionData({ abi: abi as never, functionName: functionName as never, args: args as never });
  return decodeFunctionResult({ abi: abi as never, functionName: functionName as never, data: await call(to, data) }) as T;
}

async function safeString(token: Address, functionName: "symbol" | "name"): Promise<string> {
  try { return await read<string>(token, erc20, functionName); } catch { return "?"; }
}

export async function findUsdgPools(): Promise<{ token: Address; pool: Address; fee: number }[]> {
  const latest = BigInt(await rpc<Hex>("eth_blockNumber", []));
  const usdgTopic = `0x${USDG_ADDRESS.slice(2).toLowerCase().padStart(64, "0")}`;
  const found: { token: Address; pool: Address; fee: number }[] = [];
  for (let from = 0n; from <= latest; from += MAX_LOG_SPAN + 1n) {
    const to = from + MAX_LOG_SPAN > latest ? latest : from + MAX_LOG_SPAN;
    for (const topics of [[POOL_CREATED, usdgTopic], [POOL_CREATED, null, usdgTopic]]) {
      const logs = await rpc<{ topics: Hex[]; data: Hex }[]>("eth_getLogs", [{ address: UNISWAP_V3_FACTORY, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics }]);
      for (const log of logs) {
        const token0 = `0x${log.topics[1].slice(26)}` as Address;
        const token1 = `0x${log.topics[2].slice(26)}` as Address;
        const fee = Number(BigInt(log.topics[3]));
        const [, poolAddress] = decodeAbiParameters([{ type: "int24" }, { type: "address" }], log.data);
        found.push({ token: token0.toLowerCase() === USDG_ADDRESS.toLowerCase() ? token1 : token0, pool: poolAddress as Address, fee });
      }
    }
  }
  return found;
}

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const satisfies Address;
const multicall = parseAbi([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)"
]);

/** Reads name() for many tokens through Multicall3 (deployed on Robinhood Chain). */
export async function tokenNames(tokens: Address[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const nameData = encodeFunctionData({ abi: erc20, functionName: "name" });
  for (let i = 0; i < tokens.length; i += 200) {
    const chunk = tokens.slice(i, i + 200);
    const results = await read<readonly { success: boolean; returnData: Hex }[]>(MULTICALL3, multicall, "aggregate3", [chunk.map((target) => ({ target, allowFailure: true, callData: nameData }))]);
    results.forEach((result, index) => {
      if (!result.success || result.returnData === "0x") return;
      try { names.set(chunk[index].toLowerCase(), decodeFunctionResult({ abi: erc20, functionName: "name", data: result.returnData }) as string); } catch { /* non-standard name() */ }
    });
  }
  return names;
}

/** Robinhood Stock Tokens are named "<Company> • Robinhood Token". */
export function isStockToken(name: string | undefined): boolean {
  return Boolean(name && /robinhood token/i.test(name));
}

function priceFromTick(tick: number, tokenIsToken0: boolean, tokenDecimals: number): number {
  const raw = Math.pow(1.0001, tick); // token1 per token0, raw units
  return tokenIsToken0 ? raw * Math.pow(10, tokenDecimals - 6) : 1 / (raw * Math.pow(10, 6 - tokenDecimals));
}

async function quote(tokenIn: Address, tokenOut: Address, amountIn: bigint, fee: number): Promise<bigint | null> {
  try {
    const [out] = await read<[bigint]>(UNISWAP_V3_QUOTER_V2, quoter, "quoteExactInputSingle", [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }]);
    return out;
  } catch { return null; }
}

export async function inspectPool(entry: { token: Address; pool: Address; fee: number }): Promise<PoolRow> {
  const [symbol, name, decimals, liquidity, slot0, usdg] = await Promise.all([
    safeString(entry.token, "symbol"),
    safeString(entry.token, "name"),
    read<number>(entry.token, erc20, "decimals").catch(() => 18),
    read<bigint>(entry.pool, pool, "liquidity").catch(() => 0n),
    read<readonly [bigint, number, number, number, number, number, boolean]>(entry.pool, pool, "slot0").catch(() => null),
    read<bigint>(USDG_ADDRESS, erc20, "balanceOf", [entry.pool]).catch(() => 0n)
  ]);
  const tokenIsToken0 = entry.token.toLowerCase() < USDG_ADDRESS.toLowerCase();
  const spotTick = slot0 ? Number(slot0[1]) : 0;
  const spotUsdg = slot0 ? priceFromTick(spotTick, tokenIsToken0, Number(decimals)) : 0;
  let twapUsdg: number | null = null;
  try {
    const [cumulatives] = await read<readonly [readonly bigint[], readonly bigint[]]>(entry.pool, pool, "observe", [[TWAP_WINDOW_SECONDS, 0]]);
    const delta = cumulatives[1] - cumulatives[0];
    const meanTick = Number(delta / BigInt(TWAP_WINDOW_SECONDS)) - (delta < 0n && delta % BigInt(TWAP_WINDOW_SECONDS) !== 0n ? 1 : 0);
    twapUsdg = priceFromTick(meanTick, tokenIsToken0, Number(decimals));
  } catch { twapUsdg = null; }
  let roundTrip1kBps: number | null = null;
  if (usdg > 2_000n * 10n ** 6n) {
    const bought = await quote(USDG_ADDRESS, entry.token, 1_000n * 10n ** 6n, entry.fee);
    const back = bought ? await quote(entry.token, USDG_ADDRESS, bought, entry.fee) : null;
    if (back !== null) roundTrip1kBps = Math.round(Number(1_000n * 10n ** 6n - back) * 10_000 / 1e9);
  }
  return {
    symbol, name, token: entry.token, pool: entry.pool, feeTier: entry.fee,
    usdgDepth: Number(usdg) / 1e6,
    liquidity: liquidity.toString(),
    spotUsdg,
    twapUsdg,
    spotTwapDeviationBps: twapUsdg && spotUsdg ? Math.round(Math.abs(spotUsdg - twapUsdg) * 10_000 / twapUsdg) : null,
    roundTrip1kBps,
    observationCardinality: slot0 ? Number(slot0[3]) : 0
  };
}

/** Robinhood Stock Token symbols carry no suffix on chain; strip anything non-alphanumeric for the cap lookup. */
export function tickerOf(symbol: string): string {
  return symbol.toUpperCase().replace(/[^A-Z0-9.]/g, "");
}

export async function isOfficialStockToken(token: Address): Promise<boolean> {
  const value = await rpc<Hex>("eth_getStorageAt", [token, BEACON_SLOT, "latest"]);
  return `0x${value.slice(-40)}`.toLowerCase() === ROBINHOOD_STOCK_TOKEN_BEACON;
}

/** Pyth equity feed for a US ticker, if one exists (Equity.US.<T>/USD). */
export async function pythFeedFor(ticker: string): Promise<string | null> {
  try {
    const response = await fetch(`${HERMES}/v2/price_feeds?asset_type=equity&query=${encodeURIComponent(ticker)}`);
    if (!response.ok) return null;
    const feeds = await response.json() as { id: string; attributes: { symbol?: string } }[];
    return feeds.find((feed) => feed.attributes.symbol === `Equity.US.${ticker}/USD`)?.id ?? null;
  } catch { return null; }
}

export function rankCandidates(rows: PoolRow[], caps: Record<string, CapEntry>, gate: { minUsdg: number; maxRoundTripBps: number; requirePool: boolean }): Candidate[] {
  // Keep the deepest pool per token.
  const best = new Map<string, PoolRow>();
  for (const row of rows) {
    const key = row.token.toLowerCase();
    const current = best.get(key);
    if (!current || row.usdgDepth > current.usdgDepth) best.set(key, row);
  }
  return [...best.values()].map((row) => {
    const cap = caps[tickerOf(row.symbol)];
    let reason = "ok";
    if (!cap || typeof cap.marketCapUsd !== "number") reason = "no market cap on file";
    else if (gate.requirePool && row.usdgDepth < gate.minUsdg) reason = `USDG depth ${row.usdgDepth.toFixed(0)} < ${gate.minUsdg}`;
    else if (gate.requirePool && row.twapUsdg === null) reason = "pool cannot serve a 15-minute TWAP (observation cardinality too low)";
    else if (gate.requirePool && (row.roundTrip1kBps === null || row.roundTrip1kBps > gate.maxRoundTripBps)) reason = `$1k round trip ${row.roundTrip1kBps ?? "n/a"} bps > ${gate.maxRoundTripBps}`;
    return { ...row, marketCapUsd: cap?.marketCapUsd ?? null, capSource: cap?.source ?? null, capAsOf: cap?.asOf ?? null, eligible: reason === "ok", reason };
  }).sort((a, b) => (a.marketCapUsd ?? Infinity) - (b.marketCapUsd ?? Infinity));
}

/** Seed SQL for the selected markets, in the shape of migration 016. Review before applying. */
export function seedSql(selected: Candidate[]): string {
  const rows = selected.map((row) => {
    const tier1 = Boolean(row.pythFeedId);
    // Pools are display-only for reference markets; keep the deepest official pool if it has real depth.
    const pool = row.usdgDepth >= 25_000 ? `'${row.pool.toLowerCase()}', ${row.feeTier}` : "NULL, NULL";
    return `  ('${tickerOf(row.symbol)}', ${pool}, 'active', ${tier1 ? 15 : 10}, ${tier1 ? 1000 : 500}, ${tier1 ? 50 : 60}, ${tier1 ? 200 : 300}, TRUE, 'reference', '{copper}', 'penny', 300, 4000,\n` +
      `   '${row.token}', ${row.pythFeedId ? `'${row.pythFeedId}'` : "NULL"}, ${tier1 ? 2 : 1}, ${Math.round(row.marketCapUsd ?? 0)}, '${row.capAsOf}')`;
  });
  return `INSERT INTO markets (symbol, uniswap_v3_pool_address, uniswap_v3_fee_tier, status, max_leverage, max_ticket_usdg,
  min_half_spread_bps, max_half_spread_bps, listed, price_source, releases, listing_class,
  max_spot_twap_deviation_bps, max_price_jump_bps, token_address, pyth_feed_id, min_sources_for_open,
  market_cap_usd, market_cap_as_of) VALUES
${rows.join(",\n")};
`;
}

if (import.meta.main) {
  const capsPath = arg("caps", "scripts/penny-market-caps.json")!;
  const top = Number(arg("top", "10"));
  const gate = {
    minUsdg: Number(arg("min-usdg", "5000")),
    maxRoundTripBps: Number(arg("max-roundtrip-bps", "400")),
    requirePool: process.argv.includes("--require-pool")
  };
  const out = arg("out", "penny-markets.json")!;
  const sqlOut = arg("sql", "penny-markets.sql")!;
  const caps = JSON.parse(readFileSync(capsPath, "utf8")) as Record<string, CapEntry>;
  const poolsCache = arg("pools-cache");
  let pools: { token: Address; pool: Address; fee: number }[];
  try { pools = poolsCache ? JSON.parse(readFileSync(poolsCache, "utf8")) : await findUsdgPools(); }
  catch { pools = await findUsdgPools(); }
  if (poolsCache) writeFileSync(poolsCache, JSON.stringify(pools));
  console.error(`found ${pools.length} USDG pools`);
  // Most USDG pools are memecoins, and some "Robinhood Token" names are impostors.
  const names = await tokenNames([...new Set(pools.map((entry) => entry.token.toLowerCase()))] as Address[]);
  const named = pools.filter((entry) => isStockToken(names.get(entry.token.toLowerCase())));
  const official = new Map<string, boolean>();
  for (const token of new Set(named.map((entry) => entry.token.toLowerCase()))) {
    official.set(token, await isOfficialStockToken(token as Address));
  }
  const stockPools = named.filter((entry) => official.get(entry.token.toLowerCase()));
  console.error(`${named.length} pools use a Robinhood Token name; ${stockPools.length} pair an official Stock Token (${[...official.values()].filter((ok) => !ok).length} impostor tokens skipped)`);
  const rows: PoolRow[] = [];
  for (const entry of stockPools) { rows.push(await inspectPool(entry)); await Bun.sleep(100); }
  const ranked = rankCandidates(rows, caps, gate);
  const selected = ranked.filter((row) => row.eligible).slice(0, top);
  for (const row of selected) row.pythFeedId = await pythFeedFor(tickerOf(row.symbol));
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), gate, selected, all: ranked }, null, 2));
  writeFileSync(sqlOut, seedSql(selected));
  console.table(ranked.slice(0, 40).map((row) => ({ symbol: row.symbol, capM: row.marketCapUsd ? Math.round(row.marketCapUsd / 1e6) : null, depth: Math.round(row.usdgDepth), spot: Number(row.spotUsdg.toFixed(4)), rt1k: row.roundTrip1kBps, eligible: row.eligible, reason: row.reason })));
  console.error(`selected ${selected.length}: ${selected.map((row) => `${row.symbol}${row.pythFeedId ? "" : " (Robinhood only)"}`).join(", ")} → ${out}, ${sqlOut}`);
  console.error("Stock Tokens with no USDG pool at all are not found by this scan: cross-check the full list at api.robinhood.com/rhj/assets/.");
}
