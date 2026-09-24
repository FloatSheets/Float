# FloatSheets contracts

This is the Foundry workspace for FloatSheets on Robinhood Chain (chain ID `4663`).

The v2 implementation is intentionally pool-vs-trader: a single USDG vault backs every market, while traders use isolated USDG margin per market. It has no order book and never matches one trader against another.

- `FloatOracle.sol` stores EIP-712 signed, sequence-monotonic TWAP and spot-price attestations and enforces the configured spot/TWAP circuit breaker on-chain.
- `FloatVault.sol` is the shared USDG liquidity vault; only its permanently linked clearing house can settle trader PnL against it. Virtual shares protect deposits from donation inflation and allow recapitalization after total loss.
- `FloatClearingHouse.sol` verifies exact signed-size EIP-712 trade quotes bound to the caller and contract, enforces oracle freshness, leverage, exposure, liquidity, and fee limits, and enables permissionless full liquidation below maintenance margin. Liquidation rewards and trader refunds are pull-based so a recipient cannot block liquidation.

The audit-v1 findings have been remediated in this v2 candidate and are covered by local unit, invariant-style regression, and live Robinhood Chain fork tests against USDG. This work is not a substitute for an independent re-audit. The existing v1 contracts are non-upgradeable and are not changed by this repository update, so v2 must be deployed to new addresses and the backend/frontend must be switched over together before production use.

Run locally (the current macOS Foundry installation requires its bundled libusb path):

```sh
DYLD_LIBRARY_PATH=/Users/apple/.foundry/deps/libusb/lib forge test
```

## Deployment

Populate the variables in `.env` from `.env.example`, then run the deployment
script with the local deployer keystore:

```sh
set -a; source .env; set +a
DYLD_LIBRARY_PATH=/Users/apple/.foundry/deps/libusb/lib forge script script/DeployFloatSheets.s.sol \
  --rpc-url rhc --keystore deployer-keystore/deployer \
  --password-file .deployer-password --broadcast
```

The script deploys the oracle, shared vault, and clearing house and prints
their addresses. Set `OWNER_EOA_ADDRESS` to the deployer address to complete
the vault link in the same broadcast. If ownership is assigned to a separate
EOA, that owner must call `FloatVault.setClearingHouse(clearingHouse)` once
before deposits or trading.
The deployer keystore and password are intentionally ignored by Git.
