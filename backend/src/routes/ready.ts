import { Router } from "express";
import type { Pool } from "pg";

export function createReadinessRouter(database: Pool): Router {
  const router = Router();
  router.get("/", async (_request, response) => {
    try {
      await database.query("SELECT 1");
      response.status(200).json({ status: "ready", timestamp: new Date().toISOString() });
    } catch {
      response.status(503).json({ status: "unavailable" });
    }
  });
  return router;
}
