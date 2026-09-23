# FloatSheets contracts

This is the Foundry workspace for FloatSheets on Robinhood Chain (chain ID `4663`).

The first implementation is intentionally pool-vs-trader: a single USDG vault backs every market, while traders use isolated USDG margin per market. It has no order book and never matches one trader against another.

- `FloatOracle.sol` stores EIP-712 signed, sequence-monotonic price attestations.
- `FloatVault.sol` is the shared USDG liquidity vault; only the clearing house can settle trader PnL against it.
- `FloatClearingHouse.sol` verifies EIP-712 trade quotes bound to the caller and contract, enforces fresh oracle price/sequence/deviation, leverage and per-market position caps, and enables permissionless full liquidation below maintenance margin.

The contracts compile and the oracle's signature/replay/expiry/access controls are covered by Foundry tests. They are not audited and must not be deployed with production capital until clearing/vault integration tests against actual USDG, formal risk review, and an external audit are complete.

Run locally (the current macOS Foundry installation requires its bundled libusb path):

```sh
DYLD_LIBRARY_PATH=/Users/apple/.foundry/deps/libusb/lib forge test
```
