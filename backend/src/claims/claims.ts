import type { Pool } from "pg";
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";

import { contractConfigForVersion, type AppConfig, type ContractVersion } from "../config";
import {
  claimDeferredPayout, claimProtocolBalance, claimVaultDeposit, claimVaultWithdrawal, marketId, settleVaultQueue,
  withdrawMargin, withdrawVault, type ProtocolTransaction
} from "../chain/protocol";
import type { RpcTransport } from "../chain/rpc";
import { safeErrorMessage } from "../safe-error";

const clearingAbi = parseAbi([
  "function claimableBalance(address) view returns (uint256)",
  "function deferredClaim(address) view returns (uint256)",
  "function pendingPayout(address) view returns (uint256)",
  "function getPosition(address,bytes32) view returns (int256,uint256,uint256,uint64)"
]);
/** Legacy Orion predates position timestamps. */
const legacyPositionAbi = parseAbi(["function getPosition(address,bytes32) view returns (int256,uint256,uint256)"]);
const vaultAbi = parseAbi([
  "function totalAssets() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function lockedWithdrawalShares(address) view returns (uint256)",
  "function queueEpoch() view returns (uint64)",
  "function queueEpochStartedAt() view returns (uint64)",
  "function queueEpochSettled() view returns (bool)",
  "function QUEUE_EPOCH_DURATION() view returns (uint256)",
  "function queuedDepositOf(uint64,address) view returns (uint256)",
  "function queuedWithdrawalOf(uint64,address) view returns (uint256)",
  "function depositClaimed(uint64,address) view returns (bool)",
  "function withdrawalClaimed(uint64,address) view returns (bool)",
  "function queueSettlements(uint64) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)"
]);

/** Deployments in display order: the current one first, then retired ones. */
export const CLAIM_DEPLOYMENTS: { version: ContractVersion; name: string }[] = [
  { version: "goldlake", name: "FloatSheets Goldlake" },
  { version: "copper", name: "FloatSheets Copper" },
  { version: "silverlake", name: "FloatSheets Silverlake" },
  { version: "amber", name: "FloatSheets Amber" },
  { version: "jasper", name: "FloatSheets Jasper" },
  { version: "meadow", name: "FloatSheets Meadow" },
  { version: "legacy-orion", name: "FloatSheets Legacy Orion" }
];
/** How many recent LP epochs to scan for unclaimed requests. */
const EPOCH_LOOKBACK = 10n;
const VIRTUAL_SHARES = 1_000_000n;

export type ClaimKind = "claim_balance" | "claim_deferred" | "withdraw_margin" | "close_position" | "settle_epoch" | "claim_lp_deposit" | "claim_lp_withdrawal" | "queue_lp_withdrawal";

export type ClaimItem = {
  kind: ClaimKind;
  title: string;
  detail: string;
  amount_usdg: string | null;
  market: string | null;
  /** Ready-to-sign transaction, or null when the dashboard must request a fresh quote (closing a position). */
  transaction: (ProtocolTransaction & { activity: string; market?: string }) | null;
};

export type DeploymentClaims = {
  version: ContractVersion;
  name: string;
  current: boolean;
  clearing_house: Address;
  vault: Address;
  items: ClaimItem[];
  pending_payout_usdg: string;
  error: string | null;
};

function usdg(units: bigint): string {
  return `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, "0")}`;
}

/**
 * Everything a wallet can claim or withdraw, across every FloatSheets
 * deployment it has used. Retired deployments still hold real USDG: idle
 * margin, payouts, LP shares and queued requests. Each item carries the
 * transaction that releases it, so the dashboard can offer one button each.
 */
export class ClaimCenter {
  constructor(private readonly database: Pool, private readonly rpc: RpcTransport, private readonly config: AppConfig) {}

  private async read(to: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []): Promise<any> {
    const data = encodeFunctionData({ abi: abi as any, functionName, args } as any);
    const result = await this.rpc.call({ to, data });
    return decodeFunctionResult({ abi: abi as any, functionName, data: result } as any);
  }

