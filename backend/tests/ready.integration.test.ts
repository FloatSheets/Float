import "dotenv/config";

import express from "express";
import { expect, test } from "bun:test";
import request from "supertest";

import { db } from "../src/db";
import { createReadinessRouter } from "../src/routes/ready";

const app = express();
app.use("/ready", createReadinessRouter(db));

test("reports ready only when deployed PostgreSQL is reachable", async () => {
  const response = await request(app).get("/ready");
  expect(response.status).toBe(200);
  expect(response.body.status).toBe("ready");
  expect(new Date(response.body.timestamp).toISOString()).toBe(response.body.timestamp);
});
