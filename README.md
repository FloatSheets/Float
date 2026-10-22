![CI](https://github.com/floatsheets/float/actions/workflows/backend.yml/badge.svg)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-1.4-000000?logo=bun&logoColor=white)
![TanStack](https://img.shields.io/badge/TanStack_Start-1.x-FF4154?logo=tanstack&logoColor=white)
![Robinhood Chain](https://img.shields.io/badge/Robinhood_Chain-4663-00C805)

# FloatSheets

**USDG-settled synthetic equity perps on Robinhood Chain.** FloatSheets uses direct Uniswap V3 stock/USDG pools as live liquidity references for quote quality and risk limits, while USDG remains the sole collateral, PnL, fee, liquidation, and settlement asset.

**TOKEN CA:** `0x4a67ea0d194058558f4926b6bf6b758ef8976675` ([View on Dexscreener](https://dexscreener.com/robinhood/0x4a67ea0d194058558f4926b6bf6b758ef8976675))

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

## Contract versions

| Version | Status | Dashboard behavior |
| --- | --- | --- |
| FloatSheets Goldlake | Deployed; markets registered and configured | Default for new positions |
| FloatSheets Silverlake | Deployed predecessor; retain for existing positions and vault access | Existing positions only |
| FloatSheets Amber | Deployed predecessor; retain for existing position close and vault access | Retired, disabled in selector |
| FloatSheets Jasper | Paused on-chain | Visible in settings, disabled |
| FloatSheets Meadow | Paused on-chain | Visible in settings, disabled |
| FloatSheets Legacy Orion | Legacy deployment | Vault viewing and withdrawals; trade, portfolio, oracle, and listings pages are disabled |

Goldlake is the current immutable release. It includes the oracle freshness, vault NAV, and queued-withdrawal protections described below. Its runtime bytecode matches the local Foundry artifacts, and deployment plus market configuration transactions are recorded in [`contracts/deployments/goldlake-4663.json`](contracts/deployments/goldlake-4663.json). Silverlake remains available for existing positions and vault access; new positions use Goldlake. Oracle publishing must remain funded for fresh prices.

| Goldlake contract | Robinhood Chain address |
| --- | --- |
| Clearing house | `0xA1329C69e8EDA292cdA849BaBB990fbD05198cDb` |
| Oracle | `0xe47c7ab6e236e44CB888Ab08CE96f5839887C5Ec` |
| Vault | `0x24B530f2ef4c76D10003e861182208ceA4120C45` |

| Silverlake contract | Robinhood Chain address |
| --- | --- |
| Clearing house | `0xC197d8F546CC56A4148b30A74d3A2c5975255C6A` |
| Oracle | `0xf935b2439E4B74F9Bd100148e4eFe3dE94DEF315` |
| Vault | `0x9DA17d606453552bc7CD54f4d44813C8Acff55c4` |

| Amber contract | Robinhood Chain address |
| --- | --- |
| Clearing house | `0x022Cc8DFf79414DcB56812Bd93601854E2b7A700` |
| Oracle | `0x71B5FBd2df7eF976d02A4b4090450EEE24F77Ce0` |
| Vault | `0xD5B0461F09C0Cb67AEd9Ca8e73569EAfa3a2E445` |

## Trust model

FloatSheets deliberately uses a single EOA for protocol administration. The quote service remains the primary trade path. FloatSheets continues to use its currently configured market feeds without adding licensed feeds. Configuration changes, signer rotations, ownership changes, and market changes have no timelock; pauses and risk reductions are immediate. Contract code enforces a 7.5% maximum quote-to-oracle deviation, a 20% price-jump circuit breaker, and a 5% per-hour cap on vault-funded trader payouts. Excess payout requests become claims, so the cap does not block position closes.

The EOA and signing keys remain trusted. A compromised quote signer can issue executions within the on-chain limits; an administrator can change risk settings or pause markets without a delay; and the oracle signer can attest prices derived from configured feeds. This design does not provide multisig protection, independent licensed feeds, or a separate fallback-close path.

## How it works

1. A market monitor samples the direct stock/USDG V3 pool and its executable quotes.
2. The backend records the pool TWAP and spot price, checks their deviation, and publishes eligible market attestations to the configured on-chain oracle.
3. FloatSheets accepts a trade only inside its market’s leverage, ticket, spread, oracle-health, liquidity, and open-interest limits.
4. All balances and settlement remain denominated in USDG; pool data informs marks, risk, and hedgeability rather than changing collateral denomination.

## API

The production backend is available at [`https://api.floatsheets.app`](https://api.floatsheets.app). Configure `FLOATSHEETS_API_URL` as a server-only frontend environment variable; browser requests use TanStack Start server functions and do not call the backend origin directly.

| Endpoint | Description |
| --- | --- |
| `GET /health` | Process status, timestamp, and version. Does not check database connectivity. |
| `GET /ready/` | Database readiness check. |
| `GET /v1/markets/` | Configured markets and each market's latest stored pool snapshot. |
| `GET /v1/markets/:symbol` | Static market configuration. |
| `GET /v1/markets/:symbol/live` | Current monitored and on-chain oracle/market state. Includes `opening_bell` terms during the first 10 minutes after the 9:30 ET open, when new positions pay +15 bps and use half the max ticket. |
| `GET /v1/markets/:symbol/quotes` | Latest complete executable quote sample matrix. |
| `GET /v1/markets/:symbol/history?range=1H` | Stored TWAP/spot history; supported ranges are `1H`, `4H`, `1D`, `1W`, and `1M`. Add `format=candles` for candles. |
| `GET /v1/keeper` | Protocol keeper status: watched positions, liquidations, expiry closes, and recent keeper transactions. |
| `GET /v1/status` | Public system status shown at `/status/`: component health checked every minute, 90-day uptime, current market restrictions, and incidents that open after two failed checks and resolve on recovery. Administrators add post-mortems with `POST /v1/status/incidents/:id/postmortem`. |
| `GET /v1/markets/halts` | Listing-exchange trading halts mirrored from the Nasdaq Trader halt feed. A halted market is close-only until the exchange resumes trading. |
| `GET /v1/markets/weekend-bands` | Weekend and holiday price bands. While a market's underlying is closed, opens pause if its pool leaves the band around the last close, and oracle marks are held inside it. |
| `GET /v1/markets/corporate-actions` | Upcoming splits and cash dividends from the Nasdaq calendars. Markets go close-only 7 days before a split (positions cannot be resized, and every open position reaches its 7-day limit first) and around dividends of 2% or more; smaller dividends show a notice with the expected price drop. |
| `GET /v1/protocol/transactions/weekend-allowance?market=&trader=` | A wallet's remaining weekend allowance on a market. While the underlying is closed, each wallet may add up to 25% of the market's max ticket per closure, with a 5-minute cooldown between executed opens. Closes are never limited. |
| `GET /v1/markets/:symbol/risk` | Monitored risk state and latest snapshot age. |

### What the backend database stores

PostgreSQL stores the seeded market configuration (`markets`), sampled pool and price observations (`pool_snapshots`), executable quote samples (`quote_samples`), monitor run/failure diagnostics (`monitor_runs`, `monitor_failures`), and applied migration names (`schema_migrations`). For liquidation alerts, it stores wallet-bound email preferences and verification state, optionally linked Telegram chat identifiers and usernames, and notification delivery state. It does not store wallet keys, deposits, positions, or trade settlement history; on-chain balances and positions live in the contracts and chain state.

A fresh database applies migrations at backend startup. The initial migration seeds the configured markets; the monitor then repopulates snapshots and quote samples on its polling cycle. A database replacement therefore loses the old historical snapshots, quote samples, and monitor diagnostics, but market configuration is seeded again. History endpoints only have data recorded in the new database, so charts fill forward rather than recovering the old database's history. Current service readiness and market data are served from the API above; no old database backup or history was inspected.

## Repository structure

| Path | Purpose |
| --- | --- |
| `/src` | TanStack Start/Vite frontend. |
| `/backend` | Bun, Express, TypeScript, PostgreSQL API and migrations. |
| `/contracts` | Foundry workspace containing the Robinhood Chain oracle, shared vault, clearing house, deployment scripts, and regression, fuzz, and invariant tests. Check `contracts/README.md` and `contracts/AUDIT_READINESS.md` for deployment status. |
| `/.github/workflows` | Backend, frontend, and contract checks; GHCR image build/publish, release, and optional Render hook. |

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

Set `DATABASE_URL`, `DATABASE_PASSWORD`, `RHC_ID`, `RHC_RPC_URL`, `PROTOCOL_FEE_WALLET`, `FRONTEND_URL`, `NODE_ENV=production`, and Render’s `PORT`. Goldlake addresses are the backend defaults; keep the Silverlake, Amber, Jasper, Meadow, and Orion address variables populated for existing positions and vault flows. Keep the oracle publisher wallet funded with RH ETH so price attestations stay fresh. Set `SERVER_API_SHARED_SECRET` to the same random value used by Vercel's `FLOATSHEETS_SERVER_API_SECRET`; these authenticate forwarded client IPs for close-quote rate limits. For Telegram liquidation alerts, set the server-only `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME` on the backend service. The API applies migrations during startup.

The public repository's GitHub workflow also publishes `ghcr.io/floatsheets/float-backend:latest` and a SHA-tagged image. If Render is configured to pull the GHCR image instead, provide registry credentials when the package is private. Set `RENDER_DEPLOY_HOOK_URL` in the public repository's Actions secrets to have successful backend image builds trigger Render automatically.

### Vercel frontend

Connect the repository with the root directory set to the repository root and use `bun run build` as the build command. Set `FLOATSHEETS_API_URL` to the deployed backend URL and `FLOATSHEETS_SERVER_API_SECRET` to the shared server-to-server secret as server-only Vercel environment variables. Browser market-data and protocol requests go through TanStack Start server functions; do not expose the backend origin or secret through a `VITE_` variable. Never prefix `MASTER_ADMIN_KEY` with `VITE_`.

## Roadmap

| Phase | Outcome |
| --- | --- |
| 1 — Market data | Pool sampler, executable quote matrix, oracle adapter, and risk-state API. |
| 2 — Trading controls | USDG margin ledger, spread engine, OI/skew limits, liquidation controls. |
| 3 — Protocol hardening | Reconcile deployment state, complete independent review, and validate operations for the existing Solidity protocol. |
| 4 — Launch | Confirm deployment readiness, then use a limited market rollout with monitored caps before measured expansion. |

## Tech stack

TanStack Start, Vite, React, Tailwind, Bun, Express, TypeScript, PostgreSQL, Foundry, Robinhood Chain, and Uniswap V3.
