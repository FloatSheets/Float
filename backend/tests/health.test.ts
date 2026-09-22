import { expect, test } from "bun:test";
import request from "supertest";

import { app } from "../src/app";

test("GET /health returns service metadata", async () => {
  const response = await request(app).get("/health");

  expect(response.status).toBe(200);
  expect(response.body.status).toBe("ok");
  expect(new Date(response.body.timestamp).toISOString()).toBe(response.body.timestamp);
  expect(response.body.version).toBeString();
});
