# Security policy

Report vulnerabilities privately to [security@floatsheets.app](mailto:security@floatsheets.app). Do not disclose a vulnerability in a public issue before a fix is available.

We aim to acknowledge reports within 48 hours and address confirmed critical issues within seven days. Good-faith researchers acting to avoid privacy harm, service disruption, or loss of funds will be credited if they wish.

## Deployed contracts

FloatSheets is deployed on Robinhood Chain (chain ID `4663`) with two contract versions. The dashboard defaults to Meadow. Legacy Orion remains available for existing vault positions and withdrawals; the dashboard disables trading pages while Legacy Orion is selected. The contracts are not upgradeable, so code changes do not alter an existing deployment.

| Version | Oracle | Vault | Clearing house |
| --- | --- | --- | --- |
| FloatSheets Meadow | `0x7Fda40E8FD27cA067C9Ee23EA0Fd0cb8Bb786A8a` | `0xb74eD266A95d8393cDaF2Fa6cADd98b5a1D91875` | `0xc1AfA648C30090Aa8fDd3fbca384bd65b52B58Dd` |
| FloatSheets Legacy Orion | `0x072538824C9FD957B0b2530Bff4D3130897E711f` | `0xfCaa75781c11C414a6c25dF926D142C49501c810` | `0x76CB051b4E20621A96b7303b9Ee4C287fcB0E8F3` |

The Meadow contracts contain the newer risk controls described in [`contracts/README.md`](contracts/README.md). Those changes do not apply to Legacy Orion. The dashboard restriction is a user-interface safeguard; it does not make the old contracts inaccessible through direct transactions.

## Security considerations

High-risk surfaces include oracle manipulation or staleness, USDG pool manipulation, quote and risk-limit validation, contract ownership and signing keys, liquidation and vault liquidity accounting, and database or deployment credential exposure. The owner and signing keys are privileged; their custody and operational security are part of the protocol's trust assumptions. Review the contract and backend source before interacting with either version.

Verify the intended version and contract addresses against the current production configuration before sending funds. Addresses can change when a new deployment is released.
