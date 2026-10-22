import type { Pool } from "pg";
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";

import { contractConfigForVersion, isGoldlakeConfigured, isSilverlakeConfigured, type AppConfig, type ContractVersion } from "../config";
import { safeErrorMessage } from "../safe-error";
import { marketId } from "../chain/protocol";
import type { RpcTransport } from "../chain/rpc";
import { readClearingExposure, readClearingMarket, readOraclePrice } from "../chain/protocol-read";
import { signPriceAttestation } from "../signing/signer";
import { bandedOracleMarks, weekendBandOptions, WeekendBands } from "../markets/weekend-bands";
import { splitNear } from "../markets/corporate-actions";
import type { PriceAttestation } from "../signing/types";

const oracleAbi = parseAbi([
  "function publish((bytes32 marketId,uint256 priceE18,uint256 spotPriceE18,uint256 confidenceBps,uint64 timestamp,uint64 sequence,uint64 expiry) attestation,bytes signature)"
]);
const MAX_CONFIDENCE_BPS = 50n;
const ATTESTATION_TTL_SECONDS = 120n;
const PUBLISH_SAFETY_WINDOW_SECONDS = 30n;

export function effectiveOraclePublishIntervalSeconds(configuredSeconds: number): number {
  // Refresh comfortably inside the contracts' 120-second attestation lifetime,
  // even when production configuration asks for a slower cadence.
  return Math.min(configuredSeconds, 60);
}

export function oraclePublishRequired(input: {
  sequence: bigint;
  currentTimestamp: bigint;
  chainNow: bigint;
  currentCircuitBroken: boolean;
  nextCircuitBroken: boolean;
}): boolean {
  return input.sequence === 0n
    || input.chainNow >= input.currentTimestamp + ATTESTATION_TTL_SECONDS - PUBLISH_SAFETY_WINDOW_SECONDS
    || input.currentCircuitBroken !== input.nextCircuitBroken;
}

/** FloatOracle.MAX_PRICE_JUMP_BPS: a larger move is quarantined as circuit-broken. */
export const ORACLE_JUMP_GUARD_BPS = 2_000n;

/**
 * Walks the mark toward a target the contract's jump guard would reject.
 * Without this, a real move above 20% (a stock split, a gap on news) leaves
 * the oracle holding the old price indefinitely. Each step stays inside the
 * guard and publishes a clean mark (spot equal to the step), so liquidations
 * keep working along the way. Opens are refused separately until caught up.
 */
export function oracleCatchUp(currentE18: bigint, targetTwapE18: bigint, targetSpotE18: bigint, stepBps: bigint):
  { twapE18: bigint; spotE18: bigint; stepping: boolean } {
  if (currentE18 === 0n) return { twapE18: targetTwapE18, spotE18: targetSpotE18, stepping: false };
  const delta = targetTwapE18 > currentE18 ? targetTwapE18 - currentE18 : currentE18 - targetTwapE18;
  if (delta * 10_000n <= ORACLE_JUMP_GUARD_BPS * currentE18) return { twapE18: targetTwapE18, spotE18: targetSpotE18, stepping: false };
  const step = targetTwapE18 > currentE18 ? currentE18 * (10_000n + stepBps) / 10_000n : currentE18 * (10_000n - stepBps) / 10_000n;
  return { twapE18: step, spotE18: step, stepping: true };
}

export function snapshotTimeOnChain(snapshotAt: Date, wallTimeSeconds: bigint, chainTimeSeconds: bigint): bigint {
  const snapshotWallTime = BigInt(Math.floor(snapshotAt.getTime() / 1_000));
  return snapshotWallTime - (wallTimeSeconds - chainTimeSeconds);
}

const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } }
});

function decimalToE18(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(`${whole}${fraction.padEnd(18, "0").slice(0, 18)}`);
}

function circuitBroken(twapPriceE18: bigint, spotPriceE18: bigint): boolean {
  const delta = twapPriceE18 > spotPriceE18 ? twapPriceE18 - spotPriceE18 : spotPriceE18 - twapPriceE18;
  return delta * 10_000n / twapPriceE18 > 50n;
}

export function shouldPublishGoldlakeMarket(input: {
  longBaseE18: bigint;
  shortBaseE18: bigint;
}): boolean {
  // Keep prices fresh for exits and liquidation while positions exist. Markets
  // without exposure are initialized/refreshed on demand before a quote.
  return input.longBaseE18 !== 0n || input.shortBaseE18 !== 0n;
}

