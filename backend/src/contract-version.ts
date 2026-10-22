import type { Request } from "express";
import { contractVersionSchema, type ContractVersion } from "./config";

export function contractVersionFromRequest(request: Request): ContractVersion {
  const header = request.get("x-floatsheets-contract-version");
  const query = typeof request.query.contract_version === "string" ? request.query.contract_version : undefined;
  const parsed = contractVersionSchema.safeParse(header ?? query ?? "silverlake");
  return parsed.success ? parsed.data : "silverlake";
}
