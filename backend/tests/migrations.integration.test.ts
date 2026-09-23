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

  expect(markets.rows[0]?.count).toBe("10");
  expect(statuses.rows).toEqual([
    { count: "8", status: "active" },
    { count: "1", status: "pilot" },
    { count: "1", status: "restricted" }
  ]);
}, 60_000);

test("is idempotent within its isolated schema", async () => {
  await migrate({ schema });
  const migrations = await db.query<{ count: string }>(`SELECT count(*) FROM "${schema}".schema_migrations`);
  expect(migrations.rows[0]?.count).toBe("1");
}, 60_000);
