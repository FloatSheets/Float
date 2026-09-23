import "dotenv/config";

import { app } from "./app";
import { createRpcTransport } from "./chain/rpc";
import { loadConfig } from "./config";
import { db } from "./db";
import { migrate } from "./db/migrate";
import { MarketMonitor } from "./markets/monitor";
import { createMarketsRouter } from "./routes/markets";
import { createReadinessRouter } from "./routes/ready";
import { createProtocolRouter } from "./routes/protocol";
import { createProtocolTransactionsRouter } from "./routes/protocol-transactions";
import { OraclePublisher } from "./oracle/publisher";

const config = loadConfig();
const port = Number(process.env.PORT ?? 3001);
const rpc = createRpcTransport(config.RHC_RPC_URL);

await migrate();
app.use("/v1/markets", createMarketsRouter(db, config.ORACLE_PRICE_MAX_AGE_SECONDS));
app.use("/ready", createReadinessRouter(db));
app.use("/v1/protocol", createProtocolRouter(config));
app.use("/v1/protocol/transactions", createProtocolTransactionsRouter(config, db, rpc));

const monitor = new MarketMonitor(db, rpc, config.UNISWAP_TWAP_WINDOW_SECONDS);
const oraclePublisher = new OraclePublisher(db, rpc, config);
let lastOraclePublishAt = 0;

async function refreshMarkets(): Promise<void> {
  try {
    await monitor.refreshAll();
    if (Date.now() - lastOraclePublishAt >= 60_000) {
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