  async forAccount(account: Address, now: Date = new Date()) {
    const { rows } = await this.database.query<{ symbol: string }>("SELECT symbol FROM public.markets ORDER BY symbol");
    const symbols = rows.map((row) => row.symbol);
    const deployments: DeploymentClaims[] = [];
    for (const { version, name } of CLAIM_DEPLOYMENTS) {
      let addresses: AppConfig;
      try { addresses = contractConfigForVersion(this.config, version); } catch { continue; }
      deployments.push(await this.deployment(version, name, addresses, account, symbols, now));
    }
    const claimableNow = deployments.flatMap((item) => item.items)
      .filter((item) => item.kind === "claim_balance" || item.kind === "withdraw_margin" || item.kind === "claim_lp_withdrawal" || item.kind === "claim_deferred")
      // amount_usdg always has six decimals, so removing the point gives USDG units.
      .reduce((sum, item) => sum + BigInt(item.amount_usdg?.replace(".", "") ?? "0"), 0n);
    return {
      account,
      generated_at: now.toISOString(),
      claimable_now_usdg: usdg(claimableNow),
      action_count: deployments.reduce((sum, item) => sum + item.items.length, 0),
      // Unreadable deployments are logged, not shown: they usually hold nothing for this wallet.
      deployments: deployments.filter((item) => item.current || item.items.length > 0 || item.pending_payout_usdg !== "0.000000")
    };
  }

  private async deployment(
    version: ContractVersion, name: string, addresses: AppConfig, account: Address, symbols: string[], now: Date
  ): Promise<DeploymentClaims> {
    const clearingHouse = addresses.FLOAT_CLEARING_HOUSE_ADDRESS as Address;
    const vault = addresses.FLOAT_VAULT_ADDRESS as Address;
    const result: DeploymentClaims = {
      version, name, current: version === "goldlake" || version === "copper", clearing_house: clearingHouse, vault, items: [], pending_payout_usdg: "0.000000", error: null
    };
    try {
      // Older deployments lack deferred payouts; a missing function means none are owed.
      const optional = (functionName: string) => (this.read(clearingHouse, clearingAbi, functionName, [account]) as Promise<bigint>).catch(() => 0n);
      const [claimable, deferred, pending] = await Promise.all([optional("claimableBalance"), optional("deferredClaim"), optional("pendingPayout")]);
      result.pending_payout_usdg = usdg(pending);
      if (claimable > 0n) {
        result.items.push({
          kind: "claim_balance", title: "Claim your balance", market: null, amount_usdg: usdg(claimable),
          detail: "Returned margin, profits and keeper rewards credited to your wallet.",
          transaction: { ...claimProtocolBalance(clearingHouse, account), activity: "claim" }
        });
      }
      if (deferred > 0n) {
        result.items.push({
          kind: "claim_deferred", title: "Claim deferred payout", market: null, amount_usdg: usdg(deferred),
          detail: "Profit queued under the vault's hourly payout cap. Each claim pays what the vault can release now; repeat until it reaches zero.",
          transaction: { ...claimDeferredPayout(clearingHouse, account), activity: "claim-deferred" }
        });
      }
      const positions = await Promise.all(symbols.map(async (symbol) => {
        const id = marketId(symbol);
        const position = await (this.read(clearingHouse, clearingAbi, "getPosition", [account, id]) as Promise<readonly bigint[]>)
          .catch(() => this.read(clearingHouse, legacyPositionAbi, "getPosition", [account, id]) as Promise<readonly bigint[]>);
        return { symbol, size: position[0]!, margin: position[2]! };
      }));
      for (const position of positions) {
        if (position.size !== 0n && !result.current) {
          result.items.push({
            kind: "close_position", title: `Close ${position.symbol} position`, market: position.symbol, amount_usdg: usdg(position.margin),
            detail: `${name} is retired. Close this position to release its margin and any profit.`,
            transaction: null
          });
        } else if (position.size === 0n && position.margin > 0n) {
          result.items.push({
            kind: "withdraw_margin", title: `Withdraw idle ${position.symbol} margin`, market: position.symbol, amount_usdg: usdg(position.margin),
            detail: "Margin deposited for a market where you have no open position.",
            transaction: { ...withdrawMargin(clearingHouse, marketId(position.symbol), position.margin), activity: "withdraw", market: position.symbol }
          });
        }
      }
    } catch (error) {
      result.error = safeErrorMessage(error);
      console.warn(JSON.stringify({ event: "claim_center_deployment_unreadable", version, error: result.error }));
      return result;
    }
    try {
      await this.vaultItems(result, vault, account, now);
    } catch (error) {
      // Some retired vaults predate the daily queue; their clearing-house items still apply.
      console.warn(JSON.stringify({ event: "claim_center_vault_unreadable", version, error: safeErrorMessage(error) }));
    }
    return result;
  }

