import { expect, test } from "bun:test";
import request from "supertest";

import { app } from "../src/app";

test("sets API security headers and rate limits burst traffic", async () => {
  // Keep this burst isolated from requests made by other tests in this process.
  const client = () => request(app).get("/health").set("X-Forwarded-For", "198.51.100.42");
  const first = await client();
  expect(first.status).toBe(200);
  expect(first.headers["x-content-type-options"]).toBe("nosniff");
  expect(first.headers["x-frame-options"]).toBe("DENY");
  expect(first.headers["referrer-policy"]).toBe("no-referrer");
  expect(first.headers["content-security-policy"]).toContain("default-src 'none'");
  expect(first.headers["ratelimit-limit"]).toBe("120");

  let last = first;
  for (let index = 1; index < 120; index += 1) last = await client();
  expect(last.status).toBe(200);
  const limited = await client();
  expect(limited.status).toBe(429);
  expect(limited.headers["retry-after"]).toBeDefined();
});
