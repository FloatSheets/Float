import type { Pool, PoolClient } from 'pg';
import type { Address } from 'viem';
import { contractConfigForVersion, type AppConfig } from '../config';
import type { RpcTransport } from '../chain/rpc';
import { telegramRequest } from '../routes/telegram-alerts';
import { readVault, readVaultRequest, vaultRequestText } from './telegram-vault';

export async function setSettlementSubscription(database: Pool, config: AppConfig, chatId: string, enabled: boolean): Promise<string> {
  if (!enabled) {
    await database.query('UPDATE public.telegram_vault_subscriptions SET enabled=false, updated_at=now() WHERE telegram_chat_id=$1', [chatId]);
    return 'Goldlake settlement notifications disabled. Liquidation alert preferences are unchanged.';
  }
  const vault = contractConfigForVersion(config, 'goldlake').FLOAT_VAULT_ADDRESS!.toLowerCase();
  const result = await database.query(`
    INSERT INTO public.telegram_vault_subscriptions (wallet_address, telegram_chat_id, vault_address)
    SELECT wallet_address, telegram_chat_id, $2 FROM public.liquidation_telegram_links WHERE telegram_chat_id=$1
    ON CONFLICT (wallet_address) DO UPDATE SET
      next_epoch=CASE WHEN telegram_vault_subscriptions.telegram_chat_id <> EXCLUDED.telegram_chat_id
        OR telegram_vault_subscriptions.vault_address <> EXCLUDED.vault_address THEN 0 ELSE telegram_vault_subscriptions.next_epoch END,
      telegram_chat_id=EXCLUDED.telegram_chat_id, vault_address=EXCLUDED.vault_address, enabled=true, updated_at=now()
    RETURNING wallet_address`, [chatId, vault]);
  return result.rows.length
    ? 'Goldlake settlement notifications enabled for your linked wallets. We also check older epochs for unclaimed requests. You still claim in the dashboard. Use /settlements off to stop.'
    : 'Link your wallet in Dashboard → Settings → Telegram first, then use /settlements on.';
}

/** Persistent per-wallet cursor; only advance after a settled epoch is handled.
 * Delivery is at-least-once: a crash after Telegram accepts a message but before
 * the DB records it can cause a duplicate, but cannot silently skip the epoch.
 */
export class TelegramSettlementService {
  private running = false;
  constructor(private readonly database: Pool, private readonly config: AppConfig, private readonly rpc: RpcTransport) {}

  async pollOnce(): Promise<void> {
    if (this.running || !this.config.TELEGRAM_BOT_TOKEN) return;
    let vault: Address;
    try { vault = contractConfigForVersion(this.config, 'goldlake').FLOAT_VAULT_ADDRESS as Address; } catch { return; }
    this.running = true;
    let client: PoolClient | undefined;
    let locked = false;
    let broken = false;
    const lockName = 'floatsheets:telegram-goldlake-settlements';
    try {
      client = await this.database.connect();
      locked = (await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [lockName])).rows[0]?.locked === true;
      if (!locked) return;
      // A relink invalidates the former chat's subscription automatically.
      const { rows } = await client.query<{ wallet_address: Address; telegram_chat_id: string; next_epoch: string }>(`
        SELECT s.wallet_address, s.telegram_chat_id, s.next_epoch
        FROM public.telegram_vault_subscriptions s
        JOIN public.liquidation_telegram_links l ON l.wallet_address=s.wallet_address AND l.telegram_chat_id=s.telegram_chat_id
        WHERE s.enabled=true AND s.vault_address=$1 ORDER BY s.wallet_address`, [vault.toLowerCase()]);
      if (!rows.length) return;
      const current = await readVault(this.rpc, vault, 'queueEpoch') as bigint;
      for (const row of rows) {
        try {
          const first = BigInt(row.next_epoch);
          // Bound work per wallet; subsequent polls resume without dropping history.
          for (let epoch = first; epoch <= current && epoch < first + 10n; epoch++) {
            const request = await readVaultRequest(this.rpc, vault, row.wallet_address, epoch);
            if (!request.settled) break;
            const lines = vaultRequestText(request);
            const key = [row.wallet_address, row.telegram_chat_id, vault.toLowerCase(), epoch.toString()];
            const sent = await client.query(`SELECT 1 FROM public.telegram_vault_deliveries
              WHERE wallet_address=$1 AND telegram_chat_id=$2 AND vault_address=$3 AND epoch=$4`, key);
            if (lines.length && !sent.rows.length) {
              // Recheck consent and ownership immediately before external delivery.
              const active = await client.query(`SELECT 1 FROM public.telegram_vault_subscriptions s
                JOIN public.liquidation_telegram_links l ON l.wallet_address=s.wallet_address AND l.telegram_chat_id=s.telegram_chat_id
                WHERE s.wallet_address=$1 AND s.telegram_chat_id=$2 AND s.enabled=true AND s.vault_address=$3`, key.slice(0,3));
              if (!active.rows.length) break;
              await telegramRequest(this.config, 'sendMessage', {
                chat_id: row.telegram_chat_id,
                text: `FloatSheets Goldlake settlement\nWallet ${row.wallet_address.slice(0,6)}…${row.wallet_address.slice(-4)}\n${lines.join('\n')}\n\nNo funds were automatically transferred. Open the vault and select Goldlake in Settings to claim or manage your request. Claims remain subject to contract checks.\n/settlements off to disable these notifications.`,
                reply_markup: { inline_keyboard: [[{ text: 'Open Vault', url: new URL('/dashboard/#vault', this.config.FRONTEND_URL).href }]] }
              });
              await client.query(`INSERT INTO public.telegram_vault_deliveries (wallet_address,telegram_chat_id,vault_address,epoch)
                VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, key);
            }
            await client.query(`UPDATE public.telegram_vault_subscriptions SET next_epoch=$4, updated_at=now()
              WHERE wallet_address=$1 AND telegram_chat_id=$2 AND vault_address=$3`, [...key.slice(0,3), (epoch + 1n).toString()]);
          }
        } catch (error) {
          console.error(JSON.stringify({ event: 'telegram_settlement_wallet_failed', error: error instanceof Error ? error.message : 'unknown' }));
        }
      }
    } catch (error) {
      console.error(JSON.stringify({ event: 'telegram_settlement_poll_failed', error: error instanceof Error ? error.message : 'unknown' }));
    } finally {
      if (locked && client) {
        try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]); } catch { broken = true; }
      }
      client?.release(broken);
      this.running = false;
    }
  }
}
