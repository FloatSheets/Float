import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL must be configured");
}

export const db = new Pool({ connectionString, connectionTimeoutMillis: 45_000, options: "-c search_path=public" });
