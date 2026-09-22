import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { db } from "./index";

const migrationsDirectory = join(import.meta.dir, "../../db/migrations");

export async function migrate(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const filename of files) {
    const applied = await db.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations WHERE filename = $1",
      [filename]
    );
    if (applied.rowCount) continue;

    const sql = await Bun.file(join(migrationsDirectory, filename)).text();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
