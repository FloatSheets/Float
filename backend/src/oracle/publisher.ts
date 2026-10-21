import type { Pool } from "pg";
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";

import { contractConfigForVersion, type AppConfig, type ContractVersion } from "../config";
import { safeErrorMessage } from "../safe-error";
import { marketId } from "../chain/protocol";
import type { RpcTransport } from "../chain/rpc";
import { readOraclePrice } from "../chain/protocol-read";
import { signPriceAttestation } from "../signing/signer";
import type { PriceAttestation } from "../signing/types";

const oracleAbi = parseAbi([
  "function publish((bytes32 marketId,uint256 priceE18,uint256 spotPriceE18,uint256 confidenceBps,uint64 timestamp,uint64 sequence,uint64 expiry) attestation,bytes signature)"
]);
const MAX_CONFIDENCE_BPS = 50n;
const ATTESTATION_TTL_SECONDS = 120n;
const PUBLISH_SAFETY_WINDOW_SECONDS = 30n;

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

export class OraclePublisher {
  private readonly wallet;
  private readonly publicClient;
  private readonly refreshing = new Map<string, Promise<void>>();

  constructor(private readonly database: Pool, private readonly rpc: RpcTransport, private readonly config: AppConfig) {
    const account = privateKeyToAccount(config.ORACLE_PUBLISHER_PRIVATE_KEY as Hex);
    this.wallet = createWalletClient({ account, chain: { ...robinhoodChain, rpcUrls: { default: { http: [config.RHC_RPC_URL] } } }, transport: http(config.RHC_RPC_URL) });
    this.publicClient = createPublicClient({ chain: { ...robinhoodChain, rpcUrls: { default: { http: [config.RHC_RPC_URL] } } }, transport: http(config.RHC_RPC_URL) });
  }

  async publishFreshMarkets(): Promise<void> {
    const { rows } = await this.database.query<{ symbol: string; observed_at: Date | null; twap_price_usdg: string | null; spot_price_usdg: string | null }>(
      `SELECT m.symbol,s.observed_at,s.twap_price_usdg,s.spot_price_usdg
       FROM public.markets m LEFT JOIN LATERAL (
         SELECT observed_at,twap_price_usdg,spot_price_usdg FROM public.pool_snapshots WHERE market_id=m.id ORDER BY observed_at DESC LIMIT 1
       ) s ON true WHERE m.status != 'disabled' ORDER BY m.symbol`
    );
    // One publisher wallet serves both contracts. Send in sequence so concurrent
    // writes cannot race for the same account nonce.
    for (const row of rows) for (const version of ["meadow", "legacy-orion"] as const) {
      try {
        await this.publishRow(row, false, version);
      } catch (error) {
        console.error(JSON.stringify({ event: "oracle_attestation_failed", version, market: row.symbol, error: safeErrorMessage(error) }));
      }
    }
  }

  /** Refreshes a market immediately before an API-issued open or close quote. */
  async ensureFreshMarket(symbol: string, version: ContractVersion = "meadow"): Promise<void> {
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
    publishLatestSnapshot: boolean,
    version: ContractVersion
  ): Promise<void> {
    if (!row.observed_at || !row.twap_price_usdg || !row.spot_price_usdg) throw new Error("market has no oracle snapshot");
    if ((Date.now() - row.observed_at.getTime()) / 1_000 > this.config.ORACLE_PRICE_MAX_AGE_SECONDS) throw new Error("market snapshot is stale");
    const versionConfig = contractConfigForVersion(this.config, version);
    const id = marketId(row.symbol);
    const current = await readOraclePrice(this.rpc, versionConfig.FLOAT_ORACLE_ADDRESS as Address, id);
    const now = BigInt(Math.floor(Date.now() / 1_000));
    const observedAt = BigInt(Math.floor(row.observed_at.getTime() / 1_000));
    const twapPriceE18 = decimalToE18(row.twap_price_usdg);
    const spotPriceE18 = decimalToE18(row.spot_price_usdg);
    const breakerChanged = current.sequence !== 0n && current.circuitBroken !== circuitBroken(twapPriceE18, spotPriceE18);
    const renewalDue = current.sequence === 0n || now >= current.timestamp + ATTESTATION_TTL_SECONDS - PUBLISH_SAFETY_WINDOW_SECONDS;
    const hasNewerSnapshot = observedAt > current.timestamp;
    if (!breakerChanged && !renewalDue && (!publishLatestSnapshot || !hasNewerSnapshot)) return;
    const attestation: PriceAttestation = {
      marketId: id,
      priceE18: twapPriceE18,
      spotPriceE18,
      confidenceBps: MAX_CONFIDENCE_BPS,
      timestamp: observedAt,
      sequence: current.sequence + 1n,
      expiry: now + ATTESTATION_TTL_SECONDS
    };
    const signature = await signPriceAttestation(this.config.ORACLE_SIGNER_PRIVATE_KEY as Hex, versionConfig.FLOAT_ORACLE_ADDRESS as Address, attestation);
    const hash = await this.wallet.writeContract({ address: versionConfig.FLOAT_ORACLE_ADDRESS as Address, abi: oracleAbi, functionName: "publish", args: [{ ...attestation }, signature] });
    await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(JSON.stringify({ event: "oracle_attestation_published", version, market: row.symbol, transaction_hash: hash, reason: publishLatestSnapshot ? "quote" : "scheduled_refresh" }));
  }
}
