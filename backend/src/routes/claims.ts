import { Router } from "express";
import { z } from "zod";
import type { Address } from "viem";

import type { ClaimCenter } from "../claims/claims";
import { safeErrorMessage } from "../safe-error";

const CACHE_MS = 20_000;

export function createClaimsRouter(center: Pick<ClaimCenter, "forAccount">): Router {
  const router = Router();
  // Each report reads several contracts per deployment; reuse it briefly.
  const cache = new Map<string, { at: number; value: unknown }>();
  router.get("/:account", async (request, response) => {
    const parsed = z.string().regex(/^0x[0-9a-fA-F]{40}$/).safeParse(request.params.account);
    if (!parsed.success) return response.status(400).json({ error: "A valid wallet address is required" });
    const account = parsed.data.toLowerCase() as Address;
    const fresh = request.query.fresh === "1";
    const hit = cache.get(account);
    if (hit && !fresh && Date.now() - hit.at < CACHE_MS) return response.json(hit.value);
    try {
      const value = await center.forAccount(account);
      cache.set(account, { at: Date.now(), value });
      if (cache.size > 5_000) for (const [key, entry] of cache) if (Date.now() - entry.at >= CACHE_MS) cache.delete(key);
      response.json(value);
    } catch (error) {
      console.error(JSON.stringify({ event: "claim_center_failed", error: safeErrorMessage(error) }));
      response.status(503).json({ error: "Claim center is temporarily unavailable" });
    }
  });
  return router;
}
