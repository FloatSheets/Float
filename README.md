![CI](https://github.com/notadeveloper7/floatsheets/actions/workflows/backend.yml/badge.svg)
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
2. An external stock oracle supplies the mark-price reference.
3. FloatSheets accepts a trade only inside its market’s leverage, ticket, spread, oracle-health, liquidity, and open-interest limits.
4. All balances and settlement remain denominated in USDG; pool data informs risk and hedgeability rather than changing collateral denomination.

## API

| Endpoint | Description |
| --- | --- |
| `GET /health` | Service status, ISO timestamp, and version. |

## Repository structure

| Path | Purpose |
| --- | --- |
| `/src` | TanStack Start/Vite frontend. |
| `/backend` | Bun, Express, TypeScript, PostgreSQL API and migrations. |
| `/contracts` | Foundry workspace for future Robinhood Chain contracts; no deployable protocol contract yet. |
| `/.github/workflows` | Backend tests, GHCR image build/publish, release, and optional Render hook. |

## Getting started

Prerequisites: Bun 1.4+, PostgreSQL, and (for the future contract workspace) Foundry.

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

The GitHub workflow also publishes `ghcr.io/notadeveloper7/floatsheets-backend:latest` and a SHA-tagged image. If Render is configured to pull the GHCR image instead, provide registry credentials when the package is private. Set `RENDER_DEPLOY_HOOK_URL` as a repository secret to have successful backend image builds trigger Render automatically.

### Vercel frontend

Connect the repository with the root directory set to the repository root. Use `bun run build` as the build command. Configure `VITE_API_URL` to the deployed backend URL for read-only live market hydration, and configure the same origin as the server-only `FLOATSHEETS_API_URL` variable for TanStack Start server functions. Never prefix the BFF origin or `MASTER_ADMIN_KEY` with `VITE_`.

## Roadmap

| Phase | Outcome |
| --- | --- |
| 1 — Market data | Pool sampler, executable quote matrix, oracle adapter, and risk-state API. |
| 2 — Trading controls | USDG margin ledger, spread engine, OI/skew limits, liquidation controls. |
| 3 — Contracts | Decide custody and clearing architecture, implement, audit, and test on Robinhood Chain. |
| 4 — Launch | Limited market rollout, monitored caps, then measured market expansion. |

## Tech stack

TanStack Start, Vite, React, Tailwind, Bun, Express, TypeScript, PostgreSQL, Foundry, Robinhood Chain, and Uniswap V3.
