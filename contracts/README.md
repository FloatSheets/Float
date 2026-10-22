# FloatSheets contracts

This is the Foundry workspace for FloatSheets on Robinhood Chain (chain ID `4663`). FloatSheets Goldlake is the current immutable contract set; Silverlake and Amber are retained for existing positions and vault access, Jasper and Meadow are paused, and Legacy Orion remains available for legacy vault access.

FloatSheets Amber is a pool-vs-trader deployment: a single USDG vault backs every market, while traders use isolated USDG margin per market. It has no order book and never matches one trader against another.

- `FloatOracle.sol` stores EIP-712 signed, sequence-monotonic TWAP and spot-price attestations and enforces the configured spot/TWAP circuit breaker on-chain.
- `FloatVault.sol` prices queued LP deposits and withdrawals once per daily epoch using a NAV that marks open trader PnL. Virtual shares protect against donation inflation. A separately accounted insurance balance is spent before LP cash on trader payouts; unused insurance cannot be withdrawn by the owner.
- `FloatClearingHouse.sol` verifies exact signed-size EIP-712 trade quotes bound to the caller and contract, enforces oracle freshness, leverage, exposure, stress-reserve and fee limits, and enables permissionless liquidation below maintenance margin or after the seven-day maximum position duration. Crowded-side borrow fees accrue hourly and are sent to insurance. Uncovered losses are recorded as bad debt and pause risk-increasing trades until recapitalized. Deferred trader payouts can be claimed later.

Jasper risk defaults are explicit, conservative starting values rather than calibrated parameters: 25% stress move on net market skew, a 50% NAV cap on aggregate stress reserves, and borrow fees of 1 bp/hour plus up to 9 bp/hour as skew approaches one-sided. They should be monitored and independently reviewed before increasing risk.

Silverlake retains Amber's no-delay configuration, fixed 7.5% quote/oracle deviation cap, price-jump circuit breaker, fee floors, queue rounding conservation, and hourly payout cap. It replaces retroactive borrow-fee calculation with cumulative side-specific indexes checkpointed before exposure changes. Existing positions remain on their original contracts.

Goldlake is the current release. In addition to Silverlake's borrow-fee indexing, its oracle does not refresh the timestamp for a rejected price jump. The clearing house exposes NAV freshness for every exposed market and blocks liquidation on a circuit-broken mark. The vault protects pending deposits from payouts, blocks settlement on unsafe NAV, and lets LPs cancel an unfunded withdrawal request after the epoch settles without withdrawals.

### Silverlake deployment

- Oracle: `0xf935b2439E4B74F9Bd100148e4eFe3dE94DEF315`
- Vault: `0x9DA17d606453552bc7CD54f4d44813C8Acff55c4`
- Clearing house: `0xC197d8F546CC56A4148b30A74d3A2c5975255C6A`
- Deployment record: `deployments/silverlake-4663.json`
- Owner/deployer: `0x4a4c4e9Ad9afc8c5603ef5EA91cEf98CCdFE91f3`

The vault is linked to the clearing house. Ten launch markets are registered;
NVDA, SPCX, CRCL, MU, TSLA, RDDT, and MSTR are active, while HIMS, PLTR, and
QUBT are close-only. The backend publisher must have RH ETH to keep its oracle
attestations fresh.

### Goldlake deployment

- Oracle: `0xe47c7ab6e236e44CB888Ab08CE96f5839887C5Ec`
- Vault: `0x24B530f2ef4c76D10003e861182208ceA4120C45`
- Clearing house: `0xA1329C69e8EDA292cdA849BaBB990fbD05198cDb`
- Deployment record: `deployments/goldlake-4663.json`
- Owner/deployer: `0x4a4c4e9Ad9afc8c5603ef5EA91cEf98CCdFE91f3`

Runtime bytecode was compared with the local Foundry artifacts after masking immutable constructor values. Ten markets are registered; NVDA, SPCX, CRCL, MU, TSLA, RDDT, and MSTR are active, while HIMS, PLTR, and QUBT are close-only. The oracle publisher wallet must keep sufficient RH ETH to refresh enabled active market prices.

### Retired Amber deployment

- Oracle: `0x71B5FBd2df7eF976d02A4b4090450EEE24F77Ce0`
- Vault: `0xD5B0461F09C0Cb67AEd9Ca8e73569EAfa3a2E445`
- Clearing house: `0x022Cc8DFf79414DcB56812Bd93601854E2b7A700`

Runtime bytecode was compared with the local build. Ten markets are registered
without a delay; NVDA, SPCX, CRCL, MU, TSLA, RDDT, and MSTR are active, while
HIMS, PLTR, and QUBT are close-only. The deployment record is
`deployments/amber-4663.json`.

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
The ten configured markets are NVDA, SPCX, CRCL, HIMS, MU, TSLA, RDDT, MSTR,
PLTR, and QUBT. NVDA, SPCX, CRCL, HIMS, MU, TSLA, RDDT, and MSTR are active;
PLTR and QUBT are close-only. Each configured price used a fresh pool TWAP and
spot observation. HIMS was switched to active after its spot/TWAP deviation
returned below the 50 bps breaker. Oracle prices expire after 120 seconds, so
the backend's publisher must keep running against a working Robinhood RPC.

`ConfigureFloatMarkets.s.sol` runs four markets at a time using
`MARKET_BATCH_INDEX` (0, 1, or 2) to keep each attestation batch inside its
expiry window. Supply separate `PRICE_<SYMBOL>_E18` and `SPOT_<SYMBOL>_E18`
values from validated current observations; do not seed from old oracle prices.
The deployer keystore and password are intentionally ignored by Git.
