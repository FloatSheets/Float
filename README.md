![CI](https://github.com/floatsheets/float/actions/workflows/backend.yml/badge.svg)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-1.4-000000?logo=bun&logoColor=white)
![TanStack](https://img.shields.io/badge/TanStack_Start-1.x-FF4154?logo=tanstack&logoColor=white)
![Robinhood Chain](https://img.shields.io/badge/Robinhood_Chain-4663-00C805)

# FloatSheets

**USDG-settled synthetic equity perps on Robinhood Chain.** FloatSheets uses direct Uniswap V3 stock/USDG pools as live liquidity references for quote quality and risk limits, while USDG remains the sole collateral, PnL, fee, liquidation, and settlement asset.

## Initial market configuration

| Group | Markets | Leverage | Max ticket | Half-spread band |
| --- | --- | ---: | ---: | ---: |
| Standard | NVDA, SPCX | 5x | $50,000 | 15–30 bps |
| Standard | CRCL, HIMS | 4x | $25,000 | 40–80 bps |
| Standard | MU, TSLA | 3x | $10,000 | 50–150 bps |
| Standard | RDDT, MSTR | 2x | $5,000 | 125–300 bps |
| Restricted | PLTR | 2x | $10,000 | 75–500 bps |
| Pilot | QUBT | 2x | $1,000 | 100–750 bps |

AMC and GME remain excluded until their direct stock/USDG pool quotes pass validation.

## How it works

1. A market monitor samples the direct stock/USDG V3 pool and its executable quotes.
2. The backend records the pool TWAP and spot price, checks their deviation, and publishes eligible market attestations to the configured on-chain oracle.
3. FloatSheets accepts a trade only inside its market’s leverage, ticket, spread, oracle-health, liquidity, and open-interest limits.
4. All balances and settlement remain denominated in USDG; pool data informs marks, risk, and hedgeability rather than changing collateral denomination.

## API

The production backend is available at [`https://api.floatsheets.app`](https://api.floatsheets.app). Configure the frontend's `VITE_API_URL` and server-only `FLOATSHEETS_API_URL` with this base URL.

| Endpoint | Description |
| --- | --- |
| `GET /health` | Process status, timestamp, and version. Does not check database connectivity. |
| `GET /ready/` | Database readiness check. |
| `GET /v1/markets/` | Configured markets and each market's latest stored pool snapshot. |
| `GET /v1/markets/:symbol` | Static market configuration. |
| `GET /v1/markets/:symbol/live` | Current monitored and on-chain oracle/market state. |
| `GET /v1/markets/:symbol/quotes` | Latest complete executable quote sample matrix. |
| `GET /v1/markets/:symbol/history?range=1H` | Stored TWAP/spot history; supported ranges are `1H`, `4H`, `1D`, `1W`, and `1M`. Add `format=candles` for candles. |
| `GET /v1/markets/:symbol/risk` | Monitored risk state and latest snapshot age. |

### What the backend database stores

PostgreSQL stores the seeded market configuration (`markets`), sampled pool and price observations (`pool_snapshots`), executable quote samples (`quote_samples`), monitor run/failure diagnostics (`monitor_runs`, `monitor_failures`), and applied migration names (`schema_migrations`). The backend does not store user accounts, wallet keys, deposits, positions, or trade settlement history; those are not database tables in this service. On-chain balances and positions live in the contracts and chain state.

A fresh database applies migrations at backend startup. The initial migration seeds the configured markets; the monitor then repopulates snapshots and quote samples on its polling cycle. A database replacement therefore loses the old historical snapshots, quote samples, and monitor diagnostics, but market configuration is seeded again. History endpoints only have data recorded in the new database, so charts fill forward rather than recovering the old database's history. Current service readiness and market data are served from the API above; no old database backup or history was inspected.

## Repository structure

| Path | Purpose |
| --- | --- |
| `/src` | TanStack Start/Vite frontend. |
| `/backend` | Bun, Express, TypeScript, PostgreSQL API and migrations. |
| `/contracts` | Foundry workspace containing the Robinhood Chain oracle, shared vault, clearing house, deployment scripts, and tests. Check `contracts/README.md` and `contracts/AUDIT_READINESS.md` for implementation and deployment status. |
| `/.github/workflows` | Backend tests, GHCR image build/publish, release, and optional Render hook. |

## Getting started

Prerequisites: Bun 1.4+ and PostgreSQL. Install Foundry to build or test the Solidity contracts.

```sh
# frontend
bun install
cp .env.example .env
bun run dev

# backend, in a second terminal
cd backend
bun install
# Keep your supplied backend/.env; otherwise copy .env.example and configure it.
bun run dev
```

Run backend verification:

```sh
cd backend
bun run check
bun test
```

## Deployments

### Render backend

Use a Render **Native Environment** service rooted at `backend`:

| Setting | Value |
| --- | --- |
| Runtime | Bun |
| Root directory | `backend` |
| Build command | `bun install --frozen-lockfile && bun run check` |
| Start command | `bun run start` |
| Health check | `/health` |

Set `DATABASE_URL`, `DATABASE_PASSWORD`, `RHC_ID`, `RHC_RPC_URL`, `PROTOCOL_FEE_WALLET`, `FRONTEND_URL`, `NODE_ENV=production`, and Render’s `PORT`. The API applies migrations during startup.

The public repository's GitHub workflow also publishes `ghcr.io/floatsheets/float-backend:latest` and a SHA-tagged image. If Render is configured to pull the GHCR image instead, provide registry credentials when the package is private. Set `RENDER_DEPLOY_HOOK_URL` in the public repository's Actions secrets to have successful backend image builds trigger Render automatically.

### Vercel frontend

Connect the repository with the root directory set to the repository root. Use `bun run build` as the build command. Configure `VITE_API_URL` to the deployed backend URL for read-only live market hydration, and configure the same origin as the server-only `FLOATSHEETS_API_URL` variable for TanStack Start server functions. Never prefix the BFF origin or `MASTER_ADMIN_KEY` with `VITE_`.

## Roadmap

| Phase | Outcome |
| --- | --- |
| 1 — Market data | Pool sampler, executable quote matrix, oracle adapter, and risk-state API. |
| 2 — Trading controls | USDG margin ledger, spread engine, OI/skew limits, liquidation controls. |
| 3 — Protocol hardening | Reconcile deployment state, complete independent review, and validate operations for the existing Solidity protocol. |
| 4 — Launch | Confirm deployment readiness, then use a limited market rollout with monitored caps before measured expansion. |

## Tech stack

TanStack Start, Vite, React, Tailwind, Bun, Express, TypeScript, PostgreSQL, Foundry, Robinhood Chain, and Uniswap V3.
