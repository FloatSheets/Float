import { createServerFn } from "@tanstack/react-start";
import { getRequestIP } from "@tanstack/react-start/server";

type JsonRecord = Record<string, unknown>;
type ContractVersion = "goldlake" | "silverlake" | "amber" | "jasper" | "meadow" | "legacy-orion";

function versionOf(value: unknown): ContractVersion {
  return value === "legacy-orion" ? "legacy-orion" : value === "silverlake" ? "silverlake" : value === "jasper" ? "jasper" : value === "meadow" ? "meadow" : value === "amber" ? "amber" : "goldlake";
}

function apiOrigin() {
  const origin = process.env["FLOATSHEETS_API_URL"];
  if (!origin) throw new Error("FLOATSHEETS_API_URL is not configured.");
  return origin.replace(/\/$/, "");
}

function apiHeaders(version: ContractVersion, json = false): HeadersInit {
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-floatsheets-contract-version": version,
  };
  if (json) headers["content-type"] = "application/json";
  const secret = process.env["FLOATSHEETS_SERVER_API_SECRET"];
  const clientIp = getRequestIP({ xForwardedFor: true });
  if (secret) {
    headers["x-floatsheets-server-secret"] = secret;
    if (clientIp) headers["x-floatsheets-client-ip"] = clientIp;
  }
  return headers;
}

async function getJson<T extends JsonRecord>(path: string, version: ContractVersion = "goldlake"): Promise<T> {
  const response = await fetch(`${apiOrigin()}${path}`, { headers: apiHeaders(version) });
  if (!response.ok) throw new Error(`FloatSheets API returned ${response.status} for ${path}.`);
  return (await response.json()) as T;
}

function symbolInput(input: unknown) {
  if (typeof input !== "string" || !/^[A-Za-z0-9.-]{1,16}$/.test(input)) throw new Error("A valid market symbol is required.");
  return input.toUpperCase();
}

export const getProtocol = createServerFn({ method: "GET" }).validator((input: unknown) => versionOf((input as JsonRecord | undefined)?.["version"])).handler(({ data }): Promise<any> => getJson("/v1/protocol", data));
export const getMarkets = createServerFn({ method: "GET" }).validator((input: unknown) => versionOf((input as JsonRecord | undefined)?.["version"])).handler(({ data }): Promise<any> => getJson("/v1/markets", data));
export const getFloatNews = createServerFn({ method: "GET" }).handler((): Promise<any> => getJson("/v1/news"));
export const getMarket = createServerFn({ method: "GET" }).validator(symbolInput).handler(({ data }): Promise<any> => getJson(`/v1/markets/${data}`));
export const getMarketQuotes = createServerFn({ method: "GET" }).validator(symbolInput).handler(({ data }): Promise<any> => getJson(`/v1/markets/${data}/quotes`));
export const getMarketRisk = createServerFn({ method: "GET" }).validator(symbolInput).handler(({ data }): Promise<any> => getJson(`/v1/markets/${data}/risk`));
export const getKeeperStatus = createServerFn({ method: "GET" }).handler((): Promise<any> => getJson("/v1/keeper", "goldlake"));
export const getWeekendAllowance = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const data = input as JsonRecord;
    const trader = String(data["trader"] ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(trader)) throw new Error("A valid wallet address is required.");
    return { symbol: symbolInput(data["symbol"]), trader, version: versionOf(data["version"]) };
  })
  .handler(({ data }): Promise<any> => getJson(`/v1/protocol/transactions/weekend-allowance?market=${data.symbol}&trader=${data.trader}`, data.version));

type VersionedMarketInput = { symbol: string; version: ContractVersion };
function versionedMarketInput(input: unknown): VersionedMarketInput {
  if (!input || typeof input !== "object") throw new Error("A market request is required.");
  const value = input as JsonRecord;
  return { symbol: symbolInput(value["symbol"]), version: versionOf(value["version"]) };
}

export const getLiveMarket = createServerFn({ method: "GET" })
  .validator(versionedMarketInput)
  .handler(({ data }): Promise<any> => getJson(`/v1/markets/${data.symbol}/live`, data.version));

