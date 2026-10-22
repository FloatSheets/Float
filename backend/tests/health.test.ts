import { beforeEach, expect, test } from "bun:test";
import request from "supertest";

import { app, resetRateLimitsForTest } from "../src/app";

// The rate limiter is process-wide; other suites can exhaust the shared bucket.
beforeEach(() => resetRateLimitsForTest());

test("GET /health returns service metadata", async () => {
  const response = await request(app).get("/health").set("x-request-id", "test-request-id");

  expect(response.status).toBe(200);
  expect(response.body.status).toBe("ok");
  expect(new Date(response.body.timestamp).toISOString()).toBe(response.body.timestamp);
  expect(response.body.version).toBeString();
  expect(response.headers["x-request-id"]).toBe("test-request-id");
});
