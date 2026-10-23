import type { Pool } from "pg";
import type { Address } from "viem";

import { marketId } from "../chain/protocol";
import { readOraclePrice } from "../chain/protocol-read";
import type { RpcTransport } from "../chain/rpc";
import { readCorporateActions, type CorporateActionOptions } from "../markets/corporate-actions";
import { readActiveHalts } from "../markets/halts";
import { safeErrorMessage } from "../safe-error";

export type ComponentStatus = "operational" | "degraded" | "outage";
export type CheckResult = { status: ComponentStatus; detail: string | null };

export const COMPONENTS = {
  api: "API & database",
  chain: "Robinhood Chain RPC",
  market_data: "Market data (pool sampler)",
  oracle: "On-chain oracle marks",
  keeper: "Position keeper",
  halt_feed: "Exchange halt feed",
  corporate_actions: "Corporate action calendars"
} as const;
export type ComponentId = keyof typeof COMPONENTS;

/** An incident opens after this many consecutive failed checks. */
const FAILURES_TO_OPEN = 2;
const HISTORY_DAYS = 90;

export type StatusDependencies = {
  rpc: RpcTransport;
  oracle: Address;
  marketPollIntervalMs: number;
  keeperIntervalSeconds: number;
  keeperEnabled: boolean;
  haltFeedEnabled: boolean;
  haltPollSeconds: number;
  corporateActions: CorporateActionOptions;
  corporateActionPollSeconds: number;
  keeperStatus: () => Promise<{ last_run_finished_at: string | null; last_error: string | null }>;
  /** Copper weekend closure autopilot: an owner action that is due or was missed. */
  copperClosure?: () => Promise<{ action: string | null; summary: string | null } | null>;
};

function ageSeconds(at: Date | string | null | undefined, now: Date): number | null {
  if (!at) return null;
  return (now.getTime() - new Date(at).getTime()) / 1_000;
}

function minutes(seconds: number): string {
  return seconds < 120 ? `${Math.round(seconds)}s` : `${Math.round(seconds / 60)} min`;
}

/**
 * Public status for FloatSheets. Each check reports what a trader or LP would
 * notice: stale prices, a stopped keeper, a halt feed that cannot see
 * exchange halts. Results are stored for uptime history, and repeated failures
 * open an incident that resolves itself on recovery.
 */
export class StatusMonitor {
  constructor(private readonly database: Pool, private readonly deps: StatusDependencies) {}

  private sampleAgeLimitSeconds(): number {
    return Math.max(120, (this.deps.marketPollIntervalMs / 1_000) * 4);
  }