export class OraclePublisher {
  private readonly wallet;
  private readonly publicClient;
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly weekendBands: WeekendBands;
  /** When each market's pool first diverged beyond the oracle jump guard. */
  private readonly divergenceSince = new Map<string, Date>();

  constructor(private readonly database: Pool, private readonly rpc: RpcTransport, private readonly config: AppConfig) {
    const account = privateKeyToAccount(config.ORACLE_PUBLISHER_PRIVATE_KEY as Hex);
    this.wallet = createWalletClient({ account, chain: { ...robinhoodChain, rpcUrls: { default: { http: [config.RHC_RPC_URL] } } }, transport: http(config.RHC_RPC_URL) });
    this.publicClient = createPublicClient({ chain: { ...robinhoodChain, rpcUrls: { default: { http: [config.RHC_RPC_URL] } } }, transport: http(config.RHC_RPC_URL) });
    this.weekendBands = new WeekendBands(database, weekendBandOptions(config));
  }

  async publishFreshMarkets(): Promise<void> {
    const { rows } = await this.database.query<{ symbol: string; observed_at: Date | null; twap_price_usdg: string | null; spot_price_usdg: string | null }>(
      `SELECT m.symbol,s.observed_at,s.twap_price_usdg,s.spot_price_usdg
       FROM public.markets m LEFT JOIN LATERAL (
         SELECT observed_at,twap_price_usdg,spot_price_usdg FROM public.pool_snapshots WHERE market_id=m.id ORDER BY observed_at DESC LIMIT 1
       ) s ON true WHERE m.status != 'disabled' ORDER BY m.symbol`
    );
    // Send in sequence so concurrent writes cannot race for the publisher nonce.
    for (const row of rows) for (const version of ["goldlake", "silverlake", "amber", "jasper", "meadow", "legacy-orion"] as const) {
      try {
        if (version === "goldlake" && !isGoldlakeConfigured(this.config)) continue;
        if (version === "silverlake" && !isSilverlakeConfigured(this.config)) continue;
        const versionConfig = contractConfigForVersion(this.config, version);
        const id = marketId(row.symbol);
        if (version === "goldlake") {
          const exposure = await readClearingExposure(this.rpc, versionConfig.FLOAT_CLEARING_HOUSE_ADDRESS as Address, id);
          if (!shouldPublishGoldlakeMarket(exposure)) continue;
          await this.publishRow(row, false, version);
          continue;
        }
        const exposure = await readClearingExposure(this.rpc, versionConfig.FLOAT_CLEARING_HOUSE_ADDRESS as Address, id);
        // Retired versions also keep marks only while positions remain open.
        if (exposure.longBaseE18 === 0n && exposure.shortBaseE18 === 0n) continue;
        await this.publishRow(row, false, version);
      } catch (error) {
        console.error(JSON.stringify({ event: "oracle_attestation_failed", version, market: row.symbol, error: safeErrorMessage(error) }));
      }
    }
  }

