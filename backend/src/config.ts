import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";

const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be an EVM address");
export const contractVersionSchema = z.enum(["jasper", "meadow", "legacy-orion"]);
export type ContractVersion = z.infer<typeof contractVersionSchema>;

const schema = z.object({
  ADMIN_EOA_ADDRESS: address,
  FLOAT_CLEARING_HOUSE_ADDRESS: address,
  FLOAT_ORACLE_ADDRESS: address,
  FLOAT_VAULT_ADDRESS: address,
  MEADOW_FLOAT_CLEARING_HOUSE_ADDRESS: address.default("0xc1AfA648C30090Aa8fDd3fbca384bd65b52B58Dd"),
  MEADOW_FLOAT_ORACLE_ADDRESS: address.default("0x7Fda40E8FD27cA067C9Ee23EA0Fd0cb8Bb786A8a"),
  MEADOW_FLOAT_VAULT_ADDRESS: address.default("0xb74eD266A95d8393cDaF2Fa6cADd98b5a1D91875"),
  JASPER_FLOAT_CLEARING_HOUSE_ADDRESS: address.optional(),
  JASPER_FLOAT_ORACLE_ADDRESS: address.optional(),
  JASPER_FLOAT_VAULT_ADDRESS: address.optional(),
  LEGACY_ORION_FLOAT_CLEARING_HOUSE_ADDRESS: address.optional(),
  LEGACY_ORION_FLOAT_ORACLE_ADDRESS: address.optional(),
  LEGACY_ORION_FLOAT_VAULT_ADDRESS: address.optional(),
  MASTER_ADMIN_KEY: z.string().min(32),
  USDG_ADDRESS: address,
  FRONTEND_URL: z.url(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]),
  MARKET_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000),
  NODE_ENV: z.enum(["development", "test", "production"]),
  ORACLE_PRICE_MAX_AGE_SECONDS: z.coerce.number().int().min(15),
  ORACLE_PUBLISHER_ADDRESS: address,
  ORACLE_PUBLISHER_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "must be a 32-byte private key"),
  ORACLE_PUBLISH_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(3_600).default(90),
  ORACLE_SIGNER_ADDRESS: address,
  ORACLE_SIGNER_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "must be a 32-byte private key"),
  // The deployed clearing house accepts oracle prices for 120 seconds. Keep
  // enough headroom for block propagation instead of letting a quote survive
  // until the oracle expires.
  QUOTE_TTL_SECONDS: z.coerce.number().int().min(1).max(105),
  QUOTE_SIGNER_ADDRESS: address,
  QUOTE_SIGNER_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "must be a 32-byte private key"),
  RHC_ID: z.coerce.number().int().refine((value) => value === 4663, "must be Robinhood Chain (4663)"),
  RHC_RPC_URL: z.url(),
  UNISWAP_TWAP_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400)
});

export type AppConfig = z.infer<typeof schema>;

export function contractConfigForVersion(config: AppConfig, version: ContractVersion): AppConfig {
  if (version === "jasper") {
    const clearingHouse = config.JASPER_FLOAT_CLEARING_HOUSE_ADDRESS ?? (config.NODE_ENV === "test" ? config.MEADOW_FLOAT_CLEARING_HOUSE_ADDRESS : undefined);
    const oracle = config.JASPER_FLOAT_ORACLE_ADDRESS ?? (config.NODE_ENV === "test" ? config.MEADOW_FLOAT_ORACLE_ADDRESS : undefined);
    const vault = config.JASPER_FLOAT_VAULT_ADDRESS ?? (config.NODE_ENV === "test" ? config.MEADOW_FLOAT_VAULT_ADDRESS : undefined);
    if (!clearingHouse || !oracle || !vault) {
      throw new Error("Jasper contract addresses are not configured");
    }
    return {
      ...config,
      FLOAT_CLEARING_HOUSE_ADDRESS: clearingHouse,
      FLOAT_ORACLE_ADDRESS: oracle,
      FLOAT_VAULT_ADDRESS: vault
    };
  }
  if (version === "meadow") {
    return {
      ...config,
      FLOAT_CLEARING_HOUSE_ADDRESS: config.MEADOW_FLOAT_CLEARING_HOUSE_ADDRESS,
      FLOAT_ORACLE_ADDRESS: config.MEADOW_FLOAT_ORACLE_ADDRESS,
      FLOAT_VAULT_ADDRESS: config.MEADOW_FLOAT_VAULT_ADDRESS
    };
  }
  return {
    ...config,
    FLOAT_CLEARING_HOUSE_ADDRESS: config.LEGACY_ORION_FLOAT_CLEARING_HOUSE_ADDRESS ?? config.FLOAT_CLEARING_HOUSE_ADDRESS,
    FLOAT_ORACLE_ADDRESS: config.LEGACY_ORION_FLOAT_ORACLE_ADDRESS ?? config.FLOAT_ORACLE_ADDRESS,
    FLOAT_VAULT_ADDRESS: config.LEGACY_ORION_FLOAT_VAULT_ADDRESS ?? config.FLOAT_VAULT_ADDRESS
  };
}

export function loadConfig(environment: Record<string, string | undefined> = process.env): AppConfig {
  const config = schema.parse(environment);
  const derivedSignerAddress = privateKeyToAccount(config.ORACLE_SIGNER_PRIVATE_KEY as `0x${string}`).address;
  if (derivedSignerAddress.toLowerCase() !== config.ORACLE_SIGNER_ADDRESS.toLowerCase()) {
    throw new Error("ORACLE_SIGNER_ADDRESS does not match ORACLE_SIGNER_PRIVATE_KEY");
  }
  const derivedPublisherAddress = privateKeyToAccount(config.ORACLE_PUBLISHER_PRIVATE_KEY as `0x${string}`).address;
  if (derivedPublisherAddress.toLowerCase() !== config.ORACLE_PUBLISHER_ADDRESS.toLowerCase()) {
    throw new Error("ORACLE_PUBLISHER_ADDRESS does not match ORACLE_PUBLISHER_PRIVATE_KEY");
  }
  const derivedQuoteSignerAddress = privateKeyToAccount(config.QUOTE_SIGNER_PRIVATE_KEY as `0x${string}`).address;
  if (derivedQuoteSignerAddress.toLowerCase() !== config.QUOTE_SIGNER_ADDRESS.toLowerCase()) {
    throw new Error("QUOTE_SIGNER_ADDRESS does not match QUOTE_SIGNER_PRIVATE_KEY");
  }
  return config;
}
