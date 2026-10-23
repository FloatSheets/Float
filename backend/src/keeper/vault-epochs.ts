import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { acceptsNewRisk, configuredVersions, contractConfigForVersion, type AppConfig, type ContractVersion } from "../config";
import { safeErrorMessage } from "../safe-error";

/**
 * LP deposits and withdrawals only take effect when someone settles the vault's
 * daily queue epoch (settleQueue) and opens the next one (startNextQueueEpoch).
 * Both are permissionless, but nothing called them: on 2026-10-22 Goldlake's
 * vault held 101 USDG as a pending deposit with totalAssets() = 0, so every
 * new position failed the open-interest cap. This keeper settles and rolls the
 * epoch on the releases that accept new risk.
 */

const vaultAbi = parseAbi([
  "function QUEUE_EPOCH_DURATION() view returns (uint256)",
  "function queueEpochStartedAt() view returns (uint64)",
  "function queueEpochSettled() view returns (bool)",
  "function queueEpoch() view returns (uint64)",
  "function pendingDepositAssets() view returns (uint256)",
  "function settleQueue()",
  "function startNextQueueEpoch()"
]);
const clearingAbi = parseAbi(["function navPricesFresh() view returns (bool)"]);

export type VaultEpochState = { startedAt: bigint; duration: bigint; settled: boolean; epoch: bigint; navFresh: boolean };

export interface VaultEpochChain {
  now(): Promise<bigint>;
  state(vault: Address, clearingHouse: Address): Promise<VaultEpochState>;
  send(vault: Address, functionName: "settleQueue" | "startNextQueueEpoch"): Promise<Hex>;
}

export type EpochAction = "settle" | "start_next" | null;

/** What to do for one vault right now. */
export function nextEpochAction(state: VaultEpochState, now: bigint): EpochAction {
  if (state.settled) return "start_next";
  if (now >= state.startedAt + state.duration && state.navFresh) return "settle";
  return null;
}

const robinhoodChain = defineChain({
  id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } }
});

export function createVaultEpochChain(config: AppConfig): VaultEpochChain {
  const account = privateKeyToAccount((config.KEEPER_PRIVATE_KEY ?? config.ORACLE_PUBLISHER_PRIVATE_KEY) as Hex);
  const chain = { ...robinhoodChain, rpcUrls: { default: { http: [config.RHC_RPC_URL] } } };
  const publicClient = createPublicClient({ chain, transport: http(config.RHC_RPC_URL) });
  const wallet = createWalletClient({ account, chain, transport: http(config.RHC_RPC_URL) });
  return {
    async now() { return (await publicClient.getBlock({ blockTag: "latest" })).timestamp; },
    async state(vault, clearingHouse) {
      const [startedAt, duration, settled, epoch, navFresh] = await Promise.all([
        publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "queueEpochStartedAt" }),
        publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "QUEUE_EPOCH_DURATION" }),
        publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "queueEpochSettled" }),
        publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "queueEpoch" }),
        publicClient.readContract({ address: clearingHouse, abi: clearingAbi, functionName: "navPricesFresh" })
      ]);
      return { startedAt: BigInt(startedAt), duration, settled, epoch: BigInt(epoch), navFresh };
    },
    async send(vault, functionName) {
      // Simulate first so a not-ready epoch never spends gas.
      await publicClient.simulateContract({ account, address: vault, abi: vaultAbi, functionName });
      const hash = await wallet.writeContract({ address: vault, abi: vaultAbi, functionName });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${functionName} ${hash} reverted`);
      return hash;
    }
  };
}

export class VaultEpochKeeper {
  constructor(private readonly config: AppConfig, private readonly chain: VaultEpochChain) {}

  versions(): ContractVersion[] {
    return configuredVersions(this.config).filter(acceptsNewRisk);
  }

  async runOnce(): Promise<{ version: ContractVersion; action: EpochAction; hash?: Hex; error?: string }[]> {
    const now = await this.chain.now();
    const results: { version: ContractVersion; action: EpochAction; hash?: Hex; error?: string }[] = [];
    for (const version of this.versions()) {
      let vault: Address;
      let clearingHouse: Address;
      try {
        const addresses = contractConfigForVersion(this.config, version);
        vault = addresses.FLOAT_VAULT_ADDRESS as Address;
        clearingHouse = addresses.FLOAT_CLEARING_HOUSE_ADDRESS as Address;
      } catch { continue; }
      try {
        let state = await this.chain.state(vault, clearingHouse);
        let action = nextEpochAction(state, now);
        if (action === "settle") {
          const hash = await this.chain.send(vault, "settleQueue");
          console.log(JSON.stringify({ event: "vault_epoch_settled", version, epoch: state.epoch.toString(), transaction_hash: hash }));
          results.push({ version, action, hash });
          state = await this.chain.state(vault, clearingHouse);
          action = nextEpochAction(state, now);
        }
        if (action === "start_next") {
          const hash = await this.chain.send(vault, "startNextQueueEpoch");
          console.log(JSON.stringify({ event: "vault_epoch_started", version, transaction_hash: hash }));
          results.push({ version, action, hash });
        }
      } catch (error) {
        const message = safeErrorMessage(error);
        console.error(JSON.stringify({ event: "vault_epoch_failed", version, error: message }));
        results.push({ version, action: null, error: message });
      }
    }
    return results;
  }
}
