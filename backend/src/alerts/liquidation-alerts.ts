import type { Pool } from "pg";
import { createPublicClient, defineChain, http, parseAbiItem, type Address } from "viem";
import { contractConfigForVersion, type AppConfig, type ContractVersion } from "../config";
import { sendLiquidationNotice } from "../routes/email-alerts";
import { marketId } from "../chain/protocol";

const versions: ContractVersion[] = ["jaguar", "goldlake", "silverlake", "amber", "jasper", "meadow", "legacy-orion"];
const liquidated = parseAbiItem("event PositionLiquidated(address indexed trader, bytes32 indexed marketId, uint256 priceE18, int256 pnlUsdg, uint256 penaltyUsdg, address liquidator)");
const maxLogSpan = 5_000n;
const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } });

export class LiquidationAlertService {
  private readonly client;
  constructor(private readonly database: Pool, private readonly config: AppConfig) {
    this.client = createPublicClient({ chain: { ...chain, rpcUrls: { default: { http: [config.RHC_RPC_URL] } } }, transport: http(config.RHC_RPC_URL) });
  }

  async runOnce(): Promise<void> {
    if (!this.config.RESEND_API_KEY && !this.config.TELEGRAM_BOT_TOKEN) return;
    const latest = await this.client.getBlockNumber();
    const through = latest > 0n ? latest - 1n : 0n; // wait one block before notifying
    for (const version of versions) {
      let clearingHouse: Address;
      try { clearingHouse = contractConfigForVersion(this.config, version).FLOAT_CLEARING_HOUSE_ADDRESS as Address; }
      catch { continue; }
      try {
        const row = await this.database.query<{ next_block: string }>(
          "SELECT next_block FROM public.liquidation_alert_cursors WHERE contract_version=$1", [version]
        );
        if (!row.rows[0]) {
          // New subscriptions receive future liquidation events only; do not replay historical logs.
          const start = through + 1n;
          await this.database.query("INSERT INTO public.liquidation_alert_cursors(contract_version,next_block) VALUES($1,$2) ON CONFLICT DO NOTHING", [version, start.toString()]);
        }
        const current = await this.database.query<{ next_block: string }>(
          "SELECT next_block FROM public.liquidation_alert_cursors WHERE contract_version=$1", [version]
        );
        let from = BigInt(current.rows[0]!.next_block);
        while (from <= through) {
          const to = from + maxLogSpan - 1n < through ? from + maxLogSpan - 1n : through;
          const logs = await this.client.getLogs({ address: clearingHouse, event: liquidated, fromBlock: from, toBlock: to });
          for (const log of logs) {
            if (!log.args.trader || !log.args.marketId || log.args.priceE18 === undefined || !log.transactionHash || log.blockNumber === null || log.logIndex === null) continue;
            const eventKey = `${version}:${log.transactionHash.toLowerCase()}:${log.logIndex}`;
            await this.database.query(
              `INSERT INTO public.liquidation_alert_events(event_key,contract_version,trader,market_id,price_e18,transaction_hash,log_index,block_number)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(event_key) DO NOTHING`,
              [eventKey, version, log.args.trader.toLowerCase(), log.args.marketId.toLowerCase(), log.args.priceE18.toString(), log.transactionHash, log.logIndex, log.blockNumber.toString()]
            );
          }
          from = to + 1n;
          await this.database.query(
            `INSERT INTO public.liquidation_alert_cursors(contract_version,next_block,updated_at) VALUES($1,$2,now())
             ON CONFLICT(contract_version) DO UPDATE SET next_block=EXCLUDED.next_block,updated_at=now()`,
            [version, from.toString()]
          );
        }
      } catch (error) {
        console.error(JSON.stringify({ event: "liquidation_alert_scan_failed", version, error: error instanceof Error ? error.message : "unknown" }));
      }
    }

    const pending = await this.database.query<{
      event_key: string; contract_version: string; trader: string; market_id: string;
      price_e18: string; transaction_hash: string;
    }>("SELECT event_key,contract_version,trader,market_id,price_e18,transaction_hash FROM public.liquidation_alert_events WHERE sent_at IS NULL ORDER BY block_number,log_index LIMIT 100");
    for (const event of pending.rows) {
      try {
        const market = await this.database.query<{ symbol: string }>("SELECT symbol FROM public.markets");
        const symbol = market.rows.find((row) => marketId(row.symbol).toLowerCase() === event.market_id.toLowerCase())?.symbol ?? "market";
        await sendLiquidationNotice(this.database, this.config, {
          eventKey: event.event_key, version: event.contract_version, trader: event.trader,
          market: symbol, priceE18: event.price_e18, transactionHash: event.transaction_hash
        });
        await this.database.query("UPDATE public.liquidation_alert_events SET sent_at=now() WHERE event_key=$1", [event.event_key]);
      } catch (error) {
        console.error(JSON.stringify({ event: "liquidation_notification_delivery_failed", event_key: event.event_key, error: error instanceof Error ? error.message : "unknown" }));
      }
    }
  }
}