  /** Refreshes a market immediately before an API-issued open or close quote. */
  async ensureFreshMarket(symbol: string, version: ContractVersion = "silverlake"): Promise<void> {
    const normalized = symbol.trim().toUpperCase();
    const key = `${version}:${normalized}`;
    const inFlight = this.refreshing.get(key);
    if (inFlight) return inFlight;
    const task = this.ensureFreshMarketInner(normalized, version).finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, task);
    return task;
  }

  private async ensureFreshMarketInner(symbol: string, version: ContractVersion): Promise<void> {
    const { rows } = await this.database.query<{ symbol: string; observed_at: Date | null; twap_price_usdg: string | null; spot_price_usdg: string | null }>(
      `SELECT m.symbol,s.observed_at,s.twap_price_usdg,s.spot_price_usdg
       FROM public.markets m LEFT JOIN LATERAL (
         SELECT observed_at,twap_price_usdg,spot_price_usdg FROM public.pool_snapshots WHERE market_id=m.id ORDER BY observed_at DESC LIMIT 1
       ) s ON true WHERE m.symbol=$1 AND m.status != 'disabled'`, [symbol]
    );
    const row = rows[0];
    if (!row) throw new Error("market is unavailable for oracle publication");
    await this.publishRow(row, true, version);
  }

  private async publishRow(
    row: { symbol: string; observed_at: Date | null; twap_price_usdg: string | null; spot_price_usdg: string | null },
    onDemand: boolean,
    version: ContractVersion
  ): Promise<void> {
    if (!row.observed_at || !row.twap_price_usdg || !row.spot_price_usdg) throw new Error("market has no oracle snapshot");
    const wallNow = BigInt(Math.floor(Date.now() / 1_000));
    const observedAtWall = BigInt(Math.floor(row.observed_at.getTime() / 1_000));
    const wallAge = wallNow - observedAtWall;
    if (wallAge < 0n || wallAge > BigInt(this.config.ORACLE_PRICE_MAX_AGE_SECONDS)) throw new Error("market snapshot is stale");
    const versionConfig = contractConfigForVersion(this.config, version);
    const id = marketId(row.symbol);
    const current = await readOraclePrice(this.rpc, versionConfig.FLOAT_ORACLE_ADDRESS as Address, id);
    // Convert backend wall time into chain time before signing, or a clock lead
    // makes the oracle reject a valid fresh pool snapshot as InvalidTimestamp.
    const chainNow = (await this.publicClient.getBlock({ blockTag: "latest" })).timestamp;
    const observedAt = snapshotTimeOnChain(row.observed_at, wallNow, chainNow);
    if (observedAt > chainNow || chainNow - observedAt > BigInt(this.config.ORACLE_PRICE_MAX_AGE_SECONDS)) {
      throw new Error("market snapshot is stale relative to chain time");
    }
    const poolTwapE18 = decimalToE18(row.twap_price_usdg);
    const poolSpotE18 = decimalToE18(row.spot_price_usdg);
    // While the underlying is closed, hold the mark inside the weekend band so
    // a thin-liquidity wick cannot move PnL or trigger liquidations.
    const marks = await bandedOracleMarks(this.weekendBands, row.symbol, poolTwapE18, poolSpotE18);
    if (marks.clamped) console.log(JSON.stringify({ event: "oracle_mark_clamped_to_weekend_band", version, market: row.symbol }));
    // A move beyond the contract's jump guard is only walked once it is
    // expected (a split near its ex-date) or has persisted; a brief spike is
    // still quarantined by the guard.
    const catchUpKey = `${version}:${row.symbol}`;
    let twapPriceE18 = marks.twapE18;
    let spotPriceE18 = marks.spotE18;
    let stepping = false;
    const catchUp = oracleCatchUp(current.priceE18, marks.twapE18, marks.spotE18, BigInt(this.config.ORACLE_STEP_BPS));
    if (catchUp.stepping) {
      const firstSeen = this.divergenceSince.get(catchUpKey) ?? new Date();
      this.divergenceSince.set(catchUpKey, firstSeen);
      const persisted = (Date.now() - firstSeen.getTime()) / 1_000 >= this.config.ORACLE_STEP_AFTER_SECONDS;
      if (persisted || await splitNear(this.database, row.symbol, new Date())) {
        ({ twapE18: twapPriceE18, spotE18: spotPriceE18 } = catchUp);
        stepping = true;
        console.log(JSON.stringify({ event: "oracle_catch_up_step", version, market: row.symbol }));
      }
    } else {
      this.divergenceSince.delete(catchUpKey);
    }
    const nextCircuitBroken = circuitBroken(twapPriceE18, spotPriceE18);
    // On-demand calls are still rate-limited by oracle freshness. A newer pool
    // sample alone does not justify a gas transaction; publish on first use,
    // when the mark approaches expiry, or when the circuit-breaker state flips.
    if (!oraclePublishRequired({
      sequence: current.sequence,
      currentTimestamp: current.timestamp,
      chainNow,
      currentCircuitBroken: current.circuitBroken,
      nextCircuitBroken
    }) && !stepping) return;
    const attestation: PriceAttestation = {
      marketId: id,
      priceE18: twapPriceE18,
      spotPriceE18,
      confidenceBps: MAX_CONFIDENCE_BPS,
      timestamp: observedAt,
      sequence: current.sequence + 1n,
      expiry: chainNow + ATTESTATION_TTL_SECONDS
    };
    const signature = await signPriceAttestation(this.config.ORACLE_SIGNER_PRIVATE_KEY as Hex, versionConfig.FLOAT_ORACLE_ADDRESS as Address, attestation);
    const hash = await this.wallet.writeContract({ address: versionConfig.FLOAT_ORACLE_ADDRESS as Address, abi: oracleAbi, functionName: "publish", args: [{ ...attestation }, signature] });
    await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(JSON.stringify({ event: "oracle_attestation_published", version, market: row.symbol, transaction_hash: hash, reason: onDemand ? "on_demand_quote" : "scheduled_refresh" }));
  }
}
