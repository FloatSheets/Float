import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";

const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be an EVM address");
export const contractVersionSchema = z.enum(["goldlake", "silverlake", "amber", "jasper", "meadow", "legacy-orion"]);
export type ContractVersion = z.infer<typeof contractVersionSchema>;

const schema = z.object({
  ADMIN_EOA_ADDRESS: address,
  FLOAT_CLEARING_HOUSE_ADDRESS: address,
  FLOAT_ORACLE_ADDRESS: address,
  FLOAT_VAULT_ADDRESS: address,
  AMBER_FLOAT_CLEARING_HOUSE_ADDRESS: address.optional(),
  AMBER_FLOAT_ORACLE_ADDRESS: address.optional(),
  AMBER_FLOAT_VAULT_ADDRESS: address.optional(),
  SILVERLAKE_FLOAT_CLEARING_HOUSE_ADDRESS: address.default("0xC197d8F546CC56A4148b30A74d3A2c5975255C6A"),
  SILVERLAKE_FLOAT_ORACLE_ADDRESS: address.default("0xf935b2439E4B74F9Bd100148e4eFe3dE94DEF315"),
  SILVERLAKE_FLOAT_VAULT_ADDRESS: address.default("0x9DA17d606453552bc7CD54f4d44813C8Acff55c4"),
  GOLDLAKE_FLOAT_CLEARING_HOUSE_ADDRESS: address.default("0xA1329C69e8EDA292cdA849BaBB990fbD05198cDb"),
  GOLDLAKE_FLOAT_ORACLE_ADDRESS: address.default("0xe47c7ab6e236e44CB888Ab08CE96f5839887C5Ec"),
  GOLDLAKE_FLOAT_VAULT_ADDRESS: address.default("0x24B530f2ef4c76D10003e861182208ceA4120C45"),
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
  HALT_FEED_ENABLED: z.enum(["true", "false"]).default("true"),
  HALT_FEED_URL: z.url().default("https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts"),
  HALT_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(15).max(3_600).default(60),
  WEEKEND_BANDS_ENABLED: z.enum(["true", "false"]).default("true"),
  // Band half-width cap. The effective width is min(1 / max leverage, this).
  WEEKEND_BAND_MAX_BPS: z.coerce.number().int().min(50).max(5_000).default(500),
  WEEKEND_BAND_SHIFT_AFTER_SECONDS: z.coerce.number().int().min(300).max(86_400).default(3_600),
  WEEKEND_BAND_MAX_SHIFTS: z.coerce.number().int().min(0).max(10).default(2),
  WEEKEND_WALLET_LIMITS_ENABLED: z.enum(["true", "false"]).default("true"),
  // Per-wallet, per-market weekend allowance as a share of the market's max ticket.
  WEEKEND_WALLET_CAP_BPS: z.coerce.number().int().min(100).max(10_000).default(2_500),
  WEEKEND_WALLET_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
  OPENING_BELL_ENABLED: z.enum(["true", "false"]).default("true"),
  OPENING_BELL_MINUTES: z.coerce.number().int().min(0).max(60).default(10),
  OPENING_BELL_EXTRA_SPREAD_BPS: z.coerce.number().int().min(0).max(200).default(15),
  // Bell-time max ticket as a share of the market's normal max ticket.
  OPENING_BELL_TICKET_BPS: z.coerce.number().int().min(100).max(10_000).default(5_000),
  KEEPER_ENABLED: z.enum(["true", "false"]).default("true"),
  KEEPER_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3_600).default(30),
  // Optional dedicated keeper wallet. Defaults to the oracle publisher wallet;
  // both run sequentially in one loop so they never race for a nonce.
  KEEPER_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "must be a 32-byte private key").optional(),
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
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM_EMAIL: z.string().email().default("alerts@updates.floatsheets.app"),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_BOT_USERNAME: z.string().transform((value) => value.replace(/^@/, "")).pipe(z.string().regex(/^[A-Za-z0-9_]{5,32}$/)).optional(),
  SERVER_API_SHARED_SECRET: z.string().min(32).optional(),
  UNISWAP_TWAP_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400)
});

export type AppConfig = z.infer<typeof schema>;

