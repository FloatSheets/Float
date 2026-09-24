import type { Pool } from "pg";
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";

import type { AppConfig } from "../config";
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
  private readonly published = new Map<string, string>();

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
    for (const row of rows) {
      if (!row.observed_at || !row.twap_price_usdg || !row.spot_price_usdg) continue;
      if ((Date.now() - row.observed_at.getTime()) / 1000 > this.config.ORACLE_PRICE_MAX_AGE_SECONDS) continue;
      const id = marketId(row.symbol);
      const observedKey = row.observed_at.toISOString();
      if (this.published.get(row.symbol) === observedKey) continue;
      try {
        const current = await readOraclePrice(this.rpc, this.config.FLOAT_ORACLE_ADDRESS as Address, id);
        const now = BigInt(Math.floor(Date.now() / 1000));
        const twapPriceE18 = decimalToE18(row.twap_price_usdg);
        const spotPriceE18 = decimalToE18(row.spot_price_usdg);
        const breakerChanged = current.sequence !== 0n && current.circuitBroken !== circuitBroken(twapPriceE18, spotPriceE18);
        if (!breakerChanged && current.sequence !== 0n && now < current.timestamp + ATTESTATION_TTL_SECONDS - PUBLISH_SAFETY_WINDOW_SECONDS) continue;
        const attestation: PriceAttestation = {
          marketId: id,
          priceE18: twapPriceE18,
          spotPriceE18,
          confidenceBps: MAX_CONFIDENCE_BPS,
          timestamp: BigInt(Math.floor(row.observed_at.getTime() / 1000)),
          sequence: current.sequence + 1n,
          expiry: now + ATTESTATION_TTL_SECONDS
        };
        const signature = await signPriceAttestation(this.config.ORACLE_SIGNER_PRIVATE_KEY as Hex, this.config.FLOAT_ORACLE_ADDRESS as Address, attestation);
        const hash = await this.wallet.writeContract({ address: this.config.FLOAT_ORACLE_ADDRESS as Address, abi: oracleAbi, functionName: "publish", args: [{ ...attestation }, signature] });
        await this.publicClient.waitForTransactionReceipt({ hash });
        this.published.set(row.symbol, observedKey);
        console.log(JSON.stringify({ event: "oracle_attestation_published", market: row.symbol, transaction_hash: hash }));
      } catch (error) {
        console.error(JSON.stringify({ event: "oracle_attestation_failed", market: row.symbol, error: error instanceof Error ? error.message : String(error) }));
      }
    }
  }
}
