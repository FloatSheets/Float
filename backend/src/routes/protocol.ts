import { Router } from "express";

import type { AppConfig } from "../config";
import { contractConfigForVersion } from "../config";
import { contractVersionFromRequest } from "../contract-version";

export function createProtocolRouter(config: AppConfig): Router {
  const router = Router();

  router.get("/", (request, response) => {
    const version = contractVersionFromRequest(request);
    const versionConfig = contractConfigForVersion(config, version);
    response.json({
      contract_version: version,
      contract_name: version === "meadow" ? "FloatSheets Meadow" : "FloatSheets Legacy Orion",
      chain_id: config.RHC_ID,
      settlement_asset: "USDG",
      settlement_asset_address: config.USDG_ADDRESS,
      oracle: versionConfig.FLOAT_ORACLE_ADDRESS,
      vault: versionConfig.FLOAT_VAULT_ADDRESS,
      clearing_house: versionConfig.FLOAT_CLEARING_HOUSE_ADDRESS,
      oracle_signer: config.ORACLE_SIGNER_ADDRESS,
      quote_signer: config.QUOTE_SIGNER_ADDRESS,
      max_position_duration_seconds: version === "meadow" ? 604800 : null,
      lp_actions_locked_while_positions_open: version === "meadow"
    });
  });

  return router;
}
