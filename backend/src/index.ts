import "dotenv/config";

import { app, setRateLimitDatabase } from "./app";
import { createRpcTransport } from "./chain/rpc";
import { contractConfigForVersion, isGoldlakeConfigured, isSilverlakeConfigured, loadConfig } from "./config";
import { db } from "./db";
import { migrate } from "./db/migrate";
import { HaltMonitor } from "./markets/halts";
import { weekendBandOptions } from "./markets/weekend-bands";
import { openingBellOptions } from "./markets/opening-bell";
import { CorporateActionMonitor, corporateActionOptions } from "./markets/corporate-actions";
import { MarketMonitor } from "./markets/monitor";
import { createMarketsRouter } from "./routes/markets";
import { createReadinessRouter } from "./routes/ready";
import { createProtocolRouter } from "./routes/protocol";
import { createProtocolTransactionsRouter } from "./routes/protocol-transactions";
import { effectiveOraclePublishIntervalSeconds, OraclePublisher } from "./oracle/publisher";
import { createKeeperChain, PositionKeeper } from "./keeper/keeper";
import { createKeeperRouter } from "./routes/keeper";
import { createStatusRouter } from "./routes/status";
import { createSolvencyRouter } from "./routes/solvency";
import { SolvencyReader } from "./solvency/solvency";
import { StatusMonitor } from "./status/status";
import { createEmailAlertsRouter } from "./routes/email-alerts";
import { LiquidationAlertService } from "./alerts/liquidation-alerts";
import { TelegramBotService } from "./alerts/telegram-bot";
import { createTelegramAlertsRouter } from "./routes/telegram-alerts";
import { createNewsRouter } from "./routes/news";

const config = loadConfig();
const meadowConfig = contractConfigForVersion(config, "meadow");
const jasperConfig = contractConfigForVersion(config, "jasper");
const goldlakeConfig = isGoldlakeConfigured(config) ? contractConfigForVersion(config, "goldlake") : null;
const silverlakeConfig = isSilverlakeConfigured(config) ? contractConfigForVersion(config, "silverlake") : null;
const amberConfig = contractConfigForVersion(config, "amber");
const legacyConfig = contractConfigForVersion(config, "legacy-orion");
const port = Number(process.env.PORT ?? 3001);
const rpc = createRpcTransport(config.RHC_RPC_URL);

await migrate();
setRateLimitDatabase(db);
const monitor = new MarketMonitor(db, rpc, Math.min(config.UNISWAP_TWAP_WINDOW_SECONDS, 300));
const oraclePublisher = new OraclePublisher(db, rpc, config);
const keeper = new PositionKeeper(db, createKeeperChain(config, rpc), config);
const liquidationAlerts = new LiquidationAlertService(db, config);
const telegramBot = new TelegramBotService(db, config);
app.use("/v1/markets", createMarketsRouter(db, config.ORACLE_PRICE_MAX_AGE_SECONDS, {
  ...(goldlakeConfig ? { goldlake: { rpc, clearingHouse: goldlakeConfig.FLOAT_CLEARING_HOUSE_ADDRESS as `0x${string}`, oracle: goldlakeConfig.FLOAT_ORACLE_ADDRESS as `0x${string}` } } : {}),
  ...(silverlakeConfig ? { silverlake: { rpc, clearingHouse: silverlakeConfig.FLOAT_CLEARING_HOUSE_ADDRESS as `0x${string}`, oracle: silverlakeConfig.FLOAT_ORACLE_ADDRESS as `0x${string}` } } : {}),
  amber: { rpc, clearingHouse: amberConfig.FLOAT_CLEARING_HOUSE_ADDRESS as `0x${string}`, oracle: amberConfig.FLOAT_ORACLE_ADDRESS as `0x${string}` },
  jasper: { rpc, clearingHouse: jasperConfig.FLOAT_CLEARING_HOUSE_ADDRESS as `0x${string}`, oracle: jasperConfig.FLOAT_ORACLE_ADDRESS as `0x${string}` },
  meadow: { rpc, clearingHouse: meadowConfig.FLOAT_CLEARING_HOUSE_ADDRESS as `0x${string}`, oracle: meadowConfig.FLOAT_ORACLE_ADDRESS as `0x${string}` },
  "legacy-orion": { rpc, clearingHouse: legacyConfig.FLOAT_CLEARING_HOUSE_ADDRESS as `0x${string}`, oracle: legacyConfig.FLOAT_ORACLE_ADDRESS as `0x${string}` }
}, weekendBandOptions(config), openingBellOptions(config), corporateActionOptions(config)));
app.use("/ready", createReadinessRouter(db));
app.use("/v1/keeper", createKeeperRouter(keeper));
const statusOracle = (goldlakeConfig ?? silverlakeConfig ?? amberConfig).FLOAT_ORACLE_ADDRESS as `0x${string}`;
const statusMonitor = new StatusMonitor(db, {
  rpc,
  oracle: statusOracle,
  marketPollIntervalMs: config.MARKET_POLL_INTERVAL_MS,
  keeperIntervalSeconds: config.KEEPER_INTERVAL_SECONDS,
  keeperEnabled: config.KEEPER_ENABLED === "true",
  haltFeedEnabled: config.HALT_FEED_ENABLED === "true",
  haltPollSeconds: config.HALT_POLL_INTERVAL_SECONDS,
  corporateActions: corporateActionOptions(config),
  corporateActionPollSeconds: config.CORPORATE_ACTIONS_POLL_SECONDS,
  keeperStatus: () => keeper.status()
});
app.use("/v1/status", createStatusRouter(statusMonitor, config, db));
// Solvency reports the current default deployment's contracts.
const solvencyConfig = goldlakeConfig ?? silverlakeConfig ?? amberConfig;
app.use("/v1/solvency", createSolvencyRouter(new SolvencyReader(db, rpc, {
  usdg: config.USDG_ADDRESS as `0x${string}`,
  vault: solvencyConfig.FLOAT_VAULT_ADDRESS as `0x${string}`,
  clearingHouse: solvencyConfig.FLOAT_CLEARING_HOUSE_ADDRESS as `0x${string}`,
  oracle: solvencyConfig.FLOAT_ORACLE_ADDRESS as `0x${string}`
})));
app.use("/v1/email-alerts", createEmailAlertsRouter(db, config));
app.use("/v1/telegram-alerts", createTelegramAlertsRouter(db, config));
app.use("/v1/news", createNewsRouter(db));
app.use("/v1/protocol", createProtocolRouter(config));
app.use("/v1/protocol/transactions", createProtocolTransactionsRouter(config, db, rpc, oraclePublisher));
let lastOraclePublishAt = 0;
let lastKeeperRunAt = 0;
let lastLiquidationAlertsRunAt = 0;

