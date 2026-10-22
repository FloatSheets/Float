import { Router } from "express";

import { safeErrorMessage } from "../safe-error";
import type { SolvencyReader } from "../solvency/solvency";

export function createSolvencyRouter(reader: Pick<SolvencyReader, "report">): Router {
  const router = Router();
  router.get("/", async (_request, response) => {
    try {
      response.json(await reader.report());
    } catch (error) {
      console.error(JSON.stringify({ event: "solvency_report_failed", error: safeErrorMessage(error) }));
      response.status(503).json({ error: "Solvency data is temporarily unavailable" });
    }
  });
  return router;
}
