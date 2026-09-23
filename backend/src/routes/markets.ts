import { Router } from "express";
import type { Pool } from "pg";

export function createMarketsRouter(database: Pool): Router {
  const router = Router();

  router.get("/", async (_request, response, next) => {
    try {
      const result = await database.query(
        `SELECT m.symbol, m.status, m.max_leverage, m.max_ticket_usdg,
                m.min_half_spread_bps, m.max_half_spread_bps,
                s.observed_at, s.liquidity, s.usdg_balance
         FROM markets m
         LEFT JOIN LATERAL (
           SELECT observed_at, liquidity, usdg_balance FROM pool_snapshots
           WHERE market_id = m.id ORDER BY observed_at DESC LIMIT 1
         ) s ON true
         ORDER BY m.symbol`
      );
      response.json({ markets: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:symbol/quotes", async (request, response, next) => {
    try {
      const result = await database.query(
        `SELECT q.observed_at, q.notional_usdg, q.direction, q.execution_degradation_bps, q.quoted_output
         FROM quote_samples q JOIN markets m ON m.id = q.market_id
         WHERE m.symbol = $1 AND q.observed_at = (
           SELECT max(q2.observed_at) FROM quote_samples q2 WHERE q2.market_id = m.id
         ) ORDER BY q.notional_usdg, q.direction`,
        [request.params.symbol.toUpperCase()]
      );
      if (!result.rowCount) return response.status(404).json({ error: "market quotes not found" });
      response.json({ market: request.params.symbol.toUpperCase(), quotes: result.rows });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
