import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import { formatUnits, recoverMessageAddress } from "viem";
import type { AppConfig } from "../config";
import { sendTelegramLiquidationNotice } from "./telegram-alerts";

const walletPattern = /^0x[a-fA-F0-9]{40}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

async function sendEmail(config: AppConfig, to: string, subject: string, html: string, idempotencyKey?: string): Promise<void> {
  if (!config.RESEND_API_KEY) throw new Error("Email delivery is not configured");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.RESEND_API_KEY}`,
      "content-type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {})
    },
    body: JSON.stringify({ from: `FloatSheets Alerts <${config.RESEND_FROM_EMAIL}>`, to: [to], subject, html })
  });
  if (!response.ok) throw new Error(`Resend rejected email (${response.status})`);
}

export function createEmailAlertsRouter(database: Pool, config: AppConfig): Router {
  const router = Router();
  router.post("/challenge", async (request, response) => {
    const wallet = request.body?.wallet;
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const enabled = request.body?.enabled;
    if (typeof wallet !== "string" || !walletPattern.test(wallet)) return response.status(400).json({ error: "A valid wallet is required" });
    if (typeof enabled !== "boolean" || (enabled && !emailPattern.test(email)) || (!enabled && email && !emailPattern.test(email))) return response.status(400).json({ error: "Valid email alert settings are required" });
    const normalized = wallet.toLowerCase();
    const nonce = randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const message = [
      "FloatSheets liquidation email alerts",
      `Wallet: ${normalized}`,
      `Action: ${enabled ? "enable" : "disable"}`,
      `Email: ${email}`,
      `Nonce: ${nonce}`,
      `Expires: ${expiresAt.toISOString()}`,
      "This signature authorizes only email-alert settings for this wallet."
    ].join("\n");
    await database.query(
      `INSERT INTO public.liquidation_email_challenges(wallet_address,message,expires_at) VALUES($1,$2,$3)
       ON CONFLICT(wallet_address) DO UPDATE SET message=EXCLUDED.message, expires_at=EXCLUDED.expires_at`,
      [normalized, message, expiresAt]
    );
    response.json({ message });
  });

  router.post("/settings", async (request, response) => {
    const wallet = request.body?.wallet;
    const signature = request.body?.signature;
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const enabled = request.body?.enabled;
    if (typeof wallet !== "string" || !walletPattern.test(wallet) || typeof signature !== "string" || !/^0x[a-fA-F0-9]{130}$/.test(signature)
      || typeof enabled !== "boolean" || (enabled && !emailPattern.test(email))) {
      return response.status(400).json({ error: "Valid signed settings are required" });
    }
    const normalized = wallet.toLowerCase();
    const challenge = await database.query<{ message: string; expires_at: Date }>(
      "SELECT message,expires_at FROM public.liquidation_email_challenges WHERE wallet_address=$1", [normalized]
    );
    const row = challenge.rows[0];
    if (!row || new Date(row.expires_at).getTime() <= Date.now()) return response.status(401).json({ error: "Wallet authorization expired; try again" });
    if (!row.message.includes(`Action: ${enabled ? "enable" : "disable"}\nEmail: ${email}\n`)) return response.status(401).json({ error: "Signed email settings do not match this request" });
    let recovered: string;
    try { recovered = await recoverMessageAddress({ message: row.message, signature: signature as `0x${string}` }); }
    catch { return response.status(401).json({ error: "Wallet signature is invalid" }); }
    if (recovered.toLowerCase() !== normalized) return response.status(401).json({ error: "Wallet signature does not match" });
    await database.query("DELETE FROM public.liquidation_email_challenges WHERE wallet_address=$1", [normalized]);

    if (!enabled) {
      if (!email) {
        await database.query("DELETE FROM public.liquidation_email_preferences WHERE wallet_address=$1", [normalized]);
        return response.json({ enabled: false, message: "Email address and alert settings removed" });
      }
      await database.query("UPDATE public.liquidation_email_preferences SET enabled=false,updated_at=now() WHERE wallet_address=$1", [normalized]);
      return response.json({ enabled: false, message: "Email alerts disabled" });
    }
    if (!config.RESEND_API_KEY) return response.status(503).json({ error: "Email alerts are temporarily unavailable" });
    const existing = await database.query<{ email: string; verified_at: Date | null }>(
      "SELECT email,verified_at FROM public.liquidation_email_preferences WHERE wallet_address=$1", [normalized]
    );
    if (existing.rows[0]?.email === email && existing.rows[0]?.verified_at) {
      await database.query("UPDATE public.liquidation_email_preferences SET enabled=true,updated_at=now() WHERE wallet_address=$1", [normalized]);
      return response.json({ enabled: true, verified: true, message: "Liquidation email alerts enabled" });
    }
    const token = randomBytes(32).toString("base64url");
    await database.query(
      `INSERT INTO public.liquidation_email_preferences(wallet_address,email,enabled,verified_at,verification_token_hash,verification_expires_at,updated_at)
       VALUES($1,$2,false,NULL,$3,now()+interval '30 minutes',now())
       ON CONFLICT(wallet_address) DO UPDATE SET email=EXCLUDED.email,enabled=false,verified_at=NULL,
         verification_token_hash=EXCLUDED.verification_token_hash,verification_expires_at=EXCLUDED.verification_expires_at,updated_at=now()`,
      [normalized, email, digest(token)]
    );
    const link = `${config.FRONTEND_URL.replace(/\/$/, "")}/dashboard/?liquidationEmailToken=${encodeURIComponent(token)}#settings`;
    try {
      await sendEmail(config, email, "Verify your FloatSheets liquidation alerts",
        `<p>Confirm this email address to receive FloatSheets liquidation alerts for wallet <code>${normalized}</code>.</p><p><a href="${link}">Verify email address</a></p><p>This link expires in 30 minutes. If you did not request this, ignore this email.</p>`);
    } catch (error) {
      await database.query("UPDATE public.liquidation_email_preferences SET enabled=false,verification_token_hash=NULL WHERE wallet_address=$1", [normalized]);
      console.error(JSON.stringify({ event: "liquidation_email_verification_send_failed", wallet: normalized, error: error instanceof Error ? error.message : "unknown" }));
      return response.status(502).json({ error: "Could not send the verification email" });
    }
    response.json({ enabled: false, verified: false, message: "Check your inbox to verify this email address" });
  });

  router.post("/verify", async (request, response) => {
    const token = request.body?.token;
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return response.status(400).json({ error: "Invalid verification link" });
    const hash = digest(token);
    const result = await database.query<{ wallet_address: string; email: string }>(
      `UPDATE public.liquidation_email_preferences SET enabled=true,verified_at=now(),verification_token_hash=NULL,
       verification_expires_at=NULL,updated_at=now()
       WHERE verification_token_hash=$1 AND verification_expires_at>now() RETURNING wallet_address,email`, [hash]
    );
    if (!result.rowCount) return response.status(400).json({ error: "This verification link is invalid or expired" });
    response.json({ verified: true, enabled: true, wallet: result.rows[0]!.wallet_address, email: result.rows[0]!.email, message: "Email verified. Liquidation alerts are enabled." });
  });

  return router;
}

