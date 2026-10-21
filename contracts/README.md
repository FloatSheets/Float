# FloatSheets contracts

This is the Foundry workspace for FloatSheets on Robinhood Chain (chain ID `4663`).

FloatSheets Jasper is a new pool-vs-trader deployment: a single USDG vault backs every market, while traders use isolated USDG margin per market. It has no order book and never matches one trader against another.

- `FloatOracle.sol` stores EIP-712 signed, sequence-monotonic TWAP and spot-price attestations and enforces the configured spot/TWAP circuit breaker on-chain.
- `FloatVault.sol` prices queued LP deposits and withdrawals once per daily epoch using a NAV that marks open trader PnL. Virtual shares protect against donation inflation. A separately accounted insurance balance is spent before LP cash on trader payouts; unused insurance cannot be withdrawn by the owner.
- `FloatClearingHouse.sol` verifies exact signed-size EIP-712 trade quotes bound to the caller and contract, enforces oracle freshness, leverage, exposure, stress-reserve and fee limits, and enables permissionless liquidation below maintenance margin or after the seven-day maximum position duration. Crowded-side borrow fees accrue hourly and are sent to insurance. Uncovered losses are recorded as bad debt and pause risk-increasing trades until recapitalized. Deferred trader payouts can be claimed later.

Jasper risk defaults are explicit, conservative starting values rather than calibrated parameters: 25% stress move on net market skew, a 50% NAV cap on aggregate stress reserves, and borrow fees of 1 bp/hour plus up to 9 bp/hour as skew approaches one-sided. They should be monitored and independently reviewed before increasing risk.

The selected audit remediations have local regression coverage. These changes alter vault NAV, liquidity availability and LP withdrawal timing. This work is not a substitute for an independent re-audit. Existing contracts are non-upgradeable, so Jasper must be deployed to new addresses and the backend/frontend must be switched over together before production use.

Run locally (the current macOS Foundry installation requires its bundled libusb path):

```sh
forge test
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

### Jasper deployment on Robinhood Chain

The Jasper contracts were deployed at block `94292113` and the vault is linked
to its clearing house:

- Oracle: `0x2C21CEe824Ed6BD4380F60a610F179f2f7b555E0`
- Vault: `0xAAd35a630D6bFDBd1b46495721e9C6979844F960`
- Clearing house: `0x82889877B395840BC0efce625C06c5423C75B029`

The machine-readable deployment record is `deployments/jasper-4663.json`.
The contracts are deployed but markets still need fresh price attestations and
market configuration before trading can be enabled. Do not seed them from old
oracle prices; the configuration transaction must use current validated TWAPs.
The deployer keystore and password are intentionally ignored by Git.
