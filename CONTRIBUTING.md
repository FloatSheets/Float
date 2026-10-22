# Contributing to FloatSheets

## Project scope

Contributions are welcome across the frontend, backend API and market-data service, Solidity contracts, deployment tooling, security controls, tests, and documentation. Silverlake is the intended version for new trading; Amber, Jasper, and Meadow remain separate retired deployments, and Legacy Orion remains available for vault access. Changes involving contracts or protocol transactions should identify the affected version and preserve legacy withdrawals.

The contracts manage real on-chain positions and vault liquidity. Production deployments and configuration changes require explicit maintainer authorization. Describe required deployment and environment changes in the pull request.

## Setup

Use Bun 1.4+ and PostgreSQL for the backend. Run `bun install` at the repository root for the frontend, then `cd backend && bun install` for the API. Copy `backend/.env.example` to `backend/.env` and populate the required local values. Never commit `.env` files, private keys, RPC credentials, or production secrets.

Install Foundry to build and test the Solidity contracts. See [`contracts/README.md`](contracts/README.md) for contract details and commands.

## Workflow

Fork, create a focused branch, and make one concern per pull request. Include unit, fuzz, and invariant tests for behavioral changes. Before submitting, run the relevant checks, such as `cd backend && bun test && bun run check`, `cd contracts && forge test`, and `forge coverage --report lcov` followed by `python3 scripts/check-branch-coverage.py lcov.info 80`.

Use imperative, present-tense commit subjects, for example: `add pool snapshot reader`.

## Bug reports

Include the market or pool inspected, observed result, expected result, timestamp, chain and RPC used, and concise reproduction steps. Do not include secret values or private wallet material.

## Security

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md) for reporting instructions and deployed protocol information.