export async function sendLiquidationNotice(
  database: Pool, config: AppConfig,
  event: { eventKey: string; version: string; trader: string; market: string; priceE18: string; transactionHash: string }
): Promise<void> {
  if (config.RESEND_API_KEY) {
    const pending = await database.query<{ email: string }>(
      "SELECT email FROM public.liquidation_email_preferences WHERE wallet_address=$1 AND enabled=true AND verified_at IS NOT NULL",
      [event.trader.toLowerCase()]
    );
    const [whole = "0", fraction = ""] = formatUnits(BigInt(event.priceE18), 18).split(".");
    const decimals = fraction.slice(0, 4).replace(/0+$/, "");
    const price = `${BigInt(whole).toLocaleString("en-US")}${decimals ? `.${decimals}` : ""}`;
    const safeMarket = event.market.replace(/[^A-Za-z0-9.-]/g, "");
    const txUrl = `https://robinhoodchain.blockscout.com/tx/${encodeURIComponent(event.transactionHash)}`;
    for (const { email } of pending.rows) {
      const recipientKey = digest(email).slice(0, 32);
      const delivered = await database.query(
        "SELECT 1 FROM public.liquidation_alert_deliveries WHERE event_key=$1 AND channel='email' AND recipient_key=$2",
        [event.eventKey, recipientKey]
      );
      if (delivered.rowCount) continue;
      await sendEmail(config, email, `FloatSheets: ${safeMarket} position liquidated`,
        `<p>A position in <strong>${safeMarket}</strong> for wallet <code>${event.trader}</code> was liquidated on FloatSheets ${event.version}.</p><p>Oracle execution price: ${price} USDG.</p><p><a href="${txUrl}">View transaction</a></p><p>Manage email alerts in FloatSheets dashboard settings.</p>`,
        `liquidation-${event.eventKey}-${recipientKey.slice(0, 16)}`);
      await database.query(
        "INSERT INTO public.liquidation_alert_deliveries(event_key,channel,recipient_key) VALUES($1,'email',$2) ON CONFLICT DO NOTHING",
        [event.eventKey, recipientKey]
      );
    }
  }
  const [whole = "0", fraction = ""] = formatUnits(BigInt(event.priceE18), 18).split(".");
  const decimals = fraction.slice(0, 4).replace(/0+$/, "");
  const price = `${BigInt(whole).toLocaleString("en-US")}${decimals ? `.${decimals}` : ""}`;
  await sendTelegramLiquidationNotice(database, config, {
    eventKey: event.eventKey, version: event.version, trader: event.trader,
    market: event.market, price, transactionHash: event.transactionHash
  });
}
