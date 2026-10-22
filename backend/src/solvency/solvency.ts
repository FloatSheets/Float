import type { Pool } from "pg";
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";

import { marketId } from "../chain/protocol";
import type { RpcTransport } from "../chain/rpc";

const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const vaultAbi = parseAbi([
  "function totalAssets() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function insuranceAssets() view returns (uint256)",
  "function totalPayoutOwed() view returns (uint256)",
  "function totalWithdrawalOwed() view returns (uint256)",
  "function pendingDepositAssets() view returns (uint256)"
]);
const clearingAbi = parseAbi([
  "function availableLiquidity() view returns (uint256)",
  "function unrealizedPnlUsdg() view returns (int256)",
  "function totalOpenPositionMarginUsdg() view returns (uint256)",
  "function badDebtUsdg() view returns (uint256)",
  "function activePositionCount() view returns (uint256)",
  "function marketCount() view returns (uint256)",
  "function marketIdAt(uint256) view returns (bytes32)",
  "function marketExposure(bytes32) view returns (uint256,uint256)"
]);
const oracleAbi = parseAbi(["function getPrice(bytes32) view returns (uint256,uint256,uint256,uint256,uint64,uint64,bool)"]);

/** FloatClearingHouse risk constants (basis points of vault NAV). */
const BPS = 10_000n;
const GLOBAL_UTILIZATION_BPS = 5_000n;
const MARKET_OPEN_INTEREST_BPS = 1_500n;
const MARKET_SKEW_BPS = 1_000n;
const MARKET_STRESS_MOVE_BPS = 2_500n;
const E18 = 10n ** 18n;
const E12 = 10n ** 12n;
const CACHE_MS = 15_000;

export type SolvencyAddresses = { usdg: Address; vault: Address; clearingHouse: Address; oracle: Address };

function usdg(units: bigint): string {
  const negative = units < 0n;
  const value = negative ? -units : units;
  return `${negative ? "-" : ""}${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, "0")}`;
}

function pct(numerator: bigint, denominator: bigint): number | null {
  if (denominator <= 0n) return null;
  return Number(numerator * 1_000_000n / denominator) / 10_000;
}

/**
 * A public, on-chain proof of FloatSheets' financial position. Every number is
 * read live from the vault, clearing house, oracle and USDG contracts, so
 * anyone can reproduce it from a block explorer.
 */
export class SolvencyReader {
  private cached: { at: number; value: Awaited<ReturnType<SolvencyReader["read"]>> } | null = null;

  constructor(private readonly database: Pool, private readonly rpc: RpcTransport, private readonly addresses: SolvencyAddresses) {}

  private async call<const A extends readonly unknown[]>(to: Address, abi: A, functionName: string, args: readonly unknown[] = []): Promise<any> {
    const data = encodeFunctionData({ abi: abi as any, functionName, args } as any);
    const result = await this.rpc.call({ to, data });
    return decodeFunctionResult({ abi: abi as any, functionName, data: result } as any);
  }

  async report() {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.value;
    const value = await this.read();
    this.cached = { at: Date.now(), value };
    return value;
  }

