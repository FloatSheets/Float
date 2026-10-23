import "dotenv/config";

import { Pool } from "pg";
import {
  createPublicClient, decodeEventLog, defineChain, http, parseAbiItem,
  type AbiEvent, type Address, type Hex, type Log
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { contractConfigForVersion, loadConfig, type ContractVersion } from "../src/config";

const config = loadConfig();
const keeperAddress = privateKeyToAccount(
  (config.KEEPER_PRIVATE_KEY ?? config.ORACLE_PUBLISHER_PRIVATE_KEY) as Hex
).address.toLowerCase();
const chain = defineChain({
  id: config.RHC_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.RHC_RPC_URL] } }
});
const client = createPublicClient({ chain, transport: http(config.RHC_RPC_URL) });
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must be configured");
const database = new Pool({
  connectionString: databaseUrl,
  ...(process.argv.includes("--apply") ? {} : { options: "-c default_transaction_read_only=on" })
});

const liquidatedV6 = parseAbiItem(
  "event PositionLiquidated(address indexed trader,bytes32 indexed marketId,uint256 priceE18,int256 pnlUsdg,uint256 penaltyUsdg,address liquidator)"
);
const liquidatedV5 = parseAbiItem(
  "event PositionLiquidated(address indexed trader,bytes32 indexed marketId,uint256 priceE18,int256 pnlUsdg,uint256 penaltyUsdg)"
);
const expiredEvent = parseAbiItem("event PositionExpired(address indexed trader,bytes32 indexed marketId,uint64 openedAt)");

const deployments: Record<ContractVersion, bigint> = {
  jaguar: BigInt(config.JAGUAR_DEPLOYMENT_BLOCK ?? 0),
  goldlake: 94_807_521n,
  silverlake: 94_764_216n,
  amber: 94_624_581n,
  jasper: 94_292_113n,
  meadow: 94_228_589n,
  "legacy-orion": 70_685_321n
};
const versions = Object.keys(deployments) as ContractVersion[];
const apply = process.argv.includes("--apply");

async function scan(
  address: Address,
  event: AbiEvent,
  start: bigint,
  head: bigint
): Promise<Log[]> {
  const all: Log[] = [];
  let from = start;
  let span = 5_000_000n;
  while (from <= head) {
    const to = from + span - 1n < head ? from + span - 1n : head;
    try {
      all.push(...await client.getLogs({ address, event, fromBlock: from, toBlock: to }));
      from = to + 1n;
      span = 5_000_000n;
    } catch (error) {
      if (span <= 10_000n) throw error;
      span /= 2n;
    }
  }
  return all;
}

try {
  const head = await client.getBlockNumber();
  const candidates = new Map<string, {
    version: ContractVersion; trader: string; marketId: string; reason: "liquidation" | "expiry";
    hash: Hex; timestamp: Date;
  }>();
  const observed: Record<string, { confirmed_liquidations: number; current_keeper_liquidations: number }> = {};

  for (const version of versions) {
    const addresses = contractConfigForVersion(config, version);
    const clearingHouse = addresses.FLOAT_CLEARING_HOUSE_ADDRESS as Address;
    const start = deployments[version];
    const liquidationLogs = [
      ...await scan(clearingHouse, liquidatedV6, start, head),
      ...await scan(clearingHouse, liquidatedV5, start, head)
    ];
    const expiredLogs = await scan(clearingHouse, expiredEvent, start, head);
    const expiredHashes = new Set(expiredLogs.flatMap((log) => log.transactionHash ? [log.transactionHash.toLowerCase()] : []));
    observed[version] = { confirmed_liquidations: liquidationLogs.length, current_keeper_liquidations: 0 };

    for (const log of liquidationLogs) {
      if (!log.transactionHash || log.blockNumber === null) continue;
      const tx = await client.getTransaction({ hash: log.transactionHash });
      if (tx.from.toLowerCase() !== keeperAddress) continue;
      observed[version]!.current_keeper_liquidations += 1;
      const receipt = await client.getTransactionReceipt({ hash: log.transactionHash });
      if (receipt.status !== "success") continue;
      const decoded = (() => {
        for (const event of [liquidatedV6, liquidatedV5]) {
          try { return decodeEventLog({ abi: [event], data: log.data, topics: log.topics }); }
          catch { /* Try the other historical event shape. */ }
        }
        return null;
      })();
      if (!decoded) continue;
      const args = decoded.args as { trader: Address; marketId: Hex };
      const block = await client.getBlock({ blockNumber: log.blockNumber });
      const reason = expiredHashes.has(log.transactionHash.toLowerCase()) ? "expiry" : "liquidation";
      const key = `${version}:${log.transactionHash.toLowerCase()}`;
      candidates.set(key, {
        version, trader: args.trader.toLowerCase(), marketId: args.marketId.toLowerCase(),
        reason, hash: log.transactionHash, timestamp: new Date(Number(block.timestamp) * 1_000)
      });
    }
  }

  const rows = [...candidates.values()].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", keeper_address: keeperAddress, observed, matched_confirmed_actions: rows.length, actions: rows }, null, 2));
  if (apply) {
    await database.query("BEGIN");
    try {
      for (const row of rows) {
        await database.query(
          `INSERT INTO public.keeper_actions(contract_version,trader,market_id,reason,transaction_hash,status,error,created_at)
           SELECT $1,$2,$3,$4,$5,'confirmed',NULL,$6
           WHERE NOT EXISTS (
             SELECT 1 FROM public.keeper_actions WHERE contract_version=$1 AND transaction_hash=$5
           )`,
          [row.version, row.trader, row.marketId, row.reason, row.hash, row.timestamp]
        );
      }
      await database.query("COMMIT");
    } catch (error) {
      await database.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await database.end();
}
