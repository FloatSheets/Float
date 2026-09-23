import { ConnectButton, RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http, useAccount, usePublicClient, useReadContract, useSendTransaction, WagmiProvider } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { defineChain, formatUnits, keccak256, parseAbi, stringToHex, type Address, type Hex } from "viem";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { getTradeTransaction, getTransactionCalldata } from "./server-api";

const USDG_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
const CLEARING_HOUSE_ADDRESS = "0xb91fE7c85E6645D2134f1C313Ea787812d43bfa8" as const;
const erc20Abi = parseAbi(["function allowance(address owner,address spender) view returns (uint256)", "function balanceOf(address account) view returns (uint256)"]);
const clearingAbi = parseAbi(["function getPosition(address trader,bytes32 marketId) view returns (int256 sizeE18,uint256 entryPriceE18,uint256 marginUsdg)"]);

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
  const { data: usdgBalance, refetch: refetchUsdG } = useReadContract({ address: USDG_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address ?? "0x0000000000000000000000000000000000000000"], query: { enabled: Boolean(address) && chainId === robinhoodChain.id } });
  const publicClient = usePublicClient({ chainId: robinhoodChain.id });
  const { sendTransactionAsync } = useSendTransaction();

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
      async buildTransaction(action: "approve" | "deposit" | "withdraw" | "trade-quote", payload: Record<string, unknown>) {
        if (!connected || !address) throw new Error("Connect a wallet on Robinhood Chain first.");
        const result = action === "trade-quote"
          ? await getTradeTransaction({ data: { ...payload, trader: address } })
          : await getTransactionCalldata({ data: { action, payload } });
        return { ...result, activity: action === "trade-quote" ? "trade" : action, market: typeof payload["market"] === "string" ? payload["market"] : "" };
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
        return publicClient.readContract({ address: USDG_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [address, CLEARING_HOUSE_ADDRESS] });
      },
      async position(symbol: string) {
        if (!connected || !address || !publicClient) return null;
        const marketId = keccak256(stringToHex(symbol.trim().toUpperCase()));
        const result = await publicClient.readContract({ address: CLEARING_HOUSE_ADDRESS, abi: clearingAbi, functionName: "getPosition", args: [address, marketId] });
        return { sizeE18: result[0].toString(), entryPriceE18: result[1].toString(), marginUsdg: result[2].toString() };
      }
    };
    window.dispatchEvent(new CustomEvent("floatsheets-wallet-state", { detail: state }));
  }, [address, chainId, isConnected, publicClient, refetchUsdG, sendTransactionAsync, usdgBalance]);

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
