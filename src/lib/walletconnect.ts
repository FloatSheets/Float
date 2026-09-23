import { EthereumProvider } from "@walletconnect/ethereum-provider";

export const ROBINHOOD_CHAIN_ID = 4663;
const ROBINHOOD_CHAIN_HEX = "0x1237";
const ROBINHOOD_RPC = "https://rpc.mainnet.chain.robinhood.com";
type ProviderInstance = Awaited<ReturnType<typeof EthereumProvider.init>>;
type Eip1193Provider = { request<T = unknown>(args: { method: string; params?: unknown[] }): Promise<T> };
let providerPromise: Promise<ProviderInstance> | undefined;

async function getProvider() {
  const projectId = import.meta.env["VITE_WALLETCONNECT_PROJECT_ID"];
  if (!projectId) throw new Error("VITE_WALLETCONNECT_PROJECT_ID is not configured.");
  providerPromise ??= EthereumProvider.init({
    projectId, chains: [ROBINHOOD_CHAIN_ID], showQrModal: true,
    rpcMap: { [ROBINHOOD_CHAIN_ID]: ROBINHOOD_RPC },
    metadata: { name: "FloatSheets", description: "USDG-settled synthetic equity perps on Robinhood Chain", url: window.location.origin, icons: [`${window.location.origin}/assets/floatsheets-mark.png`] },
  });
  return providerPromise;
}

async function ensureRobinhoodChain(provider: Eip1193Provider) {
  const chainId = await provider.request<string>({ method: "eth_chainId" });
  if (Number.parseInt(chainId, 16) === ROBINHOOD_CHAIN_ID) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ROBINHOOD_CHAIN_HEX }] });
  } catch (error) {
    if ((error as { code?: number }).code !== 4902) throw error;
    await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: ROBINHOOD_CHAIN_HEX, chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [ROBINHOOD_RPC], blockExplorerUrls: ["https://explorer.mainnet.chain.robinhood.com"] }] });
  }
}

export async function connectWallet() {
  const browserProvider = (window as Window & { ethereum?: Eip1193Provider & { isRainbow?: boolean; providers?: Array<Eip1193Provider & { isRainbow?: boolean }> } }).ethereum;
  const rainbowProvider = browserProvider?.providers?.find((candidate) => candidate.isRainbow) ?? (browserProvider?.isRainbow ? browserProvider : undefined);
  const provider: Eip1193Provider = rainbowProvider ?? await getProvider();
  if (!rainbowProvider) await (provider as ProviderInstance).connect();
  await provider.request({ method: "eth_requestAccounts" });
  await ensureRobinhoodChain(provider);
  const accounts = await provider.request<string[]>({ method: "eth_accounts" });
  const address = accounts[0];
  if (!address) throw new Error("Wallet did not return an account.");
  const chainId = Number.parseInt(await provider.request<string>({ method: "eth_chainId" }), 16);
  return { provider, address, chainId };
}

export async function sendWalletTransaction(transaction: { to: string; data: string; value?: string }) {
  const { provider, address } = await connectWallet();
  const hash = await provider.request<string>({ method: "eth_sendTransaction", params: [{ from: address, to: transaction.to, data: transaction.data, value: transaction.value ?? "0x0" }] });
  return { hash, address };
}

export function installWalletButton(button: HTMLButtonElement, notify: (message: string) => void) {
  let address = "";
  const render = () => { button.innerHTML = address ? `${address.slice(0, 6)}…${address.slice(-4)} <span>FS</span>` : "Connect wallet"; };
  render();
  button.onclick = async () => {
    button.disabled = true;
    try { const session = await connectWallet(); address = session.address; render(); notify("Wallet connected on Robinhood Chain."); }
    catch (error) { notify(error instanceof Error ? error.message : "Wallet connection failed."); }
    finally { button.disabled = false; }
  };
  return () => { button.onclick = null; };
}