let refreshing = false;

async function refreshMarkets(): Promise<void> {
  // A slow tick must not overlap the next one: the publisher and keeper may
  // share a wallet, and concurrent sends would race for its nonce.
  if (refreshing) return;
  refreshing = true;
  try {
    await monitor.refreshAll();
    if (Date.now() - lastOraclePublishAt >= effectiveOraclePublishIntervalSeconds(config.ORACLE_PUBLISH_INTERVAL_SECONDS) * 1_000) {
      lastOraclePublishAt = Date.now();
      await oraclePublisher.publishFreshMarkets();
    }
    console.log("FloatSheets market snapshots refreshed");
  } catch (error) {
    console.error("FloatSheets market refresh failed", error);
  }
  // Closing unsafe positions must not depend on pool sampling succeeding.
  try {
    if (config.KEEPER_ENABLED === "true" && Date.now() - lastKeeperRunAt >= config.KEEPER_INTERVAL_SECONDS * 1_000) {
      lastKeeperRunAt = Date.now();
      await keeper.runOnce();
    }
  } catch (error) {
    console.error("FloatSheets keeper run failed", error);
  }
  try {
    if ((config.RESEND_API_KEY || config.TELEGRAM_BOT_TOKEN) && Date.now() - lastLiquidationAlertsRunAt >= 15_000) {
      lastLiquidationAlertsRunAt = Date.now();
      await liquidationAlerts.runOnce();
    }
  } catch (error) {
    console.error("FloatSheets liquidation alert scan failed", error);
  } finally {
    refreshing = false;
  }
}

// Exchange halts are independent of the chain wallet, so they poll on their own
// timer and keep updating even while a slow market refresh is in progress.
const haltMonitor = new HaltMonitor(db, config.HALT_FEED_URL);
let refreshingHalts = false;
async function refreshHalts(): Promise<void> {
  if (config.HALT_FEED_ENABLED !== "true" || refreshingHalts) return;
  refreshingHalts = true;
  try {
    await haltMonitor.refresh();
  } catch (error) {
    console.error("FloatSheets halt refresh failed", error);
  } finally {
    refreshingHalts = false;
  }
}

// Split and dividend calendars change daily at most; poll hourly.
const corporateActionMonitor = new CorporateActionMonitor(db);
async function refreshCorporateActions(): Promise<void> {
  if (config.CORPORATE_ACTIONS_ENABLED !== "true") return;
  try {
    await corporateActionMonitor.refresh();
  } catch (error) {
    console.error("FloatSheets corporate action refresh failed", error);
  }
}

app.listen(port, () => {
  console.log(`FloatSheets API listening on :${port}`);
  void refreshMarkets();
  void refreshHalts();
  void refreshCorporateActions();
  void telegramBot.pollOnce();
});

setInterval(() => void refreshMarkets(), config.MARKET_POLL_INTERVAL_MS).unref();
setInterval(() => void refreshHalts(), config.HALT_POLL_INTERVAL_SECONDS * 1_000).unref();
if (config.TELEGRAM_BOT_TOKEN) setInterval(() => void telegramBot.pollOnce(), 5_000).unref();
setInterval(() => void refreshCorporateActions(), config.CORPORATE_ACTIONS_POLL_SECONDS * 1_000).unref();
// Status checks start after the first market and feed refreshes have had time to run.
setTimeout(() => {
  const refreshStatus = () => void statusMonitor.refresh().catch((error) => console.error("FloatSheets status refresh failed", error));
  refreshStatus();
  setInterval(refreshStatus, config.STATUS_CHECK_INTERVAL_SECONDS * 1_000).unref();
}, 90_000).unref();
