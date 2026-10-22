import { Router } from "express";
import { z } from "zod";

import { requireMasterAdmin } from "../auth/master-admin";
import type { AppConfig } from "../config";
import { safeErrorMessage } from "../safe-error";
import type { StatusMonitor } from "../status/status";

export function createStatusRouter(monitor: Pick<StatusMonitor, "report">, config: AppConfig, database: { query: (sql: string, values?: unknown[]) => Promise<{ rowCount: number | null }> }): Router {
  const router = Router();
  router.get("/", async (_request, response) => {
    try {
      response.json(await monitor.report());
    } catch (error) {
      console.error(JSON.stringify({ event: "status_report_failed", error: safeErrorMessage(error) }));
      response.status(503).json({ overall: "outage", error: "Status is temporarily unavailable" });
    }
  });

  /** Attaches a public post-mortem to an incident. */
  router.post("/incidents/:id/postmortem", requireMasterAdmin(config), async (request, response) => {
    try {
      const id = z.string().regex(/^\d{1,18}$/).parse(request.params.id);
      const body = z.object({ postmortem: z.string().trim().min(1).max(4_000) }).parse(request.body);
      const result = await database.query("UPDATE public.status_incidents SET postmortem=$2 WHERE id=$1", [id, body.postmortem]);
      if (!result.rowCount) return response.status(404).json({ error: "incident not found" });
      response.json({ updated: true });
    } catch (error) {
      response.status(400).json({ error: safeErrorMessage(error).slice(0, 240) });
    }
  });
  return router;
}
