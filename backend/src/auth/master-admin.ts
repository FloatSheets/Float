import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

import type { AppConfig } from "../config";

function suppliedKey(request: Parameters<RequestHandler>[0]): string | undefined {
  const header = request.header("x-master-admin-key");
  if (header) return header;
  const authorization = request.header("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
}

export function requireMasterAdmin(config: AppConfig): RequestHandler {
  return (request, response, next) => {
    const provided = suppliedKey(request);
    const expected = Buffer.from(config.MASTER_ADMIN_KEY);
    const actual = Buffer.from(provided ?? "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      response.status(401).json({ error: "master admin authentication required" });
      return;
    }
    next();
  };
}