export const getMarketHistory = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const value = versionedMarketInput(input);
    const range = (input as JsonRecord)["range"];
    if (typeof range !== "string" || !["1H", "4H", "1D", "1W", "1M"].includes(range)) throw new Error("A valid history range is required.");
    return { ...value, range };
  })
  .handler(({ data }): Promise<any> => getJson(`/v1/markets/${data.symbol}/history?format=candles&range=${encodeURIComponent(data.range)}`, data.version));

/** The API owns quote construction/signing; the browser receives only calldata to sign. */
export const getTradeTransaction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Trade intent is required.");
    const value = input as JsonRecord;
    if (typeof value["market"] !== "string" || !/^[A-Za-z0-9.-]{1,16}$/.test(value["market"])) throw new Error("A valid market is required.");
    if (typeof value["trader"] !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value["trader"])) throw new Error("A valid trader address is required.");
    if (typeof value["isLong"] !== "boolean" || typeof value["notionalUsdg"] !== "string" || !/^\d+$/.test(value["notionalUsdg"])) throw new Error("A valid trade intent is required.");
    return value;
  })
  .handler(async ({ data }): Promise<any> => {
    const version = versionOf(data["contractVersion"]);
    const response = await fetch(`${apiOrigin()}/v1/protocol/transactions/trade-quote`, {
      method: "POST",
      headers: apiHeaders(version, true),
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Trade quote request failed with ${response.status}.`);
    }
    return (await response.json()) as JsonRecord;
  });

/** Read-only live contract-risk preflight. It does not publish an oracle price or sign a quote. */
export const checkTrade = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Trade check is required.");
    const value = input as JsonRecord;
    if (typeof value["market"] !== "string" || !/^[A-Za-z0-9.-]{1,16}$/.test(value["market"])) throw new Error("A valid market is required.");
    if (typeof value["trader"] !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value["trader"])) throw new Error("A valid trader address is required.");
    if (typeof value["isLong"] !== "boolean" || !["notionalUsdg", "marginUsdg", "targetLeverage"].every((key) => typeof value[key] === "string" && /^\d+$/.test(value[key] as string))) throw new Error("A valid trade check is required.");
    return value;
  })
  .handler(async ({ data }): Promise<any> => {
    const version = versionOf(data["contractVersion"]);
    const response = await fetch(`${apiOrigin()}/v1/protocol/transactions/trade-check`, {
      method: "POST", headers: apiHeaders(version, true), body: JSON.stringify(data),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Trade check failed with ${response.status}.`);
    }
    return (await response.json()) as JsonRecord;
  });

