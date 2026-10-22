import { Router } from "express";
import type { Pool } from "pg";

type SecCompany = { cik_str: number; ticker: string; title: string };
type SecRecentFilings = {
  cik: string;
  name: string;
  filings?: { recent?: Record<string, unknown[]> };
};
type NewsItem = {
  id: string;
  symbol: string;
  company: string;
  form: string;
  filedAt: string;
  acceptedAt: string | null;
  title: string;
  url: string;
  source: "SEC EDGAR";
};

const supportedForms = new Set(["8-K", "10-K", "10-Q", "6-K", "20-F", "S-1", "DEF 14A"]);
const investorRelations: Record<string, string> = {
  AMC: "https://investor.amctheatres.com/",
  NVDA: "https://investor.nvidia.com/",
  CRCL: "https://investor.circle.com/",
  HIMS: "https://investors.hims.com/",
  MU: "https://investors.micron.com/",
  TSLA: "https://ir.tesla.com/",
  RDDT: "https://investor.redditinc.com/",
  MSTR: "https://www.strategy.com/investor-relations",
  PLTR: "https://investors.palantir.com/",
  QUBT: "https://quantumcomputinginc.com/investor-relations",
};
const SEC_CACHE_MS = 10 * 60_000;
let companyIndex: { expiresAt: number; byTicker: Map<string, SecCompany> } | undefined;
let newsCache: { expiresAt: number; items: NewsItem[] } | undefined;
let refreshInFlight: Promise<NewsItem[]> | undefined;

function secHeaders(): HeadersInit {
  const contact = process.env.RESEND_FROM_EMAIL ?? "alerts@updates.floatsheets.app";
  return {
    accept: "application/json",
    // SEC fair-access policy asks automated clients to identify themselves.
    // Override with a contact-bearing value in production when available.
    "user-agent": process.env.SEC_USER_AGENT?.trim() || `FloatSheets News/1.0 (${contact})`,
  };
}

async function readCompanyIndex(): Promise<Map<string, SecCompany>> {
  if (companyIndex && companyIndex.expiresAt > Date.now()) return companyIndex.byTicker;
  const response = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: secHeaders(), signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`SEC company index returned HTTP ${response.status}`);
  const rows = Object.values(await response.json() as Record<string, SecCompany>);
  const byTicker = new Map(rows.map((row) => [row.ticker.toUpperCase(), row]));
  companyIndex = { expiresAt: Date.now() + 24 * 60 * 60_000, byTicker };
  return byTicker;
}

function valueAt<T>(values: unknown[] | undefined, index: number): T | undefined {
  return values?.[index] as T | undefined;
}

async function fetchCompanyFilings(symbol: string, company: SecCompany): Promise<NewsItem[]> {
  const cik = String(company.cik_str).padStart(10, "0");
  const response = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: secHeaders(), signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`SEC submissions returned HTTP ${response.status} for ${symbol}`);
  const payload = await response.json() as SecRecentFilings;
  const recent = payload.filings?.recent ?? {};
  const forms = recent["form"] as string[] | undefined;
  const dates = recent["filingDate"] as string[] | undefined;
  const accepted = recent["acceptanceDateTime"] as string[] | undefined;
  const accessionNumbers = recent["accessionNumber"] as string[] | undefined;
  const primaryDocuments = recent["primaryDocument"] as string[] | undefined;
  if (!forms || !dates || !accessionNumbers || !primaryDocuments) return [];

  const items: NewsItem[] = [];
  for (let index = 0; index < forms.length && items.length < 8; index += 1) {
    const form = forms[index];
    const filedAt = dates[index];
    const accession = accessionNumbers[index];
    const document = primaryDocuments[index];
    if (!form || !supportedForms.has(form) || !filedAt || !accession || !document) continue;
    const accessionPath = accession.replaceAll("-", "");
    const safeDocument = encodeURIComponent(document);
    items.push({
      id: `${symbol}:${accession}`,
      symbol,
      company: payload.name || company.title,
      form,
      filedAt,
      acceptedAt: valueAt<string>(accepted, index) ?? null,
      title: `${company.title} files Form ${form}`,
      url: `https://www.sec.gov/Archives/edgar/data/${company.cik_str}/${accessionPath}/${safeDocument}`,
      source: "SEC EDGAR",
    });
  }
  return items;
}

async function refreshNews(database: Pool): Promise<NewsItem[]> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const { rows } = await database.query<{ symbol: string }>("SELECT symbol FROM public.markets WHERE listed = TRUE ORDER BY symbol");
    const index = await readCompanyIndex();
    // Keep requests comfortably below the SEC's published 10 requests/second ceiling.
    const results: NewsItem[] = [];
    for (const row of rows) {
      const symbol = row.symbol.toUpperCase();
      const company = index.get(symbol);
      if (!company) continue;
      try {
        results.push(...await fetchCompanyFilings(symbol, company));
      } catch (error) {
        console.warn("Float News SEC filing refresh failed", symbol, error);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return results.sort((a, b) => b.filedAt.localeCompare(a.filedAt)).slice(0, 80);
  })();
  try {
    const items = await refreshInFlight;
    newsCache = { expiresAt: Date.now() + SEC_CACHE_MS, items };
    return items;
  } finally {
    refreshInFlight = undefined;
  }
}

export function createNewsRouter(database: Pool): Router {
  const router = Router();
  router.get("/", async (_request, response) => {
    try {
      const items = newsCache && newsCache.expiresAt > Date.now()
        ? newsCache.items
        : await refreshNews(database);
      const { rows } = await database.query<{ symbol: string }>("SELECT symbol FROM public.markets WHERE listed = TRUE ORDER BY symbol");
      const index = await readCompanyIndex();
      response.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      response.json({
        items,
        issuers: rows.map(({ symbol }) => {
          const ticker = symbol.toUpperCase();
          const company = index.get(ticker);
          return {
            symbol: ticker,
            company: company?.title ?? ticker,
            cik: company ? String(company.cik_str).padStart(10, "0") : null,
            investor_relations_url: investorRelations[ticker] ?? null,
          };
        }),
        updated_at: new Date().toISOString(),
        sources: ["SEC EDGAR", "Issuer investor relations sites"],
      });
    } catch (error) {
      console.error("Float News refresh failed", error);
      response.status(502).json({ error: "Official filing updates are temporarily unavailable." });
    }
  });
  return router;
}
