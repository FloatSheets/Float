import { ConnectButton, RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http, useAccount, useChainId, WagmiProvider } from "wagmi";
import { defineChain } from "viem";
import type { ReactNode } from "react";
import { useEffect } from "react";

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Robinhood Explorer", url: "https://explorer.mainnet.chain.robinhood.com" } },
});

export const wagmiConfig = getDefaultConfig({
  appName: "FloatSheets",
  projectId: import.meta.env["VITE_WALLETCONNECT_PROJECT_ID"] ?? "",
  chains: [robinhoodChain],
  transports: { [robinhoodChain.id]: http("https://rpc.mainnet.chain.robinhood.com") },
  ssr: true,
});

export function RainbowProviders({ children }: { children: ReactNode }) {
  return <WagmiProvider config={wagmiConfig}><RainbowKitProvider>{children}</RainbowKitProvider></WagmiProvider>;
}

export function RainbowWalletBridge() {
  const account = useAccount();
  const chainId = useChainId();
  useEffect(() => {
    const state = { address: account.address ?? "", connected: account.isConnected, chainId };
    window.dispatchEvent(new CustomEvent("floatsheets-wallet-state", { detail: state }));
    (window as Window & { __FLOATSHEETS_WALLET_STATE__?: typeof state }).__FLOATSHEETS_WALLET_STATE__ = state;
  }, [account.address, account.isConnected, chainId]);
  return <ConnectButton.Custom>{({ openConnectModal, openAccountModal }) => {
    if (typeof window !== "undefined") {
      (window as Window & { __FLOATSHEETS_OPEN_WALLET__?: () => void }).__FLOATSHEETS_OPEN_WALLET__ = account.isConnected ? openAccountModal : openConnectModal;
    }
    return null;
  }}</ConnectButton.Custom>;
}
