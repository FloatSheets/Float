export function installWalletButton(button: HTMLButtonElement, notify: (message: string) => void) {
  const managed = button as HTMLButtonElement & { __floatsheetsWalletCleanup?: () => void };
  managed.__floatsheetsWalletCleanup?.();
  const render = () => {
    const state = (window as Window & { __FLOATSHEETS_WALLET_STATE__?: { address: string; connected: boolean; usdgBalance?: string } }).__FLOATSHEETS_WALLET_STATE__;
    if (!state?.connected || !state.address) {
      button.textContent = "Connect wallet";
      return;
    }
    button.replaceChildren(
      document.createTextNode(`${state.address.slice(0, 6)}…${state.address.slice(-4)} · ${Number(state.usdgBalance ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} `),
      Object.assign(document.createElement("img"), { src: "/usdg_logo.png", alt: "USDG", className: "wallet-usdg-icon" }),
      document.createTextNode(" USDG")
    );
  };
  render();
  const onState = () => { render(); notify("Wallet state updated."); };
  window.addEventListener("floatsheets-wallet-state", onState);
  button.onclick = () => {
    const open = (window as Window & { __FLOATSHEETS_OPEN_WALLET__?: () => void }).__FLOATSHEETS_OPEN_WALLET__;
    if (open) open(); else notify("Wallet interface is still loading.");
  };
  const cleanup = () => { button.onclick = null; window.removeEventListener("floatsheets-wallet-state", onState); };
  managed.__floatsheetsWalletCleanup = cleanup;
  return cleanup;
}
