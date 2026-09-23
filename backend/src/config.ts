import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";

const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be an EVM address");

const schema = z.object({
  ADMIN_EOA_ADDRESS: address,
  FLOAT_CLEARING_HOUSE_ADDRESS: address,
  FLOAT_ORACLE_ADDRESS: address,
  FLOAT_VAULT_ADDRESS: address,
  FRONTEND_URL: z.url(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]),
  MARKET_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000),
  NODE_ENV: z.enum(["development", "test", "production"]),
  ORACLE_PRICE_MAX_AGE_SECONDS: z.coerce.number().int().min(15),
  ORACLE_SIGNER_ADDRESS: address,
  ORACLE_SIGNER_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "must be a 32-byte private key"),
  QUOTE_TTL_SECONDS: z.coerce.number().int().min(1).max(60),
  QUOTE_SIGNER_ADDRESS: address,
  QUOTE_SIGNER_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "must be a 32-byte private key"),
  RHC_ID: z.coerce.number().int().refine((value) => value === 4663, "must be Robinhood Chain (4663)"),
  RHC_RPC_URL: z.url(),
  UNISWAP_TWAP_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400)
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(environment: Record<string, string | undefined> = process.env): AppConfig {
  const config = schema.parse(environment);
  const derivedSignerAddress = privateKeyToAccount(config.ORACLE_SIGNER_PRIVATE_KEY as `0x${string}`).address;
  if (derivedSignerAddress.toLowerCase() !== config.ORACLE_SIGNER_ADDRESS.toLowerCase()) {
    throw new Error("ORACLE_SIGNER_ADDRESS does not match ORACLE_SIGNER_PRIVATE_KEY");
  }
  const derivedQuoteSignerAddress = privateKeyToAccount(config.QUOTE_SIGNER_PRIVATE_KEY as `0x${string}`).address;
  if (derivedQuoteSignerAddress.toLowerCase() !== config.QUOTE_SIGNER_ADDRESS.toLowerCase()) {
    throw new Error("QUOTE_SIGNER_ADDRESS does not match QUOTE_SIGNER_PRIVATE_KEY");
  }
  return config;
}
