import "dotenv/config";

import { app, setRateLimitDatabase } from "./app";
import { createRpcTransport } from "./chain/rpc";
import { contractConfigForVersion, isGoldlakeConfigured, isSilverlakeConfigured, loadConfig } from "./config";
import { db } from "./db";
import { migrate } from "./db/migrate";
import { MarketMonitor } from "./markets/monitor";
import { createMarketsRouter } from "./routes/markets";
import { createReadinessRouter } from "./routes/ready";
import { createProtocolRouter } from "./routes/protocol";
import { createProtocolTransactionsRouter } from "./routes/protocol-transactions";
import { effectiveOraclePublishIntervalSeconds, OraclePublisher } from "./oracle/publisher";

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
app.use("/v1/markets", createMarketsRouter(db, config.ORACLE_PRICE_MAX_AGE_SECONDS, {
  ...(goldlakeConfig ? { goldlake: { rpc, clearingHouse: goldlakeConfig.FLOAT_CLEARING_HOUSE_ADDRESS as `0x${string}`, oracle: goldlakeConfig.FLOAT_ORACLE_ADDRESS as `0x${string}` } } : {}),
  ...(silverlakeConfig ? { silverlake: { rpc, clearingHouse: silverlakeConfig.FLOAT_CLEARING_HOUSE_ADDRESS as `0x${string}`, oracle: silverlakeConfig.FLOAT_ORACLE_ADDRESS as `0x${string}` } } : {}),
  amber: { rpc, clearingHouse: amberConfig.FLOAT_CLEARING_HOUSE_ADDRESS as `0x${string}`, oracle: amberConfig.FLOAT_ORACLE_ADDRESS as `0x${string}` },
  jasper: { rpc, clearingHouse: jasperConfig.FLOAT_CLEARING_HOUSE_ADDRESS as `0x${string}`, oracle: jasperConfig.FLOAT_ORACLE_ADDRESS as `0x${string}` },
  meadow: { rpc, clearingHouse: meadowConfig.FLOAT_CLEARING_HOUSE_ADDRESS as `0x${string}`, oracle: meadowConfig.FLOAT_ORACLE_ADDRESS as `0x${string}` },
  "legacy-orion": { rpc, clearingHouse: legacyConfig.FLOAT_CLEARING_HOUSE_ADDRESS as `0x${string}`, oracle: legacyConfig.FLOAT_ORACLE_ADDRESS as `0x${string}` }
}));
app.use("/ready", createReadinessRouter(db));
app.use("/v1/protocol", createProtocolRouter(config));
app.use("/v1/protocol/transactions", createProtocolTransactionsRouter(config, db, rpc, oraclePublisher));
let lastOraclePublishAt = 0;

async function refreshMarkets(): Promise<void> {
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
}

app.listen(port, () => {
  console.log(`FloatSheets API listening on :${port}`);
  void refreshMarkets();
});

setInterval(() => void refreshMarkets(), config.MARKET_POLL_INTERVAL_MS).unref();
