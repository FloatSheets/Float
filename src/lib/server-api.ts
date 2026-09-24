import { createServerFn } from "@tanstack/react-start";

type JsonRecord = Record<string, unknown>;

function apiOrigin() {
  const origin = process.env["FLOATSHEETS_API_URL"];
  if (!origin) throw new Error("FLOATSHEETS_API_URL is not configured.");
  return origin.replace(/\/$/, "");
}

async function getJson<T extends JsonRecord>(path: string): Promise<T> {
  const response = await fetch(`${apiOrigin()}${path}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`FloatSheets API returned ${response.status} for ${path}.`);
  return (await response.json()) as T;
}

function symbolInput(input: unknown) {
  if (typeof input !== "string" || !/^[A-Za-z0-9.-]{1,16}$/.test(input)) throw new Error("A valid market symbol is required.");
  return input.toUpperCase();
}

export const getProtocol = createServerFn({ method: "GET" }).handler((): Promise<any> => getJson("/v1/protocol"));
export const getMarkets = createServerFn({ method: "GET" }).handler((): Promise<any> => getJson("/v1/markets"));
export const getMarket = createServerFn({ method: "GET" }).validator(symbolInput).handler(({ data }): Promise<any> => getJson(`/v1/markets/${data}`));
export const getMarketQuotes = createServerFn({ method: "GET" }).validator(symbolInput).handler(({ data }): Promise<any> => getJson(`/v1/markets/${data}/quotes`));
export const getMarketRisk = createServerFn({ method: "GET" }).validator(symbolInput).handler(({ data }): Promise<any> => getJson(`/v1/markets/${data}/risk`));

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
    const response = await fetch(`${apiOrigin()}/v1/protocol/transactions/trade-quote`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Trade quote request failed with ${response.status}.`);
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
    const response = await fetch(`${apiOrigin()}/v1/protocol/transactions/close-quote`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
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
    if (action !== "approve" && action !== "deposit" && action !== "withdraw" && action !== "liquidate") {
      throw new Error("Unsupported wallet transaction.");
    }
    return value;
  })
  .handler(async ({ data }): Promise<any> => {
    const response = await fetch(`${apiOrigin()}/v1/protocol/transactions/${String(data["action"] ?? "")}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(data["payload"] ?? {}),
    });
    if (!response.ok) throw new Error(`Transaction request failed with ${response.status}.`);
    return (await response.json()) as JsonRecord;
  });
