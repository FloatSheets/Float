import { ConnectButton, RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http, WagmiProvider } from "wagmi";
import { defineChain } from "viem";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

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
  return <ConnectButton.Custom>{({ account, chain, openAccountModal, openChainModal, openConnectModal, authenticationStatus, mounted }) => {
    const ready = mounted && authenticationStatus !== "loading";
    const connected = ready && !!account && !!chain && (!authenticationStatus || authenticationStatus === "authenticated");
    if (typeof window !== "undefined") {
      const state = { address: connected ? (account?.address ?? "") : "", connected, chainId: chain?.id ?? 0 };
      (window as Window & { __FLOATSHEETS_WALLET_STATE__?: typeof state }).__FLOATSHEETS_WALLET_STATE__ = state;
      window.dispatchEvent(new CustomEvent("floatsheets-wallet-state", { detail: state }));
      const walletWindow = window as Window & { __FLOATSHEETS_OPEN_WALLET__?: () => void };
      if (!ready) delete walletWindow.__FLOATSHEETS_OPEN_WALLET__;
      else walletWindow.__FLOATSHEETS_OPEN_WALLET__ = chain?.unsupported ? openChainModal : connected ? openAccountModal : openConnectModal;
    }
    return null;
  }}</ConnectButton.Custom>;
}
