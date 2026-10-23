import type { Pool } from 'pg';
import { decodeFunctionResult, encodeFunctionData, formatUnits, parseAbi, type Address } from 'viem';
import { contractConfigForVersion, type AppConfig, type ContractVersion } from '../config';
import type { RpcTransport } from '../chain/rpc';

const abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function totalShares() view returns (uint256)',
  'function navPricesFresh() view returns (bool)',
  'function queueEpoch() view returns (uint64)',
  'function queueEpochStartedAt() view returns (uint64)',
  'function QUEUE_EPOCH_DURATION() view returns (uint256)',
  'function queueEpochSettled() view returns (bool)',
  'function queuedDepositOf(uint64,address) view returns (uint256)',
  'function queuedWithdrawalOf(uint64,address) view returns (uint256)',
  'function depositClaimed(uint64,address) view returns (bool)',
  'function withdrawalClaimed(uint64,address) view returns (bool)',
  'function queueSettlements(uint64) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)'
]);
export async function readVault(rpc: RpcTransport, to: Address, functionName: string, args: readonly unknown[] = []): Promise<any> {
  const data = encodeFunctionData({ abi, functionName, args } as any);
  return decodeFunctionResult({ abi, functionName, data: await rpc.call({ to, data }) } as any);
}
export async function readVaultRequest(rpc: RpcTransport, vault: Address, account: Address, epoch: bigint) {
  const read = (name: string, args: readonly unknown[]) => readVault(rpc, vault, name, args);
  const [deposit, withdrawal] = await Promise.all([
    read('queuedDepositOf', [epoch, account]), read('queuedWithdrawalOf', [epoch, account])
  ]) as bigint[];
  const settlement = await read('queueSettlements', [epoch]) as readonly [bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,boolean];
  const [depositDone, withdrawalDone] = await Promise.all([
    deposit ? read('depositClaimed', [epoch, account]) : true,
    withdrawal ? read('withdrawalClaimed', [epoch, account]) : true
  ]);
  return { epoch, deposit: deposit!, withdrawal: withdrawal!, depositDone, withdrawalDone, settled: settlement[8], withdrawalFunded: settlement[4] > 0n };
}
export function vaultRequestText(request: Awaited<ReturnType<typeof readVaultRequest>>): string[] {
  const lines: string[] = [];
  if (request.deposit > 0n && !request.depositDone) lines.push(`Epoch ${request.epoch}: ${formatUnits(request.deposit, 6)} USDG deposit • ${request.settled ? 'LP shares ready to claim' : 'awaiting settlement'}`);
  if (request.withdrawal > 0n && !request.withdrawalDone) lines.push(`Epoch ${request.epoch}: withdrawal • ${!request.settled ? 'awaiting settlement' : request.withdrawalFunded ? 'settled, claim USDG in the dashboard' : 'deferred; cancel and requeue in the vault'}`);
  return lines;
}
export async function telegramVaultReports(database: Pool, config: AppConfig, rpc: RpcTransport, chatId: string, version?: ContractVersion): Promise<string[]> {
  const { rows } = await database.query<{ wallet_address: Address }>(
    'SELECT wallet_address FROM public.liquidation_telegram_links WHERE telegram_chat_id=$1 ORDER BY wallet_address', [chatId]
  );
  if (!rows.length) return ['Link your wallet in Dashboard → Settings → Telegram, then use /vault.'];
  const reports: string[] = [];
  for (const { wallet_address: account } of rows) {
    for (const selected of version ? [version] : ['goldlake', 'jaguar', 'copper'] as const) {
      let deployment: AppConfig;
      try { deployment = contractConfigForVersion(config, selected); } catch { continue; }
      const title = `FloatSheets ${selected} · ${account.slice(0,6)}…${account.slice(-4)}`;
      try {
        const vault = deployment.FLOAT_VAULT_ADDRESS as Address;
        const read = (name: string, args: readonly unknown[] = []) => readVault(rpc, vault, name, args);
        const shares = await read('balanceOf', [account]) as bigint;
        const lines = [title, `LP shares (raw units): ${shares}`];
        try {
          const fresh = await readVault(rpc, deployment.FLOAT_CLEARING_HOUSE_ADDRESS as Address, 'navPricesFresh');
          if (!fresh) throw new Error('stale NAV');
          const [assets, supply] = await Promise.all([read('totalAssets'), read('totalShares')]) as bigint[];
          lines.push(`Estimated share value: ${formatUnits(shares * (assets! + 1n) / (supply! + 1_000_000n), 6)} USDG`);
        } catch { lines.push('Estimated share value unavailable: NAV could not be verified.'); }
        if (selected === 'jaguar' || selected === 'copper' || selected === 'legacy-orion') {
          lines.push('No epoch queue. Withdrawals remain subject to available liquidity and contract checks.');
        } else {
          const [epoch, start, duration, settled] = await Promise.all([read('queueEpoch'), read('queueEpochStartedAt'), read('QUEUE_EPOCH_DURATION'), read('queueEpochSettled')]);
          lines.push(`Current epoch: ${epoch}${settled ? ' (settled)' : ''}`);
          if (!settled) lines.push(`Eligible to settle: ${new Date(Number(start + duration) * 1000).toISOString()} (not a guaranteed payout time)`);
          const first = epoch > 10n ? epoch - 10n : 0n;
          lines.push(`Queue requests checked: epochs ${first}–${epoch}.`);
          for (let i = first; i <= epoch; i++) lines.push(...vaultRequestText(await readVaultRequest(rpc, vault, account, i)));
        }
        lines.push('Read-only snapshot. Use the dashboard for vault actions.');
        reports.push(lines.join('\n'));
      } catch { reports.push(`${title}: vault lookup incomplete. Please retry shortly.`); }
    }
  }
  return reports.length ? reports : ['That vault is not configured.'];
}
