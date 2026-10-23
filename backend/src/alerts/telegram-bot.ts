import type { Pool, PoolClient } from "pg";
import { contractVersionSchema, type AppConfig } from "../config";
import type { RpcTransport } from "../chain/rpc";
import { telegramPositionReports } from "./telegram-positions";
import { linkTelegramChat, telegramRequest } from "../routes/telegram-alerts";

type TelegramUpdate = {
  update_id: number;
  message?: {
    text?: string;
    chat?: { id?: number; type?: string };
    from?: { username?: string; first_name?: string; last_name?: string };
  };
};

export class TelegramBotService {
  private polling = false;
  private readonly positionRequests = new Map<string, number>();

  constructor(private readonly database: Pool, private readonly config: AppConfig, private readonly rpc: RpcTransport) {}

  async pollOnce(): Promise<void> {
    if (!this.config.TELEGRAM_BOT_TOKEN || this.polling) return;
    this.polling = true;
    let lockClient: PoolClient | undefined;
    let hasLock = false;
    try {
      lockClient = await this.database.connect();
      const lock = await lockClient.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS locked", ["floatsheets:telegram-bot-poller"]
      );
      hasLock = lock.rows[0]?.locked === true;
      if (!hasLock) return;
      const state = await lockClient.query<{ next_update_id: string }>(
        "SELECT next_update_id FROM public.telegram_bot_state WHERE singleton=true"
      );
      const offset = Number(state.rows[0]?.next_update_id ?? 0);
      const updates = await telegramRequest<TelegramUpdate[]>(this.config, "getUpdates", {
        offset,
        timeout: 0,
        allowed_updates: ["message"]
      });
      for (const update of updates) {
        await this.handleUpdate(update);
        await lockClient.query(
          "UPDATE public.telegram_bot_state SET next_update_id=$1 WHERE singleton=true",
          [update.update_id + 1]
        );
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "telegram_bot_poll_failed", error: error instanceof Error ? error.message : "unknown" }));
    } finally {
      if (hasLock && lockClient) {
        try { await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", ["floatsheets:telegram-bot-poller"]); }
        catch { /* Closing the connection releases the session-level lock. */ }
      }
      lockClient?.release();
      this.polling = false;
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const chatId = message?.chat?.id;
    const text = message?.text?.trim() ?? "";
    if (!chatId || !text.startsWith('/')) return;
    const command = text.split(/\s+/, 1)[0]!.split('@')[0]!.toLowerCase();
    if (!['/start', '/help', '/positions', '/trades'].includes(command)) return;
    const args = text.split(/\s+/, 2);
    const token = args[1];
    if (message?.chat?.type !== "private") {
      await telegramRequest(this.config, "sendMessage", { chat_id: chatId, text: "For security, link your Telegram account in a private chat with this bot." });
      return;
    }
    if (command === '/positions' || command === '/trades') {
      const version = token ? contractVersionSchema.safeParse(token.toLowerCase()) : null;
      if (version && !version.success) {
        await telegramRequest(this.config, 'sendMessage', { chat_id: chatId, text: 'Use /positions or /positions <version>. Versions: ' + contractVersionSchema.options.join(', ') });
        return;
      }
      const key = String(chatId), now = Date.now();
      if (now - (this.positionRequests.get(key) ?? 0) < 30_000) {
        await telegramRequest(this.config, 'sendMessage', { chat_id: chatId, text: 'Please wait 30 seconds between position lookups.' });
        return;
      }
      for (const [id, at] of this.positionRequests) if (now - at >= 30_000) this.positionRequests.delete(id);
      this.positionRequests.set(key, now);
      try {
        const reports = await telegramPositionReports(this.database, this.config, this.rpc, key, version?.success ? version.data : undefined);
        let batch = '';
        for (const report of reports) {
          if (batch.length + report.length > 3500) { await telegramRequest(this.config, 'sendMessage', { chat_id: chatId, text: batch }); batch = ''; }
          batch += (batch ? '\n\n' : '') + report;
        }
        if (batch) await telegramRequest(this.config, 'sendMessage', { chat_id: chatId, text: batch, reply_markup: { inline_keyboard: [[{ text: 'Open Portfolio', url: new URL('/dashboard/#portfolio', this.config.FRONTEND_URL).href }]] } });
      } catch {
        await telegramRequest(this.config, 'sendMessage', { chat_id: chatId, text: 'Could not load positions right now. Please try again shortly.' });
      }
      return;
    }
    if (command === '/help' || !token || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) {
      await telegramRequest(this.config, "sendMessage", { chat_id: chatId, text: "FloatSheets commands:\n/positions or /trades — your open positions across deployments\n/positions jaguar — filter by version\n/help — show commands\n\nConnect your wallet and use Link Telegram in dashboard Settings first. Commands work in private chat only." });
      return;
    }
    const user = message?.from;
    const username = user?.username ? `@${user.username}` : [user?.first_name, user?.last_name].filter(Boolean).join(" ") || null;
    try {
      const linked = await linkTelegramChat(this.database, this.config, { token, chatId: String(chatId), username });
      await telegramRequest(this.config, "sendMessage", {
        chat_id: chatId,
        text: linked
          ? "Your Telegram account is linked to your FloatSheets wallet. Liquidation alerts are enabled. Use /positions to see your open trades or /help for commands. You can change alerts in dashboard Settings."
          : "That link is invalid or expired. Start a new Telegram link from FloatSheets dashboard Settings."
      });
    } catch (error) {
      console.error(JSON.stringify({ event: "telegram_account_link_failed", error: error instanceof Error ? error.message : "unknown" }));
      await telegramRequest(this.config, "sendMessage", { chat_id: chatId, text: "Could not link this Telegram account. Start a new link from FloatSheets dashboard Settings." });
    }
  }
}