  async check(now: Date = new Date()): Promise<Record<ComponentId, CheckResult>> {
    const run = async (fn: () => Promise<CheckResult>): Promise<CheckResult> => {
      try { return await fn(); } catch (error) { return { status: "outage", detail: safeErrorMessage(error) }; }
    };
    const api = await run(async () => {
      await this.database.query("SELECT 1");
      return { status: "operational", detail: null };
    });
    if (api.status !== "operational") {
      // Without the database nothing else can be evaluated or recorded.
      return Object.fromEntries(Object.keys(COMPONENTS).map((id) => [id, id === "api" ? api : { status: "outage", detail: "database unavailable" }])) as Record<ComponentId, CheckResult>;
    }
    const listed = await this.database.query<{ symbol: string; observed_at: Date | null; price_source: string | null }>(
      `SELECT m.symbol, s.observed_at, m.price_source FROM public.markets m LEFT JOIN LATERAL (
         SELECT observed_at FROM public.pool_snapshots WHERE market_id=m.id ORDER BY observed_at DESC LIMIT 1
       ) s ON true WHERE m.listed = TRUE AND m.status <> 'disabled' ORDER BY m.symbol`
    );
    const results: Record<ComponentId, CheckResult> = {
      api,
      chain: await run(async () => {
        const first = listed.rows[0];
        if (first) await readOraclePrice(this.deps.rpc, this.deps.oracle, marketId(first.symbol));
        return { status: "operational", detail: null };
      }),
      market_data: await run(async () => {
        const limit = this.sampleAgeLimitSeconds();
        const isStale = (row: { observed_at: Date | null }) => (ageSeconds(row.observed_at, now) ?? Infinity) > limit;
        // Pool-priced markets are sampled every poll, so a stale one means the sampler failed.
        const pools = listed.rows.filter((row) => row.price_source !== "reference");
        const stale = pools.filter(isStale).map((row) => row.symbol);
        // Reference-priced (penny) markets only record a price once their quote is live; one
        // waiting on a quote is a market restriction, not a sampler failure. Only report the
        // feed itself when none of them has a live price.
        const reference = listed.rows.filter((row) => row.price_source === "reference");
        const referenceDown = reference.length > 0 && reference.every(isStale);
        if (stale.length === 0 && !referenceDown) return { status: "operational", detail: null };
        const details = [
          ...(stale.length ? [`Stale pool samples: ${stale.join(", ")}`] : []),
          ...(referenceDown ? ["No live penny-stock prices from the reference quote feeds"] : [])
        ];
        return { status: pools.length > 0 && stale.length === pools.length ? "outage" : "degraded", detail: details.join("; ") };
      }),
      oracle: await run(async () => {
        const broken: string[] = [];
        for (const row of listed.rows) {
          const price = await readOraclePrice(this.deps.rpc, this.deps.oracle, marketId(row.symbol));
          if (price.sequence !== 0n && price.circuitBroken) broken.push(row.symbol);
        }
        return broken.length
          ? { status: "degraded", detail: `Circuit breaker holding the last good price: ${broken.join(", ")}` }
          : { status: "operational", detail: null };
      }),
      keeper: await run(async () => {
        if (!this.deps.keeperEnabled) return { status: "degraded", detail: "Keeper is disabled" };
        const keeper = await this.deps.keeperStatus();
        const age = ageSeconds(keeper.last_run_finished_at, now);
        if (age === null || age > this.deps.keeperIntervalSeconds * 4) return { status: "outage", detail: age === null ? "Keeper has not completed a run" : `Last keeper run ${minutes(age)} ago` };
        return keeper.last_error ? { status: "degraded", detail: keeper.last_error } : { status: "operational", detail: null };
      }),
      halt_feed: await run(async () => {
        if (!this.deps.haltFeedEnabled) return { status: "degraded", detail: "Halt mirroring is disabled" };
        const feed = await this.database.query<{ last_success_at: Date | null; last_error: string | null }>("SELECT last_success_at, last_error FROM public.exchange_halt_feed WHERE id");
        const age = ageSeconds(feed.rows[0]?.last_success_at, now);
        if (age === null || age > Math.max(600, this.deps.haltPollSeconds * 5)) {
          return { status: "degraded", detail: `Halt feed not read for ${age === null ? "any time" : minutes(age)}; known halts stay in force` };
        }
        return { status: "operational", detail: null };
      }),
      corporate_actions: await run(async () => {
        if (!this.deps.corporateActions.enabled) return { status: "degraded", detail: "Corporate action calendars are disabled" };
        const feed = await this.database.query<{ last_success_at: Date | null }>("SELECT last_success_at FROM public.corporate_action_feed WHERE id");
        const age = ageSeconds(feed.rows[0]?.last_success_at, now);
        if (age === null || age > Math.max(10_800, this.deps.corporateActionPollSeconds * 3)) {
          return { status: "degraded", detail: `Calendars not read for ${age === null ? "any time" : minutes(age)}` };
        }
        return { status: "operational", detail: null };
      })
    };
    return results;
  }

