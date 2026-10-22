import { Router } from "express";

import type { PositionKeeper } from "../keeper/keeper";
import { safeErrorMessage } from "../safe-error";

export function createKeeperRouter(keeper: Pick<PositionKeeper, "status">): Router {
  const router = Router();
  router.get("/", async (_request, response) => {
    try {
      response.json(await keeper.status());
    } catch (error) {
      console.error(JSON.stringify({ event: "keeper_status_failed", error: safeErrorMessage(error) }));
      response.status(503).json({ error: "Keeper status is temporarily unavailable" });
    }
  });
  return router;
}