  private async vaultItems(result: DeploymentClaims, vault: Address, account: Address, now: Date): Promise<void> {
    const [shares, locked, totalAssets, totalShares, epoch, startedAt, settled, duration] = await Promise.all([
      this.read(vault, vaultAbi, "balanceOf", [account]) as Promise<bigint>,
      this.read(vault, vaultAbi, "lockedWithdrawalShares", [account]) as Promise<bigint>,
      this.read(vault, vaultAbi, "totalAssets") as Promise<bigint>,
      this.read(vault, vaultAbi, "totalShares") as Promise<bigint>,
      this.read(vault, vaultAbi, "queueEpoch") as Promise<bigint>,
      this.read(vault, vaultAbi, "queueEpochStartedAt") as Promise<bigint>,
      this.read(vault, vaultAbi, "queueEpochSettled") as Promise<boolean>,
      this.read(vault, vaultAbi, "QUEUE_EPOCH_DURATION") as Promise<bigint>
    ]);
    const first = epoch > EPOCH_LOOKBACK ? epoch - EPOCH_LOOKBACK : 0n;
    const epochs = Array.from({ length: Number(epoch - first) + 1 }, (_, index) => epoch - BigInt(index));
    const requests = await Promise.all(epochs.map(async (requestEpoch) => {
      const [deposit, withdrawal] = await Promise.all([
        this.read(vault, vaultAbi, "queuedDepositOf", [requestEpoch, account]) as Promise<bigint>,
        this.read(vault, vaultAbi, "queuedWithdrawalOf", [requestEpoch, account]) as Promise<bigint>
      ]);
      if (deposit === 0n && withdrawal === 0n) return null;
      const [depositDone, withdrawalDone, settlement] = await Promise.all([
        this.read(vault, vaultAbi, "depositClaimed", [requestEpoch, account]) as Promise<boolean>,
        this.read(vault, vaultAbi, "withdrawalClaimed", [requestEpoch, account]) as Promise<boolean>,
        this.read(vault, vaultAbi, "queueSettlements", [requestEpoch]) as Promise<readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean]>
      ]);
      return { requestEpoch, deposit, withdrawal, depositDone, withdrawalDone, settlement };
    }));
    let hasQueuedInCurrentEpoch = false;
    for (const request of requests) {
      if (!request) continue;
      const { requestEpoch, deposit, withdrawal, depositDone, withdrawalDone, settlement } = request;
      const isSettled = settlement[8];
      if (requestEpoch === epoch && !isSettled) hasQueuedInCurrentEpoch = true;
      if (isSettled && deposit > 0n && !depositDone) {
        result.items.push({
          kind: "claim_lp_deposit", title: `Claim LP shares from epoch ${requestEpoch}`, market: null, amount_usdg: usdg(deposit),
          detail: "Your queued deposit was priced at the epoch NAV. Claim to receive the shares.",
          transaction: { ...claimVaultDeposit(vault, requestEpoch), activity: "vault-claim-deposit" }
        });
      }
      if (isSettled && withdrawal > 0n && !withdrawalDone) {
        // Estimate the USDG from the epoch's settlement price.
        const assets = withdrawal * (settlement[0] + 1n) / (settlement[1] + VIRTUAL_SHARES);
        result.items.push({
          kind: "claim_lp_withdrawal", title: `Claim LP withdrawal from epoch ${requestEpoch}`, market: null, amount_usdg: usdg(assets),
          detail: "Your queued withdrawal is settled. Claim to receive the USDG.",
          transaction: { ...claimVaultWithdrawal(vault, requestEpoch, account), activity: "vault-claim-withdrawal" }
        });
      }
    }
    const readyAt = Number(startedAt + duration) * 1_000;
    if (hasQueuedInCurrentEpoch && !settled && now.getTime() >= readyAt) {
      result.items.push({
        kind: "settle_epoch", title: "Settle the LP epoch", market: null, amount_usdg: null,
        detail: "Your request is waiting on a settlement anyone can trigger. Settle it, then claim.",
        transaction: { ...settleVaultQueue(vault), activity: "vault-settle-queue" }
      });
    }
    const free = shares > locked ? shares - locked : 0n;
    if (free > 0n && !result.current) {
      const value = free * (totalAssets + 1n) / (totalShares + VIRTUAL_SHARES);
      result.items.push({
        kind: "queue_lp_withdrawal", title: "Withdraw LP shares", market: null, amount_usdg: usdg(value),
        detail: `${result.name} is retired. Queue your shares for withdrawal at the next daily epoch, then claim the USDG.`,
        transaction: { ...withdrawVault(vault, free, account), activity: "vault-withdraw" }
      });
    }
  }
}