  /** Runs every check, records it, and opens or resolves incidents. */
  async refresh(now: Date = new Date()): Promise<void> {
    const results = await this.check(now);
    if (results.api.status !== "operational") return;
    for (const [component, result] of Object.entries(results) as [ComponentId, CheckResult][]) {
      await this.database.query(
        "INSERT INTO public.status_checks (component, checked_at, status, detail) VALUES ($1,$2,$3,$4)",
        [component, now, result.status, result.detail]
      );
      const open = await this.database.query<{ id: string }>(
        "SELECT id::text FROM public.status_incidents WHERE component=$1 AND resolved_at IS NULL", [component]
      );
      if (result.status === "operational") {
        if (open.rows[0]) await this.database.query("UPDATE public.status_incidents SET resolved_at=$2 WHERE id=$1", [open.rows[0].id, now]);
        continue;
      }
      if (open.rows[0]) {
        // Escalate a degraded incident that became an outage; keep the latest detail.
        await this.database.query(
          `UPDATE public.status_incidents SET detail=$2,
             severity=CASE WHEN $3='outage' THEN 'outage' ELSE severity END WHERE id=$1`,
          [open.rows[0].id, result.detail, result.status]
        );
        continue;
      }
      const recent = await this.database.query<{ status: ComponentStatus }>(
        "SELECT status FROM public.status_checks WHERE component=$1 ORDER BY checked_at DESC LIMIT $2", [component, FAILURES_TO_OPEN]
      );
      if (recent.rows.length === FAILURES_TO_OPEN && recent.rows.every((row) => row.status !== "operational")) {
        const started = await this.database.query<{ checked_at: Date }>(
          "SELECT checked_at FROM public.status_checks WHERE component=$1 ORDER BY checked_at DESC OFFSET $2 LIMIT 1", [component, FAILURES_TO_OPEN - 1]
        );
        await this.database.query(
          `INSERT INTO public.status_incidents (component, severity, title, detail, started_at)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [component, result.status, `${COMPONENTS[component]} ${result.status === "outage" ? "outage" : "degraded"}`, result.detail, started.rows[0]?.checked_at ?? now]
        );
      }
    }
    await this.database.query(`DELETE FROM public.status_checks WHERE checked_at < $1::timestamptz - interval '${HISTORY_DAYS} days'`, [now]);
  }

  /** The public status document. */
  async report(now: Date = new Date()) {
    const [latest, uptime, daily, incidents, halts, actions] = await Promise.all([
      this.database.query<{ component: ComponentId; status: ComponentStatus; detail: string | null; checked_at: Date }>(
        `SELECT DISTINCT ON (component) component, status, detail, checked_at FROM public.status_checks
         ORDER BY component, checked_at DESC`
      ),
      this.database.query<{ component: ComponentId; ratio: string }>(
        `SELECT component, (avg(CASE WHEN status='operational' THEN 1 ELSE 0 END))::text AS ratio
         FROM public.status_checks WHERE checked_at >= $1::timestamptz - interval '${HISTORY_DAYS} days' GROUP BY component`, [now]
      ),
      this.database.query<{ component: ComponentId; day: string; worst: ComponentStatus }>(
        `SELECT component, to_char(date_trunc('day', checked_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                CASE WHEN bool_or(status='outage') THEN 'outage' WHEN bool_or(status='degraded') THEN 'degraded' ELSE 'operational' END AS worst
         FROM public.status_checks WHERE checked_at >= $1::timestamptz - interval '${HISTORY_DAYS} days'
         GROUP BY component, day ORDER BY day`, [now]
      ),
      this.database.query<{ id: string; component: ComponentId; severity: string; title: string; detail: string | null; started_at: Date; resolved_at: Date | null; postmortem: string | null }>(
        `SELECT id::text, component, severity, title, detail, started_at, resolved_at, postmortem FROM public.status_incidents
         ORDER BY (resolved_at IS NULL) DESC, started_at DESC LIMIT 25`
      ),
      readActiveHalts(this.database),
      readCorporateActions(this.database, this.deps.corporateActions, now)
    ]);
    const components = (Object.keys(COMPONENTS) as ComponentId[]).map((id) => {
      const row = latest.rows.find((item) => item.component === id);
      return {
        id, name: COMPONENTS[id],
        status: row?.status ?? "operational",
        detail: row?.detail ?? null,
        checked_at: row?.checked_at.toISOString() ?? null,
        uptime_90d: (() => { const ratio = uptime.rows.find((item) => item.component === id)?.ratio; return ratio === undefined ? null : Math.round(Number(ratio) * 100_000) / 1_000; })(),
        days: daily.rows.filter((item) => item.component === id).map((item) => ({ day: item.day, status: item.worst }))
      };
    });
    const overall: ComponentStatus = components.some((item) => item.status === "outage") ? "outage"
      : components.some((item) => item.status === "degraded") ? "degraded" : "operational";
    const waiting = await this.database.query<{ symbol: string }>(
      `SELECT m.symbol FROM public.markets m LEFT JOIN LATERAL (
         SELECT observed_at FROM public.pool_snapshots WHERE market_id=m.id ORDER BY observed_at DESC LIMIT 1
       ) s ON true
       WHERE m.listed = TRUE AND m.status <> 'disabled' AND m.price_source = 'reference'
         AND (s.observed_at IS NULL OR s.observed_at < $1::timestamptz - make_interval(secs => $2::double precision))
       ORDER BY m.symbol`, [now, this.sampleAgeLimitSeconds()]
    );
    const closure = this.deps.copperClosure ? await this.deps.copperClosure().catch(() => null) : null;
    const marketEvents = [
      ...[...halts.values()].map((halt) => ({ market: halt.symbol, kind: "exchange_halt", summary: `Halted on ${halt.listing_market} (${halt.reason}). Close-only until trading resumes.`, since: halt.halted_at })),
      ...[...actions.values()].map((action) => ({ market: action.symbol, kind: action.kind, summary: action.summary, since: action.close_only ? action.close_only_from : null })),
      ...(closure?.action && closure.summary ? [{ market: "Copper", kind: "closure_profile", summary: closure.summary, since: null }] : []),
      ...waiting.rows.map((row) => ({ market: row.symbol, kind: "awaiting_price", summary: "Waiting for a live price quote. New positions open once its quote updates; quiet after-hours quotes can take until the next session.", since: null }))
    ];
    return {
      overall,
      generated_at: now.toISOString(),
      components,
      market_events: marketEvents,
      incidents: incidents.rows.map((row) => ({
        id: row.id, component: row.component, component_name: COMPONENTS[row.component] ?? row.component,
        severity: row.severity, title: row.title, detail: row.detail,
        started_at: row.started_at.toISOString(), resolved_at: row.resolved_at?.toISOString() ?? null,
        duration_minutes: Math.round(((row.resolved_at ?? now).getTime() - row.started_at.getTime()) / 60_000),
        postmortem: row.postmortem
      }))
    };
  }
}
