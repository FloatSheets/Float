import "dotenv/config";

import { afterAll, beforeAll, expect, test } from "bun:test";

import { db } from "../src/db";
import { migrate } from "../src/db/migrate";

const schema = `floatsheets_test_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

beforeAll(
  async () => {
    await db.query(`CREATE SCHEMA "${schema}"`);
  },
  60_000
);

afterAll(
  async () => {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  },
  60_000
);

test("applies the market schema to an isolated deployed-Postgres schema", async () => {
  await migrate({ schema });

  const markets = await db.query<{ count: string }>(`SELECT count(*) FROM "${schema}".markets`);
  const statuses = await db.query<{ status: string; count: string }>(
    `SELECT status::text, count(*) FROM "${schema}".markets GROUP BY status ORDER BY status`
  );
  const hims = await db.query<{ max_ticket_usdg: string }>(
    `SELECT max_ticket_usdg::text FROM "${schema}".markets WHERE symbol='HIMS'`
  );
  const listings = await db.query<{ symbol: string; listed: boolean }>(
    `SELECT symbol, listed FROM "${schema}".markets WHERE symbol IN ('AMC','HIMS') ORDER BY symbol`
  );

  // 11 large-cap rows (HIMS retired) + 9 new Copper penny rows (QUBT is shared).
  expect(markets.rows[0]?.count).toBe("20");
  expect(statuses.rows).toEqual([
    { count: "19", status: "active" },
    { count: "1", status: "disabled" }
  ]);
  expect(hims.rows[0]?.max_ticket_usdg).toBe("15000.000000");
  expect(listings.rows).toEqual([
    { symbol: "AMC", listed: true },
    { symbol: "HIMS", listed: false }
  ]);
  const copper = await db.query<{ symbol: string; price_source: string; releases: string[]; min_sources_for_open: number }>(
    `SELECT symbol, price_source, releases, min_sources_for_open FROM "${schema}".markets
     WHERE 'copper' = ANY(releases) ORDER BY market_cap_usd`
  );
  expect(copper.rows.map((row) => row.symbol)).toEqual(["WYFI", "NNE", "RCAT", "TE", "XNDU", "POET", "FLNC", "QUBT", "RUN", "DJT"]);
  expect(copper.rows.every((row) => row.price_source === "reference")).toBe(true);
  expect(copper.rows.find((row) => row.symbol === "QUBT")?.releases).toEqual(["goldlake", "copper"]);
  // Copper opens on Robinhood's own quote alone (migration 019).
  expect(copper.rows.every((row) => row.min_sources_for_open === 1)).toBe(true);
  const goldlake = await db.query<{ count: string }>(`SELECT count(*) FROM "${schema}".markets WHERE 'goldlake' = ANY(releases)`);
  expect(goldlake.rows[0]?.count).toBe("11");
}, 60_000);

test("is idempotent within its isolated schema", async () => {
  await migrate({ schema });
  const migrations = await db.query<{ count: string }>(`SELECT count(*) FROM "${schema}".schema_migrations`);
  const alertTables = await db.query<{ count: string }>(
    `SELECT count(*) FROM information_schema.tables
     WHERE table_schema=$1 AND table_name IN (
       'liquidation_email_preferences','liquidation_email_challenges',
       'liquidation_alert_cursors','liquidation_alert_events',
       'liquidation_telegram_wallet_challenges','liquidation_telegram_link_codes',
       'liquidation_telegram_links','telegram_bot_state','liquidation_alert_deliveries'
     )`, [schema]
  );
  expect(migrations.rows[0]?.count).toBe("20");
  expect(alertTables.rows[0]?.count).toBe("9");
}, 60_000);
