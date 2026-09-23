import { Router } from "express";

import type { AppConfig } from "../config";

export function createProtocolRouter(config: AppConfig): Router {
  const router = Router();

  router.get("/", (_request, response) => {
    response.json({
      chain_id: config.RHC_ID,
      settlement_asset: "USDG",
      settlement_asset_address: config.USDG_ADDRESS,
      oracle: config.FLOAT_ORACLE_ADDRESS,
      vault: config.FLOAT_VAULT_ADDRESS,
      clearing_house: config.FLOAT_CLEARING_HOUSE_ADDRESS,
      oracle_signer: config.ORACLE_SIGNER_ADDRESS,
      quote_signer: config.QUOTE_SIGNER_ADDRESS
    });
  });

  return router;
}
