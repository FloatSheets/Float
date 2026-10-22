import { ConnectButton, RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http, useAccount, usePublicClient, useReadContract, useSendTransaction, useSignMessage, WagmiProvider } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { defineChain, formatUnits, keccak256, parseAbi, parseAbiItem, stringToHex, type Address, type Hex } from "viem";
import { replayAccount, unrealizedPnl, liquidationPrice, type AccountEvent } from './pnl';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { checkTrade, createTelegramAlertLink, getCloseTransaction, getEmailAlertChallenge, getProtocol, getTelegramAlertLinkChallenge, getTelegramAlertLinkStatus, getTelegramAlertSettingsChallenge, getTradeTransaction, getTransactionCalldata, saveEmailAlertSettings, saveTelegramAlertSettings, verifyEmailAlert } from "./server-api";

const DEFAULT_USDG_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
const erc20Abi = parseAbi(["function allowance(address owner,address spender) view returns (uint256)", "function balanceOf(address account) view returns (uint256)"]);
const clearingAbi = parseAbi(["function getPosition(address trader,bytes32 marketId) view returns (int256 sizeE18,uint256 entryPriceE18,uint256 marginUsdg)"]);
const marketRiskAbi = parseAbi(['function markets(bytes32) view returns (uint8 state,uint64 maxLeverageE18,uint64 maintenanceMarginBps,uint64 maxExecutionDeviationBps,uint64 maxOracleConfidenceBps,uint128 maxPositionNotionalUsdg)']);
const clearingLiquidityAbi = parseAbi(["function availableLiquidity() view returns (uint256)"]);
const clearingNavAbi = parseAbi(["function navPricesFresh() view returns (bool)"]);
const oracleAbi = parseAbi(["function getPrice(bytes32) view returns (uint256,uint256,uint256,uint256,uint64,uint64,bool)"]);
// Start event scans at each deployment rather than genesis. Robinhood RPC
// rejects eth_getLogs requests spanning more than ten million blocks.
const contractDeploymentBlocks: Record<string, bigint> = {
  jaguar: 95_315_783n,
  goldlake: 94_807_521n,
  silverlake: 94_764_216n,
  amber: 94_624_581n,
  jasper: 94_292_113n,
};
const MAX_LOG_BLOCK_SPAN = 9_000_000n;
const vaultAbi = parseAbi([
  "function totalAssets() view returns (uint256)", "function totalShares() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function lockedWithdrawalShares(address) view returns (uint256)",
  "function queueEpoch() view returns (uint64)", "function queueEpochStartedAt() view returns (uint64)",
  "function queueEpochSettled() view returns (bool)", "function QUEUE_EPOCH_DURATION() view returns (uint256)",
  "function queuedDepositOf(uint64,address) view returns (uint256)", "function queuedWithdrawalOf(uint64,address) view returns (uint256)",
  "function depositClaimed(uint64,address) view returns (bool)", "function withdrawalClaimed(uint64,address) view returns (bool)",
  "function queueSettlements(uint64) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)",
  "function cancelQueuedWithdrawal(uint64) returns (uint256 shares)",
  "function insuranceAssets() view returns (uint256)"
]);

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Robinhood Chain Explorer", url: "https://robinhoodchain.blockscout.com" } },
});

export const wagmiConfig = getDefaultConfig({
  appName: "FloatSheets",
  projectId: import.meta.env["VITE_WALLETCONNECT_PROJECT_ID"] ?? "",
  chains: [robinhoodChain],
  transports: { [robinhoodChain.id]: http("https://rpc.mainnet.chain.robinhood.com") },
  ssr: true,
});

export function RainbowProviders({ children, queryClient }: { children: ReactNode; queryClient: QueryClient }) {
  return <WagmiProvider config={wagmiConfig}><QueryClientProvider client={queryClient}><RainbowKitProvider modalSize="compact" theme={lightTheme({ accentColor: "#153c92", accentColorForeground: "#ffb6c1", borderRadius: "medium", fontStack: "system", overlayBlur: "small" })}>{children}</RainbowKitProvider></QueryClientProvider></WagmiProvider>;
}

