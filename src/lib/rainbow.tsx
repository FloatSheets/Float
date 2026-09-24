import { ConnectButton, RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http, useAccount, usePublicClient, useReadContract, useSendTransaction, WagmiProvider } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { defineChain, formatUnits, keccak256, parseAbi, stringToHex, type Address, type Hex } from "viem";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { getCloseTransaction, getProtocol, getTradeTransaction, getTransactionCalldata } from "./server-api";

const DEFAULT_USDG_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
const erc20Abi = parseAbi(["function allowance(address owner,address spender) view returns (uint256)", "function balanceOf(address account) view returns (uint256)"]);
const clearingAbi = parseAbi(["function getPosition(address trader,bytes32 marketId) view returns (int256 sizeE18,uint256 entryPriceE18,uint256 marginUsdg)"]);
const clearingLiquidityAbi = parseAbi(["function availableLiquidity() view returns (uint256)"]);
const oracleAbi = parseAbi(["function getPrice(bytes32) view returns (uint256,uint256,uint256,uint256,uint64,uint64,bool)"]);
const vaultAbi = parseAbi([
  "function totalAssets() view returns (uint256)", "function totalShares() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)"
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
  const [protocolAddresses, setProtocolAddresses] = useState<{ usdg: Address; vault: Address; clearingHouse: Address; oracle: Address } | null>(null);
  const usdgAddress = protocolAddresses?.usdg ?? DEFAULT_USDG_ADDRESS;
  const { data: usdgBalance, refetch: refetchUsdG } = useReadContract({ address: usdgAddress, abi: erc20Abi, functionName: "balanceOf", args: [address ?? "0x0000000000000000000000000000000000000000"], query: { enabled: Boolean(address) && chainId === robinhoodChain.id } });
  const publicClient = usePublicClient({ chainId: robinhoodChain.id });
  const { sendTransactionAsync } = useSendTransaction();

  useEffect(() => {
    let active = true;
    void getProtocol().then((protocol) => {
      if (!active) return;
      const usdg = protocol.settlement_asset_address;
      const vault = protocol.vault;
      const clearingHouse = protocol.clearing_house;
      const oracle = protocol.oracle;
      if (typeof usdg === "string" && /^0x[0-9a-fA-F]{40}$/.test(usdg) && typeof vault === "string" && /^0x[0-9a-fA-F]{40}$/.test(vault) && typeof clearingHouse === "string" && /^0x[0-9a-fA-F]{40}$/.test(clearingHouse) && typeof oracle === "string" && /^0x[0-9a-fA-F]{40}$/.test(oracle)) {
        setProtocolAddresses({ usdg: usdg as Address, vault: vault as Address, clearingHouse: clearingHouse as Address, oracle: oracle as Address });
      }
    }).catch((error) => console.warn("FloatSheets protocol address lookup failed", error));
    return () => { active = false; };
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
      async buildTransaction(action: "approve" | "deposit" | "withdraw" | "trade-quote" | "close-quote" | "vault-approve" | "vault-deposit" | "vault-withdraw", payload: Record<string, unknown>) {
        if (!connected || !address) throw new Error("Connect a wallet on Robinhood Chain first.");
        const transactionPayload = action === "vault-deposit" || action === "vault-withdraw" ? { ...payload, receiver: address } : payload;
        const result = action === "trade-quote"
          ? await getTradeTransaction({ data: { ...payload, trader: address } })
          : action === "close-quote"
            ? await getCloseTransaction({ data: { ...payload, trader: address } })
          : await getTransactionCalldata({ data: { action, payload: transactionPayload } });
        const activity = action === "trade-quote" ? "trade" : action === "close-quote" ? "close" : action;
        const market = typeof payload["market"] === "string" ? payload["market"] : "";
        return { ...result, transaction: { ...(result.transaction as object), activity, market }, activity, market };
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
        const [assets, shares, totalShares, availableLiquidity] = await Promise.all([
          publicClient.readContract({ address: protocolAddresses.vault, abi: vaultAbi, functionName: "totalAssets" }),
          publicClient.readContract({ address: protocolAddresses.vault, abi: vaultAbi, functionName: "balanceOf", args: [address] }),
          publicClient.readContract({ address: protocolAddresses.vault, abi: vaultAbi, functionName: "totalShares" }),
          publicClient.readContract({ address: protocolAddresses.clearingHouse, abi: clearingLiquidityAbi, functionName: "availableLiquidity" })
        ]);
        return { assets: assets.toString(), shares: shares.toString(), totalShares: totalShares.toString(), availableLiquidity: availableLiquidity.toString() };
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
      }
    };
    window.dispatchEvent(new CustomEvent("floatsheets-wallet-state", { detail: state }));
  }, [address, chainId, isConnected, protocolAddresses, publicClient, refetchUsdG, sendTransactionAsync, usdgBalance]);

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
