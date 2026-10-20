import { db } from "../src/db";
import { createRpcTransport } from "../src/chain/rpc";
import { MarketMonitor } from "../src/markets/monitor";

const rpcUrl = process.env.RHC_RPC_URL;
const twapWindow = Number(process.env.UNISWAP_TWAP_WINDOW_SECONDS);

if (!rpcUrl) throw new Error("RHC_RPC_URL must be set for the CI market refresh");
if (!Number.isInteger(twapWindow) || twapWindow < 60) {
  throw new Error("UNISWAP_TWAP_WINDOW_SECONDS must be at least 60");
}

try {
  await new MarketMonitor(db, createRpcTransport(rpcUrl), twapWindow).refreshSymbol("NVDA");
} finally {
  await db.end();
}