export function RainbowWalletBridge() {
  const { address, chainId, isConnected } = useAccount();
  const [contractVersion, setContractVersion] = useState<"jaguar" | "goldlake" | "silverlake" | "amber" | "jasper" | "meadow" | "legacy-orion">("goldlake");
  const [protocolAddresses, setProtocolAddresses] = useState<{ usdg: Address; vault: Address; clearingHouse: Address; oracle: Address } | null>(null);
  const usdgAddress = protocolAddresses?.usdg ?? DEFAULT_USDG_ADDRESS;
  const { data: usdgBalance, refetch: refetchUsdG } = useReadContract({ address: usdgAddress, abi: erc20Abi, functionName: "balanceOf", args: [address ?? "0x0000000000000000000000000000000000000000"], query: { enabled: Boolean(address) && chainId === robinhoodChain.id } });
  const publicClient = usePublicClient({ chainId: robinhoodChain.id });
  const { sendTransactionAsync } = useSendTransaction();
  const { signMessageAsync } = useSignMessage();

  useEffect(() => {
    const url = new URL(window.location.href);
    const token = url.searchParams.get("liquidationEmailToken");
    if (!token) return;
    void verifyEmailAlert({ data: { token } }).then((result) => {
      url.searchParams.delete("liquidationEmailToken");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
      if (typeof result.wallet === "string" && typeof result.email === "string") localStorage.setItem(`floatsheets-liquidation-email-${result.wallet.toLowerCase()}`, JSON.stringify({ email: result.email, enabled: true }));
      (window as Window & { __FLOATSHEETS_EMAIL_ALERTS_RESULT__?: unknown }).__FLOATSHEETS_EMAIL_ALERTS_RESULT__ = result;
      window.dispatchEvent(new CustomEvent("floatsheets-email-alerts-result", { detail: result }));
    }).catch((error: unknown) => {
      url.searchParams.delete("liquidationEmailToken");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
      const result = { message: error instanceof Error ? error.message : "Email verification failed", verified: false };
      (window as Window & { __FLOATSHEETS_EMAIL_ALERTS_RESULT__?: unknown }).__FLOATSHEETS_EMAIL_ALERTS_RESULT__ = result;
      window.dispatchEvent(new CustomEvent("floatsheets-email-alerts-result", { detail: result }));
    });
  }, []);

  useEffect(() => {
    let active = true;
    let requestId = 0;
    const loadProtocol = (version: "jaguar" | "goldlake" | "silverlake" | "amber" | "jasper" | "meadow" | "legacy-orion") => {
      const currentRequest = ++requestId;
      void getProtocol({ data: { version } }).then((protocol) => {
      if (!active || currentRequest !== requestId) return;
      const usdg = protocol.settlement_asset_address;
      const vault = protocol.vault;
      const clearingHouse = protocol.clearing_house;
      const oracle = protocol.oracle;
      if (typeof usdg === "string" && /^0x[0-9a-fA-F]{40}$/.test(usdg) && typeof vault === "string" && /^0x[0-9a-fA-F]{40}$/.test(vault) && typeof clearingHouse === "string" && /^0x[0-9a-fA-F]{40}$/.test(clearingHouse) && typeof oracle === "string" && /^0x[0-9a-fA-F]{40}$/.test(oracle)) {
        setProtocolAddresses({ usdg: usdg as Address, vault: vault as Address, clearingHouse: clearingHouse as Address, oracle: oracle as Address });
      }
      }).catch((error) => console.warn("FloatSheets protocol address lookup failed", error));
    };
    const saved = window.localStorage.getItem("floatsheets-contract-version-v1");
    const initialVersion = saved === "jaguar" ? "jaguar" : saved === "legacy-orion" ? "legacy-orion" : saved === "silverlake" ? "silverlake" : "goldlake";
    setContractVersion(initialVersion);
    loadProtocol(initialVersion);
    const onVersionChange = (event: Event) => {
      const selected = (event as CustomEvent<{ version?: string }>).detail?.version;
      const version = selected === "jaguar" ? "jaguar" : selected === "legacy-orion" ? "legacy-orion" : selected === "silverlake" ? "silverlake" : "goldlake";
      setContractVersion(version);
      setProtocolAddresses(null);
      loadProtocol(version);
    };
    window.addEventListener("floatsheets-contract-version-change", onVersionChange);
    return () => { active = false; window.removeEventListener("floatsheets-contract-version-change", onVersionChange); };
  }, []);

  useEffect(() => {
    const connected = isConnected && Boolean(address) && chainId === robinhoodChain.id;
    const state = {
      address: connected ? address! : "", connected, chainId: chainId ?? 0,
      usdgBalance: connected && usdgBalance !== undefined ? formatUnits(usdgBalance, 6) : "0"
    };
    const walletWindow = window as Window & { __FLOATSHEETS_WALLET_STATE__?: typeof state; __FLOATSHEETS_WALLET__?: unknown };
    walletWindow.__FLOATSHEETS_WALLET_STATE__ = state;
    walletWindow.__FLOATSHEETS_WALLET__ = {
      ...state,
      async buildTransaction(action: "approve" | "deposit" | "withdraw" | "trade-quote" | "close-quote" | "vault-approve" | "vault-deposit" | "vault-withdraw" | "vault-settle-queue" | "vault-start-next-epoch" | "vault-claim-deposit" | "vault-claim-withdrawal" | "vault-cancel-withdrawal", payload: Record<string, unknown>) {
        if (!connected || !address) throw new Error("Connect a wallet on Robinhood Chain first.");
        const transactionPayload = action === "vault-deposit" || action === "vault-withdraw" ? { ...payload, receiver: address } : payload;
        const result = action === "trade-quote"
          ? await getTradeTransaction({ data: { ...payload, trader: address, contractVersion } })
          : action === "close-quote"
            ? await getCloseTransaction({ data: { ...payload, trader: address, contractVersion } })
          : await getTransactionCalldata({ data: { action, payload: transactionPayload, contractVersion } });
        const activity = action === "trade-quote" ? "trade" : action === "close-quote" ? "close" : action;
        const market = typeof payload["market"] === "string" ? payload["market"] : "";
        return { ...result, transaction: { ...(result.transaction as object), activity, market }, activity, market };
      },
      async checkTrade(payload: Record<string, unknown>) {
        if (!connected || !address) throw new Error("Connect a wallet on Robinhood Chain first.");
        return checkTrade({ data: { ...payload, trader: address, contractVersion } });
      },
      async configureEmailAlerts(email: string, enabled: boolean) {
        if (!connected || !address) throw new Error("Connect a wallet on Robinhood Chain first.");
        const challenge = await getEmailAlertChallenge({ data: { wallet: address, email: email.trim(), enabled } });
        const signature = await signMessageAsync({ message: challenge.message });
        const result = await saveEmailAlertSettings({ data: { wallet: address, email, enabled, signature } });
        if (email.trim()) localStorage.setItem(`floatsheets-liquidation-email-${address.toLowerCase()}`, JSON.stringify({ email: email.trim(), enabled: result.enabled === true }));
        else localStorage.removeItem(`floatsheets-liquidation-email-${address.toLowerCase()}`);
        window.dispatchEvent(new CustomEvent("floatsheets-email-alerts-result", { detail: result }));
        return result;
      },
      async startTelegramAlertLink() {
        if (!connected || !address) throw new Error("Connect your wallet on Robinhood Chain first.");
        const challenge = await getTelegramAlertLinkChallenge({ data: { wallet: address } });
        const signature = await signMessageAsync({ message: challenge.message });
        return createTelegramAlertLink({ data: { wallet: address, signature } });
      },
      async getTelegramAlertLinkStatus(token: string) {
        return getTelegramAlertLinkStatus({ data: { token } });
      },
      async configureTelegramAlerts(enabled: boolean) {
        if (!connected || !address) throw new Error("Connect your wallet on Robinhood Chain first.");
        const challenge = await getTelegramAlertSettingsChallenge({ data: { wallet: address, enabled } });
        const signature = await signMessageAsync({ message: challenge.message });
        const result = await saveTelegramAlertSettings({ data: { wallet: address, enabled, signature } });
        localStorage.setItem(`floatsheets-liquidation-telegram-${address.toLowerCase()}`, JSON.stringify({ enabled: result.enabled === true, username: result.telegram_username ?? null }));
        return result;
      },
      async send(transaction: { to: string; data: string; value?: string; chainId: number; activity?: string; market?: string }) {
        if (!connected) throw new Error("Connect a wallet on Robinhood Chain first.");
        if (transaction.chainId !== robinhoodChain.id) throw new Error("Transaction is not for Robinhood Chain.");
        const hash = await sendTransactionAsync({ to: transaction.to as Address, data: transaction.data as Hex, value: BigInt(transaction.value ?? "0x0"), chainId: robinhoodChain.id });
        await waitForTransactionReceipt(wagmiConfig, { hash, confirmations: 1 });
        await refetchUsdG();
        window.dispatchEvent(new CustomEvent("floatsheets-transaction-confirmed", { detail: { action: transaction.activity, market: transaction.market, hash } }));
        return hash;
      },
      async allowance() {
        if (!connected || !address || !publicClient) return 0n;
        if (!protocolAddresses) throw new Error("Trading configuration is still loading. Please try again.");
        return publicClient.readContract({ address: protocolAddresses.usdg, abi: erc20Abi, functionName: "allowance", args: [address, protocolAddresses.clearingHouse] });
      },
      async vaultAllowance() {
        if (!connected || !address || !publicClient) return 0n;
        if (!protocolAddresses) throw new Error("Trading configuration is still loading. Please try again.");
        return publicClient.readContract({ address: protocolAddresses.usdg, abi: erc20Abi, functionName: "allowance", args: [address, protocolAddresses.vault] });
      },
      async vault() {
        if (!connected || !address || !publicClient) return null;
        if (!protocolAddresses) throw new Error("Trading configuration is still loading. Please try again.");
        const [assets, shares, totalShares, availableLiquidity, navFresh, insuranceAssets] = await Promise.all([
          publicClient.readContract({ address: protocolAddresses.vault, abi: vaultAbi, functionName: "totalAssets" }),
          publicClient.readContract({ address: protocolAddresses.vault, abi: vaultAbi, functionName: "balanceOf", args: [address] }),
          publicClient.readContract({ address: protocolAddresses.vault, abi: vaultAbi, functionName: "totalShares" }),
          publicClient.readContract({ address: protocolAddresses.clearingHouse, abi: clearingLiquidityAbi, functionName: "availableLiquidity" }),
          contractVersion === "goldlake" || contractVersion === "jaguar"
            ? publicClient.readContract({ address: protocolAddresses.clearingHouse, abi: clearingNavAbi, functionName: "navPricesFresh" })
            : Promise.resolve(true),
          publicClient.readContract({ address: protocolAddresses.vault, abi: vaultAbi, functionName: "insuranceAssets" })
        ]);
        if (contractVersion === "jaguar") {
          return { assets: assets.toString(), shares: shares.toString(), lockedShares: "0", totalShares: totalShares.toString(), availableLiquidity: availableLiquidity.toString(), navFresh, epoch: "0", epochStartedAt: "0", epochSettled: true, epochDuration: "0", insuranceAssets: insuranceAssets.toString(), requests: [], instant: true };
        }
        const [lockedShares, epoch, epochStartedAt, epochSettled, epochDuration] = await Promise.all([
          publicClient.readContract({ address: protocolAddresses.vault, abi: vaultAbi, functionName: "lockedWithdrawalShares", args: [address] }),
          publicClient.readContract({ address: protocolAddresses.vault, abi: vaultAbi, functionName: "queueEpoch" }),
          publicClient.readContract({ address: protocolAddresses.vault, abi: vaultAbi, functionName: "queueEpochStartedAt" }),
          publicClient.readContract({ address: protocolAddresses.vault, abi: vaultAbi, functionName: "queueEpochSettled" }),
          publicClient.readContract({ address: protocolAddresses.vault, abi: vaultAbi, functionName: "QUEUE_EPOCH_DURATION" })
        ]);
        const epochs = Array.from({length: Number(epoch) > 9 ? 10 : Number(epoch) + 1}, (_, i) => BigInt(epoch) - BigInt(i));
        const requests = await Promise.all(epochs.map(async (requestEpoch) => {
          const [depositAssets, withdrawalShares, depositDone, withdrawalDone, settlement] = await Promise.all([
            publicClient.readContract({ address: protocolAddresses.vault, abi: vaultAbi, functionName: "queuedDepositOf", args: [requestEpoch, address] }),
            publicClient.readContract({ address: protocolAddresses.vault, abi: vaultAbi, functionName: "queuedWithdrawalOf", args: [requestEpoch, address] }),
            publicClient.readContract({ address: protocolAddresses.vault, abi: vaultAbi, functionName: "depositClaimed", args: [requestEpoch, address] }),
            publicClient.readContract({ address: protocolAddresses.vault, abi: vaultAbi, functionName: "withdrawalClaimed", args: [requestEpoch, address] }),
            publicClient.readContract({ address: protocolAddresses.vault, abi: vaultAbi, functionName: "queueSettlements", args: [requestEpoch] })
          ]);
          return { epoch: requestEpoch.toString(), depositAssets: depositAssets.toString(), withdrawalShares: withdrawalShares.toString(), settledWithdrawalShares: settlement[4].toString(), depositClaimed: depositDone, withdrawalClaimed: withdrawalDone, settled: settlement[8] };
        }));
        return { assets: assets.toString(), shares: shares.toString(), lockedShares: lockedShares.toString(), totalShares: totalShares.toString(), availableLiquidity: availableLiquidity.toString(), navFresh, epoch: epoch.toString(), epochStartedAt: epochStartedAt.toString(), epochSettled, epochDuration: epochDuration.toString(), insuranceAssets: insuranceAssets.toString(), requests };
      },
      async position(symbol: string) {
        if (!connected || !address || !publicClient) return null;
        if (!protocolAddresses) throw new Error("Trading configuration is still loading. Please try again.");
        const marketId = keccak256(stringToHex(symbol.trim().toUpperCase()));
        const result = await publicClient.readContract({ address: protocolAddresses.clearingHouse, abi: clearingAbi, functionName: "getPosition", args: [address, marketId] });
        return { sizeE18: result[0].toString(), entryPriceE18: result[1].toString(), marginUsdg: result[2].toString() };
      },
      async marketPrice(symbol: string) {
        if (!connected || !publicClient) return null;
        if (!protocolAddresses) throw new Error("Trading configuration is still loading. Please try again.");
        const marketId = keccak256(stringToHex(symbol.trim().toUpperCase()));
        const result = await publicClient.readContract({ address: protocolAddresses.oracle, abi: oracleAbi, functionName: "getPrice", args: [marketId] });
        return { priceE18: result[0].toString(), timestamp: result[4].toString(), circuitBroken: result[6] };
      },
      async pnlSnapshot(symbols: string[], includeHistory = false) {
        if (!connected || !address || !publicClient || !protocolAddresses) throw new Error('Connect your wallet and wait for trading settings to load.');
        const block = await publicClient.getBlock();
        let history: ReturnType<typeof replayAccount> | undefined;
        let historyError: string | null = null;
        if (includeHistory) {
          const events = [
            parseAbiItem('event MarginDeposited(address indexed trader, bytes32 indexed marketId, uint256 assets)'),
            parseAbiItem('event MarginWithdrawn(address indexed trader, bytes32 indexed marketId, uint256 assets)'),
            parseAbiItem('event TradeExecuted(address indexed trader, bytes32 indexed marketId, int256 sizeDeltaE18, uint256 executionPriceE18, uint256 feeUsdg)'),
            parseAbiItem('event PositionLiquidated(address indexed trader, bytes32 indexed marketId, uint256 priceE18, int256 pnlUsdg, uint256 penaltyUsdg, address liquidator)'),
          ] as const;
          try {
            const fromBlock = contractDeploymentBlocks[contractVersion] ?? 0n;
            const groups = await Promise.all(events.map(async event => {
              const logs = [];
              for (let start = fromBlock; start <= block.number; start += MAX_LOG_BLOCK_SPAN) {
                const end = start + MAX_LOG_BLOCK_SPAN - 1n < block.number ? start + MAX_LOG_BLOCK_SPAN - 1n : block.number;
                logs.push(...await publicClient.getLogs({
                  address: protocolAddresses.clearingHouse, event, args: { trader: address }, fromBlock: start, toBlock: end, strict: true,
                }));
              }
              return logs;
            }));
            const logs = groups.flat().filter(log => !log.removed).sort((a, b) =>
              a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);
            history = replayAccount(logs as AccountEvent[]);
          } catch (error) {
            historyError = error instanceof Error ? error.message : 'Trading history is temporarily unavailable.';
            console.warn('FloatSheets realized PnL history unavailable', error);
          }
        }
        const ids = new Map(symbols.map(symbol => [keccak256(stringToHex(symbol.toUpperCase())), symbol]));
        for (const id of history?.markets.keys() ?? []) if (!ids.has(id as Hex)) ids.set(id as Hex, id.slice(0, 10));
        let historyConsistent = true;
        const positions = await Promise.all([...ids].map(async ([id, symbol]) => {
          const p = await publicClient.readContract({ address: protocolAddresses.clearingHouse, abi: clearingAbi, functionName: 'getPosition', args: [address, id], blockNumber: block.number });
          if (history) {
            const replayed = history.markets.get(id.toLowerCase()) ?? { size: 0n, entry: 0n, margin: 0n };
            if (replayed.size !== p[0] || replayed.entry !== p[1] || replayed.margin !== p[2]) historyConsistent = false;
          }
          let pnl = 0n, stale = false, liquidationPriceE18: string | null = null, markPriceE18: string | null = null;
          if (p[0] !== 0n) {
            const [mark, risk] = await Promise.all([
              publicClient.readContract({ address: protocolAddresses.oracle, abi: oracleAbi, functionName: 'getPrice', args: [id], blockNumber: block.number }),
              publicClient.readContract({ address: protocolAddresses.clearingHouse, abi: marketRiskAbi, functionName: 'markets', args: [id], blockNumber: block.number }),
            ]);
            liquidationPriceE18 = liquidationPrice(p[0], p[1], p[2], risk[2])?.toString() ?? null;
            if (mark[0] === 0n) throw new Error('A price is not available yet.');
            markPriceE18 = mark[0].toString();
            pnl = unrealizedPnl(p[0], p[1], mark[0]);
            stale = block.timestamp > mark[4] + 120n || mark[6];
          }
          return { symbol, sizeE18: p[0].toString(), entryPriceE18: p[1].toString(), markPriceE18, marginUsdg: p[2].toString(), pnlUsdg: pnl.toString(), liquidationPriceE18, stale };
        }));
        if (history && !historyConsistent) {
          history = undefined;
          historyError = 'Trading history does not match the current on-chain position yet.';
        }
        return {
          positions, address, blockNumber: block.number.toString(), historyAvailable: !includeHistory || Boolean(history), historyError,
          unrealizedUsdg: positions.reduce((sum, p) => sum + BigInt(p.pnlUsdg), 0n).toString(),
          activeMarginUsdg: positions.reduce((sum, p) => sum + (BigInt(p.sizeE18) !== 0n ? BigInt(p.marginUsdg) : 0n), 0n).toString(),
          realizedUsdg: history?.realized.toString() ?? null,
          depositedUsdg: history?.deposits.toString() ?? null,
          stale: positions.some(p => p.stale),
        };
      }
    };
    window.dispatchEvent(new CustomEvent("floatsheets-wallet-state", { detail: state }));
  }, [address, chainId, contractVersion, isConnected, protocolAddresses, publicClient, refetchUsdG, sendTransactionAsync, signMessageAsync, usdgBalance]);

  return <ConnectButton.Custom>{({ account, chain, openAccountModal, openChainModal, openConnectModal, authenticationStatus, mounted }) => {
    const ready = mounted && authenticationStatus !== "loading";
    const connected = ready && !!account && !!chain && (!authenticationStatus || authenticationStatus === "authenticated");
    // This bridge has no visual output. Keep its browser-only callback out of
    // the server render so the dashboard can still be rendered by Vercel.
    if (typeof window === "undefined") return null;
    const walletWindow = window as Window & { __FLOATSHEETS_OPEN_WALLET__?: () => void };
    if (!ready) delete walletWindow.__FLOATSHEETS_OPEN_WALLET__;
    else walletWindow.__FLOATSHEETS_OPEN_WALLET__ = chain?.unsupported ? openChainModal : connected ? openAccountModal : openConnectModal;
    return null;
  }}</ConnectButton.Custom>;
}
