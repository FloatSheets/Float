import express from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { healthRouter } from "./routes/health";

export const app = express();

type RateWindow = { count: number; resetAt: number };
const rateWindows = new Map<string, RateWindow>();
const RATE_WINDOW_MS = 60_000;
const GENERAL_RATE_LIMIT = 120;
const OPEN_QUOTE_RATE_LIMIT = 30;
const CLOSE_QUOTE_RATE_LIMIT = 180;
const OTHER_TRANSACTION_RATE_LIMIT = 60;
const serverApiSecret = process.env["SERVER_API_SHARED_SECRET"];

export function resetRateLimitsForTest(): void {
  rateWindows.clear();
}

app.disable("x-powered-by");
// Trust the browser IP forwarded by the frontend server only when it proves
// possession of the server-to-server secret. Ignore client supplied XFF.
app.set("trust proxy", false);
app.use(express.json({ limit: "1mb" }));

app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");

  const now = Date.now();
  const transactionRoute = request.path.startsWith("/v1/protocol/transactions");
  const suppliedSecret = request.header("x-floatsheets-server-secret");
  const trustedSecret = Boolean(serverApiSecret && suppliedSecret
    && Buffer.byteLength(serverApiSecret) === Buffer.byteLength(suppliedSecret)
    && timingSafeEqual(Buffer.from(serverApiSecret), Buffer.from(suppliedSecret)));
  if (transactionRoute && process.env["NODE_ENV"] === "production" && !trustedSecret) {
    response.status(503).json({ error: "Trusted frontend server request required" });
    return;
  }
  const suppliedIp = request.header("x-floatsheets-client-ip")?.trim();
  const clientIp = trustedSecret && suppliedIp && isIP(suppliedIp) ? suppliedIp : request.socket.remoteAddress ?? "unknown";
  const path = request.path;
  const closeQuote = path === "/v1/protocol/transactions/close-quote";
  const openQuote = path === "/v1/protocol/transactions/trade-quote" || path === "/v1/protocol/transactions/trade-check" || path === "/v1/protocol/transactions/quote";
  const trader = typeof request.body?.trader === "string" && /^0x[0-9a-fA-F]{40}$/.test(request.body.trader)
    ? request.body.trader.toLowerCase()
    : "anonymous";
  const limit = transactionRoute
    ? closeQuote ? CLOSE_QUOTE_RATE_LIMIT : openQuote ? OPEN_QUOTE_RATE_LIMIT : OTHER_TRANSACTION_RATE_LIMIT
    : GENERAL_RATE_LIMIT;
  const bucket = transactionRoute ? closeQuote ? "close" : openQuote ? "open" : path : "api";
  const key = transactionRoute ? `${clientIp}:${trader}:${bucket}` : `${clientIp}:api`;
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
