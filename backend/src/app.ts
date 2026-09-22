import express from "express";

import { healthRouter } from "./routes/health";

export const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

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
