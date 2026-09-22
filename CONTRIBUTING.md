# Contributing to FloatSheets

## Current scope

Useful contributions are the USDG market-data service, direct stock/USDG pool monitoring, quote-risk controls, dashboard integration, tests, and documentation. Smart-contract trading, custody, and deployment work are not in scope until the protocol design is approved.

## Setup

Use Bun 1.4+. Run `bun install` at the root for the frontend, then `cd backend && bun install` for the API. Copy `backend/.env.example` to `backend/.env` and populate the required values.

## Workflow

Fork, create a focused branch, make one concern per pull request, and include tests for backend changes. Use imperative, present-tense commit subjects, for example: `add pool snapshot reader`.

## Bug reports

Include the market/pool inspected, observed result, expected result, timestamp, chain/RPC used, and concise reproduction steps.

## Security

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
