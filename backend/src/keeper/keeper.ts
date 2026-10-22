import type { Pool } from "pg";
import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, defineChain, http, parseAbi, parseAbiItem,
  type Address, type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { contractConfigForVersion, isGoldlakeConfigured, isSilverlakeConfigured, type AppConfig, type ContractVersion } from "../config";
import { marketId } from "../chain/protocol";
import { readClearingPosition, readPayoutBalances } from "../chain/protocol-read";
import type { RpcTransport } from "../chain/rpc";
import { safeErrorMessage } from "../safe-error";

/** Matches FloatClearingHouse.MAX_POSITION_DURATION. */
export const MAX_POSITION_DURATION_SECONDS = 7n * 24n * 60n * 60n;
/** Robinhood Chain rejects eth_getLogs spans above 10M blocks. */
const MAX_LOG_SPAN = 5_000_000n;
const MIN_LOG_SPAN = 10_000n;
const RECENT_ACTION_LIMIT = 10;

/**
 * First blocks to scan per deployment. Goldlake, Silverlake, Amber and Jasper
 * come from contracts/deployments; Meadow and Legacy Orion are their earliest logs.
 */
export const KEEPER_START_BLOCKS: Record<ContractVersion, bigint> = {
  goldlake: 94_807_521n,
  silverlake: 94_764_216n,
  amber: 94_624_581n,
  jasper: 94_292_113n,
  meadow: 94_228_589n,
  "legacy-orion": 70_685_321n
};

const tradeExecuted = parseAbiItem(
  "event TradeExecuted(address indexed trader, bytes32 indexed marketId, int256 sizeDeltaE18, uint256 executionPriceE18, uint256 feeUsdg)"
);
const liquidateAbi = parseAbi(["function liquidate(address trader,bytes32 marketId)"]);

export type TradeLog = { trader: Address; marketId: Hex; blockNumber: bigint };
export type SimulationResult = { ok: true } | { ok: false; reason: string };

/** Chain access the keeper needs. Injected so the decision logic is testable. */
export interface KeeperChain {
  readonly address: Address;
  latestBlock(): Promise<{ number: bigint; timestamp: bigint }>;
  tradeLogs(clearingHouse: Address, fromBlock: bigint, toBlock: bigint): Promise<TradeLog[]>;
  /** Returns null when the deployment's position layout cannot be decoded. */
  position(clearingHouse: Address, trader: Address, marketId: Hex): Promise<{ sizeE18: bigint; openedAt: bigint } | null>;
  simulateLiquidation(clearingHouse: Address, trader: Address, marketId: Hex): Promise<SimulationResult>;
  /** Sends the liquidation and waits for it. Throws if the transaction reverts. */
  liquidate(clearingHouse: Address, trader: Address, marketId: Hex): Promise<Hex>;
  claimableRewards(clearingHouse: Address): Promise<bigint>;
}

export type KeeperStatus = {
  enabled: boolean;
  keeper_address: Address;
  interval_seconds: number;
  last_run_started_at: string | null;
  last_run_finished_at: string | null;
  last_error: string | null;
  claimable_rewards_usdg: string | null;
  totals: { liquidations: number; expiries: number; failed: number };
  deployments: { contract_version: ContractVersion; scanned_through_block: string | null; tracked_positions: number }[];
  recent_actions: {
    contract_version: string; trader: string; market_id: string; market: string | null; reason: string;
    status: string; transaction_hash: string | null; created_at: string;
  }[];
};

function revertName(error: unknown): string {
  if (error instanceof BaseError) {
    const revert = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) return revert.data?.errorName ?? revert.reason ?? "reverted";
  }
  return safeErrorMessage(error);
}

const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } }
});

const clearingErrors = parseAbi([
  "error PositionNotLiquidatable()", "error StaleOraclePrice()", "error OracleConfidenceTooLow()", "error Reentrant()"
]);

