import express from "express";
import { randomUUID } from "node:crypto";

import { healthRouter } from "./routes/health";

export const app = express();

type RateWindow = { count: number; resetAt: number };
const rateWindows = new Map<string, RateWindow>();
const RATE_WINDOW_MS = 60_000;
const GENERAL_RATE_LIMIT = 120;
const TRANSACTION_RATE_LIMIT = 30;

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");

  const now = Date.now();
  const transactionRoute = request.path.startsWith("/v1/protocol/transactions");
  const limit = transactionRoute ? TRANSACTION_RATE_LIMIT : GENERAL_RATE_LIMIT;
  const key = `${request.ip ?? request.socket.remoteAddress ?? "unknown"}:${transactionRoute ? "transactions" : "api"}`;
  let window = rateWindows.get(key);
  if (!window || window.resetAt <= now) {
    window = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateWindows.set(key, window);
  }
  window.count += 1;
  response.setHeader("RateLimit-Limit", limit);
  response.setHeader("RateLimit-Remaining", Math.max(0, limit - window.count));
  response.setHeader("RateLimit-Reset", Math.ceil(window.resetAt / 1000));
  if (window.count > limit) {
    response.setHeader("Retry-After", Math.max(1, Math.ceil((window.resetAt - now) / 1000)));
    response.status(429).json({ error: "Too many requests" });
    return;
  }
  if (rateWindows.size > 10_000) {
    for (const [entryKey, entry] of rateWindows) if (entry.resetAt <= now) rateWindows.delete(entryKey);
  }
  next();
});

app.use((request, response, next) => {
  const requestId = request.header("x-request-id") ?? randomUUID();
  const startedAt = performance.now();
  response.setHeader("x-request-id", requestId);
  response.on("finish", () => {
    console.info(JSON.stringify({
      duration_ms: Math.round(performance.now() - startedAt),
      method: request.method,
      path: request.path,
      request_id: requestId,
      status: response.statusCode
    }));
  });
  next();
});

app.use((request, response, next) => {
  const allowedOrigin = process.env.FRONTEND_URL;
  if (allowedOrigin && request.headers.origin === allowedOrigin) {
    response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }
  next();
});

app.use("/health", healthRouter);
