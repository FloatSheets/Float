# Contributing to FloatSheets

## Project scope

Contributions are welcome across the frontend, backend API and market-data service, Solidity contracts, deployment tooling, security controls, tests, and documentation. FloatSheets supports two Robinhood Chain contract versions: Meadow and Legacy Orion. Changes involving contracts or protocol transactions should state which version they affect and preserve the behavior of the other version unless the change intentionally updates it too.

The contracts are deployed and manage real on-chain positions and vault liquidity. Do not deploy contracts, send funds, or change production configuration as part of a contribution. Describe any required deployment or environment changes in the pull request so maintainers can review and perform them separately.

## Setup

Use Bun 1.4+ and PostgreSQL for the backend. Run `bun install` at the repository root for the frontend, then `cd backend && bun install` for the API. Copy `backend/.env.example` to `backend/.env` and populate the required local values. Never commit `.env` files, private keys, RPC credentials, or production secrets.

Install Foundry to build and test the Solidity contracts. See [`contracts/README.md`](contracts/README.md) for contract details and commands.

## Workflow

Fork, create a focused branch, and make one concern per pull request. Include or update tests for behavioral changes. Before submitting, run the relevant checks, such as `cd backend && bun test && bun run check` or `cd contracts && forge test`.

Use imperative, present-tense commit subjects, for example: `add pool snapshot reader`.

## Bug reports

Include the market or pool inspected, observed result, expected result, timestamp, chain and RPC used, and concise reproduction steps. Do not include secret values or private wallet material.

## Security

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md) for reporting instructions and deployed protocol information.