export function createKeeperChain(config: AppConfig, rpc: RpcTransport): KeeperChain {
  const account = privateKeyToAccount((config.KEEPER_PRIVATE_KEY ?? config.ORACLE_PUBLISHER_PRIVATE_KEY) as Hex);
  const chain = { ...robinhoodChain, rpcUrls: { default: { http: [config.RHC_RPC_URL] } } };
  const publicClient = createPublicClient({ chain, transport: http(config.RHC_RPC_URL) });
  const wallet = createWalletClient({ account, chain, transport: http(config.RHC_RPC_URL) });
  const abi = [...liquidateAbi, ...clearingErrors];
  return {
    address: account.address,
    async latestBlock() {
      const block = await publicClient.getBlock({ blockTag: "latest" });
      return { number: block.number, timestamp: block.timestamp };
    },
    async tradeLogs(clearingHouse, fromBlock, toBlock) {
      const logs = await publicClient.getLogs({ address: clearingHouse, event: tradeExecuted, fromBlock, toBlock });
      return logs.flatMap((log) => log.args.trader && log.args.marketId && log.blockNumber !== null
        ? [{ trader: log.args.trader, marketId: log.args.marketId, blockNumber: log.blockNumber }]
        : []);
    },
    async position(clearingHouse, trader, marketId) {
      try {
        const position = await readClearingPosition(rpc, clearingHouse, trader, marketId);
        return { sizeE18: position.sizeE18, openedAt: position.openedAt };
      } catch {
        return null;
      }
    },
    async simulateLiquidation(clearingHouse, trader, marketId) {
      try {
        await publicClient.simulateContract({ account, address: clearingHouse, abi, functionName: "liquidate", args: [trader, marketId] });
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: revertName(error) };
      }
    },
    async liquidate(clearingHouse, trader, marketId) {
      const hash = await wallet.writeContract({ address: clearingHouse, abi, functionName: "liquidate", args: [trader, marketId] });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`liquidation ${hash} reverted`);
      return hash;
    },
    async claimableRewards(clearingHouse) {
      return (await readPayoutBalances(rpc, clearingHouse, account.address)).claimableBalance;
    }
  };
}

/**
 * Closes positions the clearing house already allows anyone to close: those
 * below maintenance margin and those past the seven-day duration. Running it
 * ourselves keeps bad debt from waiting on third-party bots and keeps the
 * keeper reward with the protocol.
 */
