import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import { recoverMessageAddress } from "viem";
import { contractConfigForVersion, type AppConfig } from "../config";

const walletPattern = /^0x[a-fA-F0-9]{40}$/;
const signaturePattern = /^0x[a-fA-F0-9]{130}$/;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function telegramConfigured(config: AppConfig): boolean {
  return Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_BOT_USERNAME);
}

export async function telegramRequest<T>(config: AppConfig, method: string, body?: Record<string, unknown>): Promise<T> {
  if (!config.TELEGRAM_BOT_TOKEN) throw new Error("Telegram bot is not configured");
  const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {})
  });
  const result = await response.json().catch(() => ({})) as { ok?: boolean; result?: T };
  if (!response.ok || result.ok !== true) throw new Error(`Telegram ${method} request failed (${response.status})`);
  return result.result as T;
}

export function createTelegramAlertsRouter(database: Pool, config: AppConfig): Router {
  const router = Router();

  router.post("/link-challenge", async (request, response) => {
    const wallet = request.body?.wallet;
    if (typeof wallet !== "string" || !walletPattern.test(wallet)) return response.status(400).json({ error: "A valid wallet is required" });
    if (!telegramConfigured(config)) return response.status(503).json({ error: "Telegram alerts are not configured" });
    const normalized = wallet.toLowerCase();
    const nonce = randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const message = [
      "FloatSheets Telegram liquidation alerts",
      `Wallet: ${normalized}`,
      "Action: link and enable Telegram alerts",
      `Nonce: ${nonce}`,
      `Expires: ${expiresAt.toISOString()}`,
      "This signature authorizes only linking a Telegram account for liquidation alerts."
    ].join("\n");
    await database.query(
      `INSERT INTO public.liquidation_telegram_wallet_challenges(wallet_address,message,action,expires_at)
       VALUES($1,$2,'link',$3)
       ON CONFLICT(wallet_address) DO UPDATE SET message=EXCLUDED.message,action='link',expires_at=EXCLUDED.expires_at`,
      [normalized, message, expiresAt]
    );
    response.json({ message });
  });

  router.post("/link", async (request, response) => {
    const wallet = request.body?.wallet;
    const signature = request.body?.signature;
    if (typeof wallet !== "string" || !walletPattern.test(wallet) || typeof signature !== "string" || !signaturePattern.test(signature)) {
      return response.status(400).json({ error: "Valid signed wallet authorization is required" });
    }
    if (!telegramConfigured(config)) return response.status(503).json({ error: "Telegram alerts are not configured" });
    const normalized = wallet.toLowerCase();
    const challenge = await database.query<{ message: string; action: string; expires_at: Date }>(
      "SELECT message,action,expires_at FROM public.liquidation_telegram_wallet_challenges WHERE wallet_address=$1", [normalized]
    );
    const row = challenge.rows[0];
    if (!row || row.action !== "link" || new Date(row.expires_at).getTime() <= Date.now()) {
      return response.status(401).json({ error: "Wallet authorization expired; try again" });
    }
    let recovered: string;
    try { recovered = await recoverMessageAddress({ message: row.message, signature: signature as `0x${string}` }); }
    catch { return response.status(401).json({ error: "Wallet signature is invalid" }); }
    if (recovered.toLowerCase() !== normalized) return response.status(401).json({ error: "Wallet signature does not match" });

    const client = await database.connect();
    const linkToken = randomBytes(32).toString("base64url");
    try {
      await client.query("BEGIN");
      const consumed = await client.query(
        "DELETE FROM public.liquidation_telegram_wallet_challenges WHERE wallet_address=$1 AND message=$2 AND expires_at>now() RETURNING wallet_address",
        [normalized, row.message]
      );
      if (!consumed.rowCount) {
        await client.query("ROLLBACK");
        return response.status(401).json({ error: "Wallet authorization expired; try again" });
      }
      await client.query("DELETE FROM public.liquidation_telegram_link_codes WHERE wallet_address=$1 AND linked_at IS NULL", [normalized]);
      await client.query(
        `INSERT INTO public.liquidation_telegram_link_codes(token_hash,wallet_address,expires_at)
         VALUES($1,$2,now()+interval '10 minutes')`, [digest(linkToken), normalized]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }

    response.json({
      link_url: `https://t.me/${config.TELEGRAM_BOT_USERNAME}?start=${encodeURIComponent(linkToken)}`,
      token: linkToken,
      expires_in_seconds: 600,
      message: "Open Telegram and tap Start to link this account and enable alerts."
    });
  });

  router.post("/link-status", async (request, response) => {
    const token = request.body?.token;
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return response.status(400).json({ error: "Invalid link token" });
    const result = await database.query<{ linked_at: Date | null; telegram_username: string | null }>(
      "SELECT linked_at,telegram_username FROM public.liquidation_telegram_link_codes WHERE token_hash=$1 AND expires_at>now()",
      [digest(token)]
    );
    const row = result.rows[0];
    if (!row) return response.status(404).json({ error: "Link expired; start again from dashboard settings" });
    response.json({ linked: Boolean(row.linked_at), telegram_username: row.telegram_username });
  });

  router.post("/settings-challenge", async (request, response) => {
    const wallet = request.body?.wallet;
    const enabled = request.body?.enabled;
    if (typeof wallet !== "string" || !walletPattern.test(wallet) || typeof enabled !== "boolean") {
      return response.status(400).json({ error: "Valid wallet alert settings are required" });
    }
    if (!telegramConfigured(config)) return response.status(503).json({ error: "Telegram alerts are not configured" });
    const normalized = wallet.toLowerCase();
    const action = enabled ? "enable" : "disable";
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const message = [
      "FloatSheets Telegram liquidation alerts",
      `Wallet: ${normalized}`,
      `Action: ${action}`,
      `Nonce: ${randomBytes(24).toString("hex")}`,
      `Expires: ${expiresAt.toISOString()}`,
      "This signature authorizes only Telegram liquidation-alert settings for this wallet."
    ].join("\n");
    await database.query(
      `INSERT INTO public.liquidation_telegram_wallet_challenges(wallet_address,message,action,expires_at)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(wallet_address) DO UPDATE SET message=EXCLUDED.message,action=EXCLUDED.action,expires_at=EXCLUDED.expires_at`,
      [normalized, message, action, expiresAt]
    );
    response.json({ message });
  });

  router.post("/settings", async (request, response) => {
    const wallet = request.body?.wallet;
    const signature = request.body?.signature;
    const enabled = request.body?.enabled;
    if (typeof wallet !== "string" || !walletPattern.test(wallet) || typeof signature !== "string" || !signaturePattern.test(signature) || typeof enabled !== "boolean") {
      return response.status(400).json({ error: "Valid signed Telegram settings are required" });
    }
    const normalized = wallet.toLowerCase();
    const action = enabled ? "enable" : "disable";
    const result = await database.query<{ message: string; action: string; expires_at: Date }>(
      "SELECT message,action,expires_at FROM public.liquidation_telegram_wallet_challenges WHERE wallet_address=$1", [normalized]
    );
    const row = result.rows[0];
    if (!row || row.action !== action || new Date(row.expires_at).getTime() <= Date.now()) return response.status(401).json({ error: "Wallet authorization expired; try again" });
    let recovered: string;
    try { recovered = await recoverMessageAddress({ message: row.message, signature: signature as `0x${string}` }); }
    catch { return response.status(401).json({ error: "Wallet signature is invalid" }); }
    if (recovered.toLowerCase() !== normalized) return response.status(401).json({ error: "Wallet signature does not match" });
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      const consumed = await client.query(
        "DELETE FROM public.liquidation_telegram_wallet_challenges WHERE wallet_address=$1 AND message=$2 AND action=$3 AND expires_at>now() RETURNING wallet_address",
        [normalized, row.message, action]
      );
      if (!consumed.rowCount) {
        await client.query("ROLLBACK");
        return response.status(401).json({ error: "Wallet authorization expired; try again" });
      }
      const update = await client.query(
        "UPDATE public.liquidation_telegram_links SET enabled=$2,updated_at=now() WHERE wallet_address=$1 RETURNING telegram_username",
        [normalized, enabled]
      );
      if (!update.rowCount) {
        await client.query("ROLLBACK");
        return response.status(409).json({ error: "Link your Telegram account before enabling alerts" });
      }
      await client.query("COMMIT");
      response.json({ enabled, telegram_username: update.rows[0]?.telegram_username, message: enabled ? "Telegram liquidation alerts enabled" : "Telegram liquidation alerts disabled" });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });

  router.post("/settlement-status", async (request, response) => {
    const wallet = request.body?.wallet;
    if (typeof wallet !== "string" || !walletPattern.test(wallet)) return response.status(400).json({ error: "A valid wallet is required" });
    if (!telegramConfigured(config)) return response.status(503).json({ error: "Telegram alerts are not configured" });
    const vault = contractConfigForVersion(config, "goldlake").FLOAT_VAULT_ADDRESS!.toLowerCase();
    const result = await database.query<{ linked: boolean; enabled: boolean }>(
      `SELECT (l.wallet_address IS NOT NULL) AS linked, COALESCE(s.enabled,FALSE) AS enabled
       FROM (SELECT $1::text AS wallet_address) w
       LEFT JOIN public.liquidation_telegram_links l ON l.wallet_address=w.wallet_address
       LEFT JOIN public.telegram_vault_subscriptions s ON s.wallet_address=l.wallet_address AND s.vault_address=$2`,
      [wallet.toLowerCase(), vault]
    );
    response.json(result.rows[0] ?? { linked: false, enabled: false });
  });

  router.post("/settlement-settings-challenge", async (request, response) => {
    const wallet = request.body?.wallet;
    const enabled = request.body?.enabled;
    if (typeof wallet !== "string" || !walletPattern.test(wallet) || typeof enabled !== "boolean") {
      return response.status(400).json({ error: "Valid wallet settlement settings are required" });
    }
    if (!telegramConfigured(config)) return response.status(503).json({ error: "Telegram alerts are not configured" });
    const normalized = wallet.toLowerCase();
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const message = [
      "FloatSheets Goldlake settlement notifications",
      `Wallet: ${normalized}`,
      `Action: ${enabled ? "enable" : "disable"} settlement notifications`,
      `Nonce: ${randomBytes(24).toString("hex")}`,
      `Expires: ${expiresAt.toISOString()}`,
      "This signature changes only this wallet's Goldlake settlement notification preference."
    ].join("\n");
    await database.query(
      `INSERT INTO public.telegram_vault_settings_challenges(wallet_address,enabled,message,expires_at)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(wallet_address) DO UPDATE SET enabled=EXCLUDED.enabled,message=EXCLUDED.message,expires_at=EXCLUDED.expires_at`,
      [normalized, enabled, message, expiresAt]
    );
    response.json({ message });
  });

  router.post("/settlement-settings", async (request, response) => {
    const wallet = request.body?.wallet;
    const signature = request.body?.signature;
    const enabled = request.body?.enabled;
    if (typeof wallet !== "string" || !walletPattern.test(wallet) || typeof signature !== "string" || !signaturePattern.test(signature) || typeof enabled !== "boolean") {
      return response.status(400).json({ error: "Valid signed settlement settings are required" });
    }
    if (!telegramConfigured(config)) return response.status(503).json({ error: "Telegram alerts are not configured" });
    const normalized = wallet.toLowerCase();
    const challenge = await database.query<{ message: string; enabled: boolean; expires_at: Date }>(
      "SELECT message,enabled,expires_at FROM public.telegram_vault_settings_challenges WHERE wallet_address=$1", [normalized]
    );
    const row = challenge.rows[0];
    if (!row || row.enabled !== enabled || new Date(row.expires_at).getTime() <= Date.now()) {
      return response.status(401).json({ error: "Wallet authorization expired; try again" });
    }
    let recovered: string;
    try { recovered = await recoverMessageAddress({ message: row.message, signature: signature as `0x${string}` }); }
    catch { return response.status(401).json({ error: "Wallet signature is invalid" }); }
    if (recovered.toLowerCase() !== normalized) return response.status(401).json({ error: "Wallet signature does not match" });
    const vault = contractConfigForVersion(config, "goldlake").FLOAT_VAULT_ADDRESS!.toLowerCase();
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      const consumed = await client.query(
        "DELETE FROM public.telegram_vault_settings_challenges WHERE wallet_address=$1 AND message=$2 AND enabled=$3 AND expires_at>now() RETURNING wallet_address",
        [normalized, row.message, enabled]
      );
      if (!consumed.rowCount) {
        await client.query("ROLLBACK");
        return response.status(401).json({ error: "Wallet authorization expired; try again" });
      }
      if (enabled) {
        const linked = await client.query(
          `INSERT INTO public.telegram_vault_subscriptions(wallet_address,telegram_chat_id,vault_address)
           SELECT wallet_address,telegram_chat_id,$2 FROM public.liquidation_telegram_links WHERE wallet_address=$1
           ON CONFLICT(wallet_address) DO UPDATE SET
             next_epoch=CASE WHEN telegram_vault_subscriptions.telegram_chat_id<>EXCLUDED.telegram_chat_id
               OR telegram_vault_subscriptions.vault_address<>EXCLUDED.vault_address THEN 0 ELSE telegram_vault_subscriptions.next_epoch END,
             telegram_chat_id=EXCLUDED.telegram_chat_id,vault_address=EXCLUDED.vault_address,enabled=true,updated_at=now()
           RETURNING wallet_address`, [normalized, vault]
        );
        if (!linked.rowCount) {
          await client.query("ROLLBACK");
          return response.status(409).json({ error: "Link your Telegram account before enabling settlement notifications" });
        }
      } else {
        await client.query(
          "UPDATE public.telegram_vault_subscriptions SET enabled=false,updated_at=now() WHERE wallet_address=$1",
          [normalized]
        );
      }
      await client.query("COMMIT");
      response.json({ enabled, message: enabled ? "Goldlake settlement notifications enabled" : "Goldlake settlement notifications disabled" });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });

  return router;
}

export async function linkTelegramChat(
  database: Pool, config: AppConfig,
  message: { token: string; chatId: string; username: string | null }
): Promise<boolean> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const code = await client.query<{ wallet_address: string }>(
      `UPDATE public.liquidation_telegram_link_codes SET linked_at=now(),telegram_chat_id=$2,telegram_username=$3
       WHERE token_hash=$1 AND expires_at>now() AND linked_at IS NULL RETURNING wallet_address`,
      [digest(message.token), message.chatId, message.username]
    );
    const row = code.rows[0];
    if (!row) { await client.query("ROLLBACK"); return false; }
    await client.query(
      `INSERT INTO public.liquidation_telegram_links(wallet_address,telegram_chat_id,telegram_username,enabled,linked_at,updated_at)
       VALUES($1,$2,$3,true,now(),now())
       ON CONFLICT(wallet_address) DO UPDATE SET telegram_chat_id=EXCLUDED.telegram_chat_id,
         telegram_username=EXCLUDED.telegram_username,enabled=true,linked_at=now(),updated_at=now()`,
      [row.wallet_address, message.chatId, message.username]
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function sendTelegramLiquidationNotice(
  database: Pool, config: AppConfig,
  event: { eventKey: string; version: string; trader: string; market: string; price: string; transactionHash: string }
): Promise<void> {
  if (!config.TELEGRAM_BOT_TOKEN) return;
  const links = await database.query<{ telegram_chat_id: string }>(
    "SELECT telegram_chat_id FROM public.liquidation_telegram_links WHERE wallet_address=$1 AND enabled=true",
    [event.trader.toLowerCase()]
  );
  const price = event.price.replace(/[^0-9,.]/g, "");
  const market = event.market.replace(/[^A-Za-z0-9.-]/g, "");
  const txUrl = `https://robinhoodchain.blockscout.com/tx/${encodeURIComponent(event.transactionHash)}`;
  for (const { telegram_chat_id: chatId } of links.rows) {
    const delivered = await database.query(
      "SELECT 1 FROM public.liquidation_alert_deliveries WHERE event_key=$1 AND channel='telegram' AND recipient_key=$2",
      [event.eventKey, chatId]
    );
    if (delivered.rowCount) continue;
    await telegramRequest(config, "sendMessage", {
      chat_id: chatId,
      text: `FloatSheets liquidation alert\n${market} position liquidated on ${event.version}.\nOracle execution price: ${price} USDG.\n${txUrl}`
    });
    await database.query(
      "INSERT INTO public.liquidation_alert_deliveries(event_key,channel,recipient_key) VALUES($1,'telegram',$2) ON CONFLICT DO NOTHING",
      [event.eventKey, chatId]
    );
  }
}
