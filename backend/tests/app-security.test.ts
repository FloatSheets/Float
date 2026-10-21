import { expect, test } from "bun:test";
import request from "supertest";

import { app } from "../src/app";

test("sets API security headers and rate limits burst traffic", async () => {
  const first = await request(app).get("/health");
  expect(first.status).toBe(200);
  expect(first.headers["x-content-type-options"]).toBe("nosniff");
  expect(first.headers["x-frame-options"]).toBe("DENY");
  expect(first.headers["referrer-policy"]).toBe("no-referrer");
  expect(first.headers["content-security-policy"]).toContain("default-src 'none'");
  expect(first.headers["ratelimit-limit"]).toBe("120");

  let last = first;
  for (let index = 1; index < 120; index += 1) last = await request(app).get("/health");
  expect(last.status).toBe(200);
  const limited = await request(app).get("/health");
  expect(limited.status).toBe(429);
  expect(limited.headers["retry-after"]).toBeDefined();
});
