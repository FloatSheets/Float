# Security policy

Report vulnerabilities privately to [security@floatsheets.app](mailto:security@floatsheets.app). Do not disclose a vulnerability in a public issue before a fix is available.

We aim to acknowledge reports within 48 hours and address confirmed critical issues within seven days. Good-faith researchers acting to avoid privacy harm, service disruption, or loss of funds will be credited if they wish.

## Contract versions

Contract versions are immutable and changing protocol logic requires a new address set. Amber is deployed, runtime-bytecode verified, and configured with no-delay market changes. Jasper and Meadow are paused on-chain. Orion remains available for legacy vault access. The current version table and deployment status are in [`README.md`](README.md).

## Trust model

FloatSheets uses one EOA for administration. The quote service remains the primary signed execution path. The protocol continues to use its currently configured market feeds and adds no licensed feeds. Configuration, ownership, signer, and market changes have no timelock; pausing and risk reductions are immediate. This leaves compromised admin keys able to change protocol settings without a delay. Amber caps quote deviation from the oracle at 7.5%, trips a circuit breaker on a per-attestation price jump above 20%, and limits vault-funded trader payouts to 5% of NAV per hour. Excess payouts remain claims and do not stop closes.

The EOA, quote signer, and oracle signer remain trusted. These controls constrain the keys' actions but do not remove their trust or the risk of eventual payout obligations. There is no multisig and no separate fallback-close transaction path.

## Security considerations

High-risk surfaces include oracle manipulation or staleness, USDG pool manipulation, quote and risk-limit validation, contract ownership and signing keys, liquidation and vault liquidity accounting, and database or deployment credential exposure. Review the contract and backend source before interacting with a deployment.

Verify the intended version and contract addresses against the current production configuration before sending funds. Addresses can change when a new deployment is released.
