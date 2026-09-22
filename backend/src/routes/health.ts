import { Router } from "express";

export const healthRouter = Router();

healthRouter.get("/", (_request, response) => {
  response.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version ?? "0.1.0"
  });
});
