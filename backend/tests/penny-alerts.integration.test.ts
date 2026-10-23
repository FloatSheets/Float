import "dotenv/config";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";

import { classifyPennyState, PennyMarketAlerts, setPennyAlertSubscription } from "../src/alerts/penny-alerts";
import { loadConfig } from "../src/config";
import { db } from "../src/db";
import { migrate } from "../src/db/migrate";

const key = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const signer = privateKeyToAccount(key).address;
const config = loadConfig({
  ADMIN_EOA_ADDRESS: "0x1111111111111111111111111111111111111111", FLOAT_CLEARING_HOUSE_ADDRESS: "0x2222222222222222222222222222222222222222",
  FLOAT_ORACLE_ADDRESS: "0x3333333333333333333333333333333333333333", FLOAT_VAULT_ADDRESS: "0x4444444444444444444444444444444444444444",
  MASTER_ADMIN_KEY: "test-master-admin-key-012345678901234567890123456789", USDG_ADDRESS: "0x5555555555555555555555555555555555555555",
  FRONTEND_URL: "https://floatsheets.app", LOG_LEVEL: "info", MARKET_POLL_INTERVAL_MS: "15000", NODE_ENV: "test",
  ORACLE_PRICE_MAX_AGE_SECONDS: "120", ORACLE_PUBLISHER_ADDRESS: signer, ORACLE_PUBLISHER_PRIVATE_KEY: key,
  ORACLE_SIGNER_ADDRESS: signer, ORACLE_SIGNER_PRIVATE_KEY: key, QUOTE_TTL_SECONDS: "15", QUOTE_SIGNER_ADDRESS: signer, QUOTE_SIGNER_PRIVATE_KEY: key,
  RHC_ID: "4663", RHC_RPC_URL: "https://rpc.mainnet.chain.robinhood.com", UNISWAP_TWAP_WINDOW_SECONDS: "300",
  TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_BOT_USERNAME: "floatsheets_test_bot"
});

const T0 = new Date("2027-04-01T15:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1_000);
const inserted: Date[] = [];
const realFetch = globalThis.fetch;
const sent: { chat_id: string; text: string }[] = [];

/** Every penny market is live at `time`, except TE with the given condition. */
async function snapshot(time: Date, te: { tradable: boolean; reason: string | null }): Promise<void> {
  await db.query(
    `INSERT INTO public.pool_snapshots (market_id, observed_at, sqrt_price_x96, liquidity, usdg_balance, twap_price_usdg, spot_price_usdg,
       spot_twap_deviation_bps, oracle_tradable, frozen_reason)
     SELECT id, $1, 1, 1, 1, 2.3, 2.3, 0, CASE WHEN symbol='TE' THEN $2 ELSE true END, CASE WHEN symbol='TE' THEN $3 ELSE NULL END
     FROM public.markets WHERE 'copper' = ANY(releases)`, [time, te.tradable, te.reason]
  );
  inserted.push(time);
}

beforeEach(async () => {
  await migrate();
  await db.query("TRUNCATE public.penny_alert_subscriptions, public.penny_market_alert_state, public.exchange_halts");
  await setPennyAlertSubscription(db, "subscriber-chat", true);
  sent.length = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, result: {} });
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (inserted.length) await db.query("DELETE FROM public.pool_snapshots WHERE observed_at = ANY($1::timestamptz[])", [inserted]);
  inserted.length = 0;
});

test("classifies halts, price pauses and quiet quotes", () => {
  expect(classifyPennyState({ tradable: false, frozenReason: null, exchangeHalt: "news pending on NASDAQ" }).state).toBe("halt");
  expect(classifyPennyState({ tradable: false, frozenReason: "trading halt reported by a price source", exchangeHalt: null }).state).toBe("halt");
  expect(classifyPennyState({ tradable: false, frozenReason: "price is 64 bps from its 15-minute average", exchangeHalt: null }).state).toBe("pause");
  expect(classifyPennyState({ tradable: false, frozenReason: "price sources disagree by 210 bps", exchangeHalt: null }).state).toBe("pause");
  expect(classifyPennyState({ tradable: false, frozenReason: "collecting live prices (4 of 20)", exchangeHalt: null }).state).toBe("quiet");
  expect(classifyPennyState({ tradable: false, frozenReason: "no live price source", exchangeHalt: null }).state).toBe("quiet");
  expect(classifyPennyState({ tradable: true, frozenReason: null, exchangeHalt: null }).state).toBe("live");
});

test("announces confirmed pauses, halts and resumptions once each", async () => {
  const alerts = new PennyMarketAlerts(db, config);
  const live = { tradable: true, reason: null };
  const pause = { tradable: false, reason: "price is 64 bps from its 15-minute average" };

  await snapshot(at(0), live);
  await alerts.runOnce(at(0));
  expect(sent).toHaveLength(0); // the first look is a baseline

  // A one-minute flicker is not announced, and neither is its recovery.
  await snapshot(at(30), pause);
  await alerts.runOnce(at(30));
  await alerts.runOnce(at(90));
  await snapshot(at(100), live);
  await alerts.runOnce(at(100));
  expect(sent).toHaveLength(0);

  // A pause that holds two minutes is announced once.
  await snapshot(at(200), pause);
  await alerts.runOnce(at(200));
  await alerts.runOnce(at(330));
  await alerts.runOnce(at(360));
  expect(sent.map((message) => message.text)).toEqual([
    "⏸ $TE paused on FloatSheets: price is 64 bps from its 15-minute average.\nNew positions wait until the price settles; closing stays open."
  ]);
  expect(sent[0]!.chat_id).toBe("subscriber-chat");

  // Back to live: one resumption message.
  await snapshot(at(400), live);
  await alerts.runOnce(at(400));
  await alerts.runOnce(at(430));
  expect(sent).toHaveLength(2);
  expect(sent[1]!.text).toBe("▶️ $TE is trading again on FloatSheets. New positions are open.");

  // An exchange halt is announced immediately.
  await db.query("INSERT INTO public.exchange_halts (symbol, halted_at, listing_market, reason_code, active, last_seen_at) VALUES ('TE',$1,'NASDAQ','LUDP',true,$1)", [at(500)]);
  await alerts.runOnce(at(500));
  expect(sent[2]!.text).toBe("🛑 $TE is halted: volatility trading pause on NASDAQ.\nNew TE positions are paused on FloatSheets; closing stays open.");

  // Unsubscribed chats get nothing.
  await setPennyAlertSubscription(db, "subscriber-chat", false);
  await db.query("TRUNCATE public.exchange_halts");
  await alerts.runOnce(at(600));
  expect(sent).toHaveLength(3);
}, 60_000);