export class PositionKeeper {
  private lastRunStartedAt: Date | null = null;
  private lastRunFinishedAt: Date | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly database: Pool,
    private readonly chain: KeeperChain,
    private readonly config: AppConfig
  ) {}

  private versions(): ContractVersion[] {
    const all: ContractVersion[] = ["goldlake", "silverlake", "amber", "jasper", "meadow", "legacy-orion"];
    return all.filter((version) => {
      if (version === "goldlake" && !isGoldlakeConfigured(this.config)) return false;
      if (version === "silverlake" && !isSilverlakeConfigured(this.config)) return false;
      try {
        contractConfigForVersion(this.config, version);
        return true;
      } catch {
        return false;
      }
    });
  }

  private clearingHouse(version: ContractVersion): Address {
    return contractConfigForVersion(this.config, version).FLOAT_CLEARING_HOUSE_ADDRESS as Address;
  }

  async runOnce(): Promise<void> {
    this.lastRunStartedAt = new Date();
    const errors: string[] = [];
    const latest = await this.chain.latestBlock();
    for (const version of this.versions()) {
      try {
        await this.discoverPositions(version, latest.number);
        await this.closeEligiblePositions(version, latest.timestamp);
      } catch (error) {
        const message = safeErrorMessage(error);
        errors.push(`${version}: ${message}`);
        console.error(JSON.stringify({ event: "keeper_run_failed", version, error: message }));
      }
    }
    this.lastError = errors.length ? errors.join("; ") : null;
    this.lastRunFinishedAt = new Date();
  }

  private async discoverPositions(version: ContractVersion, latestBlock: bigint): Promise<void> {
    const cursor = await this.database.query<{ next_block: string }>(
      "SELECT next_block FROM public.keeper_cursors WHERE contract_version=$1", [version]
    );
    let from = cursor.rows[0] ? BigInt(cursor.rows[0].next_block) : KEEPER_START_BLOCKS[version];
    if (from > latestBlock + 1n) {
      // A cursor past the chain head cannot be real (for example, written by a
      // test against the wrong database) and would hide every new position.
      console.warn(JSON.stringify({ event: "keeper_cursor_reset", version, cursor: from.toString(), chain_head: latestBlock.toString() }));
      from = KEEPER_START_BLOCKS[version];
    }
    let span = MAX_LOG_SPAN;
    const clearingHouse = this.clearingHouse(version);
    while (from <= latestBlock) {
      const to = from + span - 1n < latestBlock ? from + span - 1n : latestBlock;
      let logs: TradeLog[];
      try {
        logs = await this.chain.tradeLogs(clearingHouse, from, to);
      } catch (error) {
        // Providers also cap response size; retry a dense range in halves.
        if (span <= MIN_LOG_SPAN) throw error;
        span /= 2n;
        continue;
      }
      for (const log of logs) {
        await this.database.query(
          `INSERT INTO public.keeper_positions (contract_version, trader, market_id, first_seen_block)
           VALUES ($1,$2,$3,$4) ON CONFLICT (contract_version, trader, market_id) DO NOTHING`,
          [version, log.trader.toLowerCase(), log.marketId.toLowerCase(), log.blockNumber.toString()]
        );
      }
      from = to + 1n;
      await this.database.query(
        `INSERT INTO public.keeper_cursors (contract_version, next_block, updated_at) VALUES ($1,$2,now())
         ON CONFLICT (contract_version) DO UPDATE SET next_block=EXCLUDED.next_block, updated_at=now()`,
        [version, from.toString()]
      );
    }
  }

  private async closeEligiblePositions(version: ContractVersion, chainNow: bigint): Promise<void> {
    const clearingHouse = this.clearingHouse(version);
    const { rows } = await this.database.query<{ trader: Address; market_id: Hex }>(
      "SELECT trader, market_id FROM public.keeper_positions WHERE contract_version=$1 ORDER BY first_seen_block", [version]
    );
    for (const row of rows) {
      const position = await this.chain.position(clearingHouse, row.trader, row.market_id);
      if (position && position.sizeE18 === 0n) {
        await this.forget(version, row.trader, row.market_id);
        continue;
      }
      const simulation = await this.chain.simulateLiquidation(clearingHouse, row.trader, row.market_id);
      await this.database.query(
        "UPDATE public.keeper_positions SET last_checked_at=now() WHERE contract_version=$1 AND trader=$2 AND market_id=$3",
        [version, row.trader, row.market_id]
      );
      if (!simulation.ok) {
        // A healthy position is the normal case. Anything else (for example a
        // stale oracle) means a position may be stuck, so surface it.
        if (simulation.reason !== "PositionNotLiquidatable") {
          console.warn(JSON.stringify({ event: "keeper_close_blocked", version, trader: row.trader, market_id: row.market_id, reason: simulation.reason }));
        }
        continue;
      }
      const expired = position !== null && position.openedAt !== 0n && chainNow >= position.openedAt + MAX_POSITION_DURATION_SECONDS;
      const reason = expired ? "expiry" : "liquidation";
      // Back off after a failed send (for example, an unfunded keeper wallet)
      // instead of logging a new failure every run.
      const recentFailure = await this.database.query(
        `SELECT 1 FROM public.keeper_actions WHERE contract_version=$1 AND trader=$2 AND market_id=$3
         AND status='failed' AND created_at > now() - interval '5 minutes' LIMIT 1`,
        [version, row.trader, row.market_id]
      );
      if (recentFailure.rowCount) continue;
      try {
        const hash = await this.chain.liquidate(clearingHouse, row.trader, row.market_id);
        await this.record(version, row.trader, row.market_id, reason, "confirmed", hash, null);
        await this.forget(version, row.trader, row.market_id);
        console.log(JSON.stringify({ event: "keeper_position_closed", version, reason, trader: row.trader, market_id: row.market_id, transaction_hash: hash }));
      } catch (error) {
        const message = safeErrorMessage(error);
        await this.record(version, row.trader, row.market_id, reason, "failed", null, message);
        console.error(JSON.stringify({ event: "keeper_close_failed", version, reason, trader: row.trader, market_id: row.market_id, error: message }));
      }
    }
  }

  private async forget(version: ContractVersion, trader: string, marketId: string): Promise<void> {
    await this.database.query(
      "DELETE FROM public.keeper_positions WHERE contract_version=$1 AND trader=$2 AND market_id=$3", [version, trader, marketId]
    );
  }

  private async record(
    version: ContractVersion, trader: string, marketId: string, reason: "liquidation" | "expiry",
    status: "confirmed" | "failed", hash: Hex | null, error: string | null
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO public.keeper_actions (contract_version, trader, market_id, reason, transaction_hash, status, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [version, trader, marketId, reason, hash, status, error]
    );
  }

  async status(): Promise<KeeperStatus> {
    const [cursors, tracked, totals, recent, markets] = await Promise.all([
      this.database.query<{ contract_version: ContractVersion; next_block: string }>("SELECT contract_version, next_block FROM public.keeper_cursors"),
      this.database.query<{ contract_version: ContractVersion; count: string }>("SELECT contract_version, count(*)::text FROM public.keeper_positions GROUP BY contract_version"),
      this.database.query<{ reason: string; status: string; count: string }>("SELECT reason, status, count(*)::text FROM public.keeper_actions GROUP BY reason, status"),
      this.database.query<Omit<KeeperStatus["recent_actions"][number], "market" | "created_at"> & { created_at: Date }>(
        `SELECT contract_version, trader, market_id, reason, status, transaction_hash, created_at
         FROM public.keeper_actions ORDER BY created_at DESC LIMIT ${RECENT_ACTION_LIMIT}`
      ),
      this.database.query<{ symbol: string }>("SELECT symbol FROM public.markets")
    ]);
    const symbols = new Map(markets.rows.map((row) => [marketId(row.symbol).toLowerCase(), row.symbol]));
    const confirmed = (reason: string) => Number(totals.rows.find((row) => row.reason === reason && row.status === "confirmed")?.count ?? 0);
    let claimable: string | null = null;
    // Rewards accrue per clearing house; report the current default deployment.
    const current: ContractVersion | null = isGoldlakeConfigured(this.config) ? "goldlake" : isSilverlakeConfigured(this.config) ? "silverlake" : null;
    if (current) {
      try { claimable = (await this.chain.claimableRewards(this.clearingHouse(current))).toString(); } catch { claimable = null; }
    }
    return {
      enabled: this.config.KEEPER_ENABLED === "true",
      keeper_address: this.chain.address,
      interval_seconds: this.config.KEEPER_INTERVAL_SECONDS,
      last_run_started_at: this.lastRunStartedAt?.toISOString() ?? null,
      last_run_finished_at: this.lastRunFinishedAt?.toISOString() ?? null,
      last_error: this.lastError,
      claimable_rewards_usdg: claimable,
      totals: {
        liquidations: confirmed("liquidation"),
        expiries: confirmed("expiry"),
        failed: totals.rows.filter((row) => row.status === "failed").reduce((sum, row) => sum + Number(row.count), 0)
      },
      deployments: this.versions().map((version) => {
        const cursor = cursors.rows.find((row) => row.contract_version === version);
        return {
          contract_version: version,
          scanned_through_block: cursor ? (BigInt(cursor.next_block) - 1n).toString() : null,
          tracked_positions: Number(tracked.rows.find((row) => row.contract_version === version)?.count ?? 0)
        };
      }),
      recent_actions: recent.rows.map((row) => ({
        ...row, market: symbols.get(row.market_id.toLowerCase()) ?? null, created_at: row.created_at.toISOString()
      }))
    };
  }
}
