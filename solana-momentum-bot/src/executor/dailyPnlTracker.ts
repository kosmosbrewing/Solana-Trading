import { Pool } from 'pg';
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('DailyPnlTracker');

export interface DailyLimitConfig {
  /** Wallet name */
  name: string;
  /** Daily loss limit in SOL (Infinity = no wallet-level limit) */
  dailyLossLimitSol: number;
}

/**
 * M-13: 일일 PnL 추적 — WalletManager에서 분리.
 *
 * 지갑별 일일 손실 한도 관리:
 *   - 인메모리 PnL 추적 + DB 영속화
 *   - UTC 자정 자동 리셋
 *   - RiskManager의 포트폴리오 수준 daily loss와 독립
 */
export class DailyPnlTracker {
  private dailyPnl = new Map<string, number>();
  private limits = new Map<string, number>();
  private lastResetDate: string;
  private dbPool?: Pool;

  constructor(configs: DailyLimitConfig[], dbPool?: Pool) {
    this.dbPool = dbPool;
    this.lastResetDate = new Date().toISOString().slice(0, 10);
    for (const c of configs) {
      this.limits.set(c.name, c.dailyLossLimitSol);
    }
  }

  /** DB 테이블 초기화 + 오늘 일일 PnL 로드 */
  async initialize(): Promise<void> {
    if (!this.dbPool) return;
    try {
      await this.dbPool.query(`
        CREATE TABLE IF NOT EXISTS wallet_daily_pnl (
          wallet_name TEXT NOT NULL,
          trade_date DATE NOT NULL,
          pnl_sol DOUBLE PRECISION NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (wallet_name, trade_date)
        )
      `);
      const today = new Date().toISOString().slice(0, 10);
      const result = await this.dbPool.query<{ wallet_name: string; pnl_sol: number }>(
        `SELECT wallet_name, pnl_sol FROM wallet_daily_pnl WHERE trade_date = $1`,
        [today]
      );
      for (const row of result.rows) {
        this.dailyPnl.set(row.wallet_name, row.pnl_sol);
      }
      log.info(`Daily PnL loaded from DB: ${result.rows.length} entries for ${today}`);
    } catch (err) {
      log.warn(`Failed to init daily PnL store: ${err}. Using in-memory only.`);
    }
  }

  /** PnL 기록 */
  recordPnl(walletName: string, pnlSol: number): void {
    this.maybeResetDaily();
    const current = this.dailyPnl.get(walletName) ?? 0;
    const updated = current + pnlSol;
    this.dailyPnl.set(walletName, updated);
    this.persistDailyPnl(walletName, updated);
  }

  /** 일일 손실 한도 도달 여부 */
  isDailyLimitHit(walletName: string): boolean {
    this.maybeResetDaily();
    const limit = this.limits.get(walletName);
    if (limit === undefined) return true;
    if (!Number.isFinite(limit)) return false; // Infinity = no wallet-level limit

    const pnl = this.dailyPnl.get(walletName) ?? 0;
    if (pnl <= -limit) {
      log.warn(`${walletName} daily loss limit hit: ${pnl.toFixed(4)} SOL (limit: -${limit} SOL)`);
      return true;
    }
    return false;
  }

  /** 일일 PnL 조회 */
  getDailyPnl(walletName: string): number {
    this.maybeResetDaily();
    return this.dailyPnl.get(walletName) ?? 0;
  }

  /** DB에 일일 PnL 비동기 영속화 */
  private persistDailyPnl(walletName: string, totalPnl: number): void {
    if (!this.dbPool) return;
    const today = new Date().toISOString().slice(0, 10);
    this.dbPool.query(
      `INSERT INTO wallet_daily_pnl (wallet_name, trade_date, pnl_sol, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (wallet_name, trade_date)
       DO UPDATE SET pnl_sol = $3, updated_at = NOW()`,
      [walletName, today, totalPnl]
    ).catch(err => log.warn(`Failed to persist daily PnL: ${err}`));
  }

  /** UTC 자정 리셋 */
  private maybeResetDaily(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastResetDate) {
      this.dailyPnl.clear();
      this.lastResetDate = today;
      log.info('Daily PnL counters reset');
    }
  }
}