  private async read() {
    const { usdg: token, vault, clearingHouse, oracle } = this.addresses;
    const [
      vaultCash, nav, shares, insurance, payoutOwed, withdrawalOwed, pendingDeposits,
      clearingCash, available, traderPnl, openMargin, badDebt, positions, marketCount
    ] = await Promise.all([
      this.call(token, erc20Abi, "balanceOf", [vault]) as Promise<bigint>,
      this.call(vault, vaultAbi, "totalAssets") as Promise<bigint>,
      this.call(vault, vaultAbi, "totalShares") as Promise<bigint>,
      this.call(vault, vaultAbi, "insuranceAssets") as Promise<bigint>,
      this.call(vault, vaultAbi, "totalPayoutOwed") as Promise<bigint>,
      this.call(vault, vaultAbi, "totalWithdrawalOwed") as Promise<bigint>,
      this.call(vault, vaultAbi, "pendingDepositAssets") as Promise<bigint>,
      this.call(token, erc20Abi, "balanceOf", [clearingHouse]) as Promise<bigint>,
      this.call(clearingHouse, clearingAbi, "availableLiquidity") as Promise<bigint>,
      this.call(clearingHouse, clearingAbi, "unrealizedPnlUsdg") as Promise<bigint>,
      this.call(clearingHouse, clearingAbi, "totalOpenPositionMarginUsdg") as Promise<bigint>,
      this.call(clearingHouse, clearingAbi, "badDebtUsdg") as Promise<bigint>,
      this.call(clearingHouse, clearingAbi, "activePositionCount") as Promise<bigint>,
      this.call(clearingHouse, clearingAbi, "marketCount") as Promise<bigint>
    ]);

    const { rows } = await this.database.query<{ symbol: string }>("SELECT symbol FROM public.markets");
    const symbols = new Map(rows.map((row) => [marketId(row.symbol).toLowerCase(), row.symbol]));
    const ids = await Promise.all(Array.from({ length: Number(marketCount) }, (_, index) =>
      this.call(clearingHouse, clearingAbi, "marketIdAt", [BigInt(index)]) as Promise<Hex>));
    const markets = await Promise.all(ids.map(async (id) => {
      const [[longBase, shortBase], price] = await Promise.all([
        this.call(clearingHouse, clearingAbi, "marketExposure", [id]) as Promise<[bigint, bigint]>,
        this.call(oracle, oracleAbi, "getPrice", [id]) as Promise<[bigint, bigint, bigint, bigint, bigint, bigint, boolean]>
      ]);
      const priceE18 = price[0];
      const longOi = longBase * priceE18 / E18 / E12;
      const shortOi = shortBase * priceE18 / E18 / E12;
      const skew = longOi > shortOi ? longOi - shortOi : shortOi - longOi;
      return {
        market: symbols.get(id.toLowerCase()) ?? id,
        price_usdg: usdg(priceE18 / E12),
        long_open_interest_usdg: usdg(longOi),
        short_open_interest_usdg: usdg(shortOi),
        skew_usdg: usdg(skew),
        net_side: longOi === shortOi ? null : longOi > shortOi ? "long" : "short",
        open_interest_cap_used_pct: pct(longOi + shortOi, nav * MARKET_OPEN_INTEREST_BPS / BPS),
        skew_cap_used_pct: pct(skew, nav * MARKET_SKEW_BPS / BPS),
        oracle_circuit_broken: price[6],
        _oi: longOi + shortOi,
        _stress: skew * MARKET_STRESS_MOVE_BPS / BPS
      };
    }));

    const openInterest = markets.reduce((sum, item) => sum + item._oi, 0n);
    const stressLoss = markets.reduce((sum, item) => sum + item._stress, 0n);
    // LP cash after senior claims, as FloatVault.totalAssets computes it. The
    // insurance tranche is held in the same balance and counted separately.
    const seniorClaims = payoutOwed + withdrawalOwed + pendingDeposits + insurance;
    const freeCash = vaultCash > seniorClaims ? vaultCash - seniorClaims : 0n;
    const traderProfit = traderPnl > 0n ? traderPnl : 0n;

    return {
      generated_at: new Date().toISOString(),
      contracts: { usdg: token, vault, clearing_house: clearingHouse, oracle },
      vault: {
        cash_usdg: usdg(vaultCash),
        nav_usdg: usdg(nav),
        total_shares: shares.toString(),
        insurance_usdg: usdg(insurance),
        payouts_owed_usdg: usdg(payoutOwed),
        withdrawals_owed_usdg: usdg(withdrawalOwed),
        pending_deposits_usdg: usdg(pendingDeposits),
        free_cash_usdg: usdg(freeCash),
        available_liquidity_usdg: usdg(available)
      },
      traders: {
        open_positions: Number(positions),
        margin_owed_usdg: usdg(openMargin),
        margin_held_usdg: usdg(clearingCash),
        margin_fully_backed: clearingCash >= openMargin,
        unrealized_pnl_usdg: usdg(traderPnl),
        bad_debt_usdg: usdg(badDebt)
      },
      risk: {
        open_interest_usdg: usdg(openInterest),
        utilization_pct: pct(openInterest, nav),
        utilization_cap_pct: Number(GLOBAL_UTILIZATION_BPS) / 100,
        market_open_interest_cap_pct: Number(MARKET_OPEN_INTEREST_BPS) / 100,
        market_skew_cap_pct: Number(MARKET_SKEW_BPS) / 100,
        stress_move_pct: Number(MARKET_STRESS_MOVE_BPS) / 100,
        stress_loss_usdg: usdg(stressLoss),
        // Free cash plus insurance against what traders would win in the stress move.
        stress_coverage_ratio: stressLoss === 0n ? null : Number((freeCash + insurance) * 1_000n / stressLoss) / 1_000,
        current_trader_profit_coverage_ratio: traderProfit === 0n ? null : Number((freeCash + insurance) * 1_000n / traderProfit) / 1_000
      },
      markets: markets.map(({ _oi, _stress, ...item }) => item)
    };
  }
}