export function isSilverlakeConfigured(config: AppConfig): boolean {
  return config.NODE_ENV === "test" || Boolean(
    config.SILVERLAKE_FLOAT_CLEARING_HOUSE_ADDRESS
    && config.SILVERLAKE_FLOAT_ORACLE_ADDRESS
    && config.SILVERLAKE_FLOAT_VAULT_ADDRESS
  );
}

export function isGoldlakeConfigured(config: AppConfig): boolean {
  return config.NODE_ENV === "test" || Boolean(
    config.GOLDLAKE_FLOAT_CLEARING_HOUSE_ADDRESS
    && config.GOLDLAKE_FLOAT_ORACLE_ADDRESS
    && config.GOLDLAKE_FLOAT_VAULT_ADDRESS
  );
}

export function contractConfigForVersion(config: AppConfig, version: ContractVersion): AppConfig {
  if (version === "goldlake") {
    if (!isGoldlakeConfigured(config)) throw new Error("Goldlake contract addresses are not configured");
    const clearingHouse = config.GOLDLAKE_FLOAT_CLEARING_HOUSE_ADDRESS ?? (config.NODE_ENV === "test" ? config.FLOAT_CLEARING_HOUSE_ADDRESS : undefined);
    const oracle = config.GOLDLAKE_FLOAT_ORACLE_ADDRESS ?? (config.NODE_ENV === "test" ? config.FLOAT_ORACLE_ADDRESS : undefined);
    const vault = config.GOLDLAKE_FLOAT_VAULT_ADDRESS ?? (config.NODE_ENV === "test" ? config.FLOAT_VAULT_ADDRESS : undefined);
    if (!clearingHouse || !oracle || !vault) throw new Error("Goldlake contract addresses are not configured");
    return { ...config, FLOAT_CLEARING_HOUSE_ADDRESS: clearingHouse, FLOAT_ORACLE_ADDRESS: oracle, FLOAT_VAULT_ADDRESS: vault };
  }
  if (version === "silverlake") {
    if (!isSilverlakeConfigured(config)) throw new Error("Silverlake contract addresses are not configured");
    const clearingHouse = config.SILVERLAKE_FLOAT_CLEARING_HOUSE_ADDRESS ?? (config.NODE_ENV === "test" ? config.FLOAT_CLEARING_HOUSE_ADDRESS : undefined);
    const oracle = config.SILVERLAKE_FLOAT_ORACLE_ADDRESS ?? (config.NODE_ENV === "test" ? config.FLOAT_ORACLE_ADDRESS : undefined);
    const vault = config.SILVERLAKE_FLOAT_VAULT_ADDRESS ?? (config.NODE_ENV === "test" ? config.FLOAT_VAULT_ADDRESS : undefined);
    if (!clearingHouse || !oracle || !vault) throw new Error("Silverlake contract addresses are not configured");
    return { ...config, FLOAT_CLEARING_HOUSE_ADDRESS: clearingHouse, FLOAT_ORACLE_ADDRESS: oracle, FLOAT_VAULT_ADDRESS: vault };
  }
  if (version === "amber") {
    const clearingHouse = config.AMBER_FLOAT_CLEARING_HOUSE_ADDRESS ?? (config.NODE_ENV === "test" ? config.FLOAT_CLEARING_HOUSE_ADDRESS : "0x022Cc8DFf79414DcB56812Bd93601854E2b7A700");
    const oracle = config.AMBER_FLOAT_ORACLE_ADDRESS ?? (config.NODE_ENV === "test" ? config.FLOAT_ORACLE_ADDRESS : "0x71B5FBd2df7eF976d02A4b4090450EEE24F77Ce0");
    const vault = config.AMBER_FLOAT_VAULT_ADDRESS ?? (config.NODE_ENV === "test" ? config.FLOAT_VAULT_ADDRESS : "0xD5B0461F09C0Cb67AEd9Ca8e73569EAfa3a2E445");
    return { ...config, FLOAT_CLEARING_HOUSE_ADDRESS: clearingHouse, FLOAT_ORACLE_ADDRESS: oracle, FLOAT_VAULT_ADDRESS: vault };
  }
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
  if (Boolean(config.TELEGRAM_BOT_TOKEN) !== Boolean(config.TELEGRAM_BOT_USERNAME)) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME must be configured together");
  }
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
