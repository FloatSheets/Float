import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../config";
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

  constructor(private readonly database: Pool, private readonly config: AppConfig) {}

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
    if (!chatId || !text.startsWith("/start")) return;
    const args = text.split(/\s+/, 2);
    const token = args[1];
    if (message?.chat?.type !== "private") {
      await telegramRequest(this.config, "sendMessage", { chat_id: chatId, text: "For security, link your Telegram account in a private chat with this bot." });
      return;
    }
    if (!token || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) {
      await telegramRequest(this.config, "sendMessage", { chat_id: chatId, text: "To enable FloatSheets liquidation alerts, connect your wallet and use the Link Telegram button in dashboard Settings." });
      return;
    }
    const user = message?.from;
    const username = user?.username ? `@${user.username}` : [user?.first_name, user?.last_name].filter(Boolean).join(" ") || null;
    try {
      const linked = await linkTelegramChat(this.database, this.config, { token, chatId: String(chatId), username });
      await telegramRequest(this.config, "sendMessage", {
        chat_id: chatId,
        text: linked
          ? "Your Telegram account is linked to your FloatSheets wallet. Liquidation alerts are enabled. You can change this in dashboard Settings."
          : "That link is invalid or expired. Start a new Telegram link from FloatSheets dashboard Settings."
      });
    } catch (error) {
      console.error(JSON.stringify({ event: "telegram_account_link_failed", error: error instanceof Error ? error.message : "unknown" }));
      await telegramRequest(this.config, "sendMessage", { chat_id: chatId, text: "Could not link this Telegram account. Start a new link from FloatSheets dashboard Settings." });
    }
  }
}