/** Full closes use the exact on-chain base size so a position cannot leave dust or flip sides. */
export const getCloseTransaction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Close intent is required.");
    const value = input as JsonRecord;
    if (typeof value["market"] !== "string" || !/^[A-Za-z0-9.-]{1,16}$/.test(value["market"])) throw new Error("A valid market is required.");
    if (typeof value["trader"] !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value["trader"])) throw new Error("A valid trader address is required.");
    return value;
  })
  .handler(async ({ data }): Promise<any> => {
    const version = versionOf(data["contractVersion"]);
    const response = await fetch(`${apiOrigin()}/v1/protocol/transactions/close-quote`, {
      method: "POST",
      headers: apiHeaders(version, true),
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Close request failed with ${response.status}.`);
    }
    return (await response.json()) as JsonRecord;
  });

/** Wallet transaction calldata is public; the wallet signs it locally. */
export const getTransactionCalldata = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Transaction input is required.");
    const value = input as JsonRecord;
    const action = value["action"];
    if (action !== "approve" && action !== "deposit" && action !== "withdraw" && action !== "liquidate"
      && action !== "vault-approve" && action !== "vault-deposit" && action !== "vault-withdraw"
      && action !== "vault-settle-queue" && action !== "vault-start-next-epoch"
      && action !== "vault-claim-deposit" && action !== "vault-claim-withdrawal"
      && action !== "vault-cancel-withdrawal") {
      throw new Error("Unsupported wallet transaction.");
    }
    return value;
  })
  .handler(async ({ data }): Promise<any> => {
    const version = versionOf(data["contractVersion"]);
    const response = await fetch(`${apiOrigin()}/v1/protocol/transactions/${String(data["action"] ?? "")}`, {
      method: "POST",
      headers: apiHeaders(version, true),
      body: JSON.stringify(data["payload"] ?? {}),
    });
    if (!response.ok) throw new Error(`Transaction request failed with ${response.status}.`);
    return (await response.json()) as JsonRecord;
  });

function emailAlertInput(input: unknown) {
  if (!input || typeof input !== "object") throw new Error("Email alert request is required.");
  const value = input as JsonRecord;
  if (typeof value["wallet"] !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value["wallet"])) throw new Error("A valid wallet is required.");
  return value;
}

async function emailAlertPost(path: string, body: JsonRecord): Promise<any> {
  const response = await fetch(`${apiOrigin()}/v1/email-alerts/${path}`, {
    method: "POST", headers: apiHeaders("goldlake", true), body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({})) as JsonRecord;
  if (!response.ok) throw new Error(typeof result["error"] === "string" ? result["error"] : `Email alert request failed (${response.status}).`);
  return result;
}

export const getEmailAlertChallenge = createServerFn({ method: "POST" })
  .validator(emailAlertInput)
  .handler(({ data }): Promise<any> => emailAlertPost("challenge", data));

export const saveEmailAlertSettings = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const value = emailAlertInput(input);
    if (typeof value["signature"] !== "string" || typeof value["enabled"] !== "boolean"
      || (value["enabled"] && (typeof value["email"] !== "string" || value["email"].length > 254))) throw new Error("Valid signed email settings are required.");
    return value;
  })
  .handler(({ data }): Promise<any> => emailAlertPost("settings", data));

export const verifyEmailAlert = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (!input || typeof input !== "object" || typeof (input as JsonRecord)["token"] !== "string") throw new Error("A verification token is required.");
    return { token: (input as JsonRecord)["token"] as string };
  })
  .handler(({ data }): Promise<any> => emailAlertPost("verify", data));

function telegramAlertInput(input: unknown) {
  if (!input || typeof input !== "object") throw new Error("Telegram alert request is required.");
  const value = input as JsonRecord;
  if (typeof value["wallet"] !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value["wallet"])) throw new Error("A valid wallet is required.");
  return value;
}

async function telegramAlertPost(path: string, body: JsonRecord): Promise<any> {
  const response = await fetch(`${apiOrigin()}/v1/telegram-alerts/${path}`, {
    method: "POST", headers: apiHeaders("goldlake", true), body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({})) as JsonRecord;
  if (!response.ok) throw new Error(typeof result["error"] === "string" ? result["error"] : `Telegram alert request failed (${response.status}).`);
  return result;
}

export const getTelegramAlertLinkChallenge = createServerFn({ method: "POST" })
  .validator(telegramAlertInput)
  .handler(({ data }): Promise<any> => telegramAlertPost("link-challenge", data));

export const createTelegramAlertLink = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const value = telegramAlertInput(input);
    if (typeof value["signature"] !== "string") throw new Error("A wallet signature is required.");
    return value;
  })
  .handler(({ data }): Promise<any> => telegramAlertPost("link", data));

export const getTelegramAlertLinkStatus = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (!input || typeof input !== "object" || typeof (input as JsonRecord)["token"] !== "string") throw new Error("A Telegram link token is required.");
    return { token: (input as JsonRecord)["token"] as string };
  })
  .handler(({ data }): Promise<any> => telegramAlertPost("link-status", data));

export const getTelegramAlertSettingsChallenge = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const value = telegramAlertInput(input);
    if (typeof value["enabled"] !== "boolean") throw new Error("Telegram alert state is required.");
    return value;
  })
  .handler(({ data }): Promise<any> => telegramAlertPost("settings-challenge", data));

export const saveTelegramAlertSettings = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const value = telegramAlertInput(input);
    if (typeof value["signature"] !== "string" || typeof value["enabled"] !== "boolean") throw new Error("Valid signed Telegram alert settings are required.");
    return value;
  })
  .handler(({ data }): Promise<any> => telegramAlertPost("settings", data));
