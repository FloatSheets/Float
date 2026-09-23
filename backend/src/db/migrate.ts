import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { db } from "./index";

const migrationsDirectory = join(import.meta.dir, "../../db/migrations");
const schemaName = /^[a-z_][a-z0-9_]*$/;

export type MigrationOptions = { schema?: string };

function quotedSchema(schema: string): string {
  if (!schemaName.test(schema)) throw new Error("Migration schema must be a lowercase SQL identifier");
  return `"${schema}"`;
}

export async function migrate({ schema = "public" }: MigrationOptions = {}): Promise<void> {
  const quoted = quotedSchema(schema);
  const client = await db.connect();
  try {
    await client.query(`SET search_path TO ${quoted}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationsDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const filename of files) {
      const applied = await client.query<{ filename: string }>(
        "SELECT filename FROM schema_migrations WHERE filename = $1",
        [filename]
      );
      if (applied.rowCount) continue;

      const sql = await Bun.file(join(migrationsDirectory, filename)).text();
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("RESET search_path");
    client.release();
  }
}
