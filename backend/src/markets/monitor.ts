import type { Pool } from "pg";
import type { Address } from "viem";

import type { RpcTransport } from "../chain/rpc";
import { absoluteDeviationBps, quoteExactInputSingle, readPoolTwap } from "../chain/uniswap-v3";
import { USDG_ADDRESS, USDG_DECIMALS } from "../chain/constants";

const NOTIONALS = [5, 10, 1_000, 10_000, 50_000] as const;
const MAX_SPOT_TWAP_DEVIATION_BPS = 50;

type Market = { id: string; symbol: string; uniswap_v3_pool_address: Address; uniswap_v3_fee_tier: number };

function units(value: number, decimals: number): bigint {
  return BigInt(Math.round(value * 10 ** decimals));
}

function bps(value: number): number {
  return Math.round(value * 10_000);
}

export class MarketMonitor {
  private refreshing = false;
  constructor(private readonly database: Pool, private readonly rpc: RpcTransport, private readonly twapWindowSeconds: number) {}

  async refreshAll(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    const run = await this.database.query<{ id: string }>("INSERT INTO monitor_runs DEFAULT VALUES RETURNING id");
    const runId = run.rows[0]?.id;
    if (!runId) throw new Error("Unable to create monitor run");
    let succeeded = 0;
    const { rows } = await this.database.query<Market>(
      "SELECT id, symbol, uniswap_v3_pool_address, uniswap_v3_fee_tier FROM markets WHERE status != 'disabled' ORDER BY symbol"
    );
    try {
      for (const market of rows) {
        try {
          await this.refreshMarket(market);
          succeeded += 1;
        } catch (error) {
          await this.database.query(
            "INSERT INTO monitor_failures (run_id, market_id, error_message) VALUES ($1,$2,$3)",
            [runId, market.id, error instanceof Error ? error.message : String(error)]
          );
        }
      }
      await this.database.query(
        "UPDATE monitor_runs SET completed_at=now(), status=$2, markets_attempted=$3, markets_succeeded=$4 WHERE id=$1",
        [runId, succeeded === rows.length ? "succeeded" : "partial_failure", rows.length, succeeded]
      );
    } catch (error) {
      await this.database.query(
        "UPDATE monitor_runs SET completed_at=now(), status='failed', markets_attempted=$2, markets_succeeded=$3, error_message=$4 WHERE id=$1",
        [runId, rows.length, succeeded, error instanceof Error ? error.message : String(error)]
      );
      throw error;
    } finally {
      this.refreshing = false;
    }
  }

  private async refreshMarket(market: Market): Promise<void> {
    const twap = await readPoolTwap(this.rpc, market.uniswap_v3_pool_address, this.twapWindowSeconds);
    const observedAt = new Date();
    const spotTwapDeviationBps = absoluteDeviationBps(twap.priceUsdg, twap.spotPriceUsdg);
    await this.database.query<{ id: string }>(
      `INSERT INTO pool_snapshots (market_id, observed_at, sqrt_price_x96, liquidity, usdg_balance, twap_price_usdg, spot_price_usdg, spot_twap_deviation_bps, oracle_tradable)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [market.id, observedAt, twap.sqrtPriceX96.toString(), twap.liquidity.toString(), twap.usdgBalance.toString(), twap.priceUsdg, twap.spotPriceUsdg, spotTwapDeviationBps, spotTwapDeviationBps <= MAX_SPOT_TWAP_DEVIATION_BPS]
    );

    for (const notional of NOTIONALS) {
      const buyOut = await quoteExactInputSingle(
        this.rpc, USDG_ADDRESS, twap.assetAddress, units(notional, USDG_DECIMALS), market.uniswap_v3_fee_tier
      );
      const buyAsset = Number(buyOut) / 10 ** twap.assetDecimals;
      const buyBps = bps(notional / buyAsset / twap.priceUsdg - 1);
      const sellAsset = notional / twap.priceUsdg;
      const sellInput = units(sellAsset, twap.assetDecimals);
      const sellOut = await quoteExactInputSingle(
        this.rpc, twap.assetAddress, USDG_ADDRESS, sellInput, market.uniswap_v3_fee_tier
      );
      const sellUsdg = Number(sellOut) / 10 ** USDG_DECIMALS;
      const sellBps = bps(twap.priceUsdg / (sellUsdg / sellAsset) - 1);
      await this.database.query(
        `INSERT INTO quote_samples (market_id, observed_at, notional_usdg, direction, quoted_output, execution_degradation_bps)
         VALUES ($1,$2,$3,'buy',$4,$5),($1,$2,$3,'sell',$6,$7)`,
        [market.id, observedAt, notional, buyOut.toString(), buyBps, sellOut.toString(), sellBps]
      );
    }
  }
}
