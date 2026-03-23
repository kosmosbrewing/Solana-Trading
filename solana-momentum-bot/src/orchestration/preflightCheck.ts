import { Pool } from 'pg';
import { buildPaperValidationReport, PaperValidationTrade, PaperValidationSignal } from '../reporting/paperValidation';
import { createModuleLogger } from '../utils/logger';
import { TradingMode } from '../utils/config';

const log = createModuleLogger('PreflightCheck');

export interface PreflightConfig {
  tradingMode: TradingMode;
  minTrades: number;
  minWinRate: number;
  minRewardRisk: number;
  /** If true, block live startup when criteria not met (default: true) */
  enforceGate: boolean;
  /** H-13: 실행 비용 보정 — R:R에서 차감할 round-trip cost (spread+fee, default: 0.01 = 1%) */
  estimatedCostPct: number;
}

const DEFAULT_PREFLIGHT: PreflightConfig = {
  tradingMode: 'paper',
  minTrades: 50,
  minWinRate: 0.4,
  minRewardRisk: 2.0,
  enforceGate: true,
  estimatedCostPct: 0.01,
};

export interface PreflightResult {
  passed: boolean;
  tradingMode: TradingMode;
  totalTrades: number;
  winRate: number;
  rewardRisk: number;
  edgeScore?: number;
  edgeDecision?: string;
  reasons: string[];
}

/**
 * Pre-flight check for live trading readiness.
 *
 * Queries closed paper trades + audit signals from DB,
 * runs paper validation report, and gates live mode if criteria not met.
 */
export async function runPreflightCheck(
  dbPool: Pool,
  config: Partial<PreflightConfig> = {}
): Promise<PreflightResult> {
  const cfg = { ...DEFAULT_PREFLIGHT, ...config };

  if (cfg.tradingMode === 'paper') {
    log.info('Paper mode — preflight check skipped');
    return {
      passed: true,
      tradingMode: 'paper',
      totalTrades: 0,
      winRate: 0,
      rewardRisk: 0,
      reasons: ['Paper mode — no gate required'],
    };
  }

  // Query closed trades from DB
  const tradesResult = await dbPool.query<{
    strategy: string;
    pair_address: string;
    entry_price: number;
    stop_loss: number;
    quantity: number;
    pnl: number;
    exit_reason: string;
    closed_at: Date;
  }>(`
    SELECT strategy, pair_address, entry_price, stop_loss, quantity, pnl, exit_reason, closed_at
    FROM trades
    WHERE status = 'CLOSED' AND pnl IS NOT NULL
    ORDER BY closed_at ASC
  `);

  const trades: PaperValidationTrade[] = tradesResult.rows.map(row => ({
    strategy: row.strategy as PaperValidationTrade['strategy'],
    pairAddress: row.pair_address,
    entryPrice: row.entry_price,
    stopLoss: row.stop_loss,
    quantity: row.quantity,
    pnl: row.pnl,
    exitReason: row.exit_reason as PaperValidationTrade['exitReason'],
    closedAt: row.closed_at,
  }));

  // Query audit signals
  const signalsResult = await dbPool.query<{
    strategy: string;
    action: string;
    filter_reason: string | null;
  }>(`
    SELECT strategy, action, filter_reason
    FROM signal_audit_log
    ORDER BY timestamp ASC
  `);

  const signals: PaperValidationSignal[] = signalsResult.rows.map(row => ({
    strategy: row.strategy as PaperValidationSignal['strategy'],
    action: row.action as PaperValidationSignal['action'],
    filterReason: row.filter_reason,
  }));

  const report = buildPaperValidationReport(trades, signals, {
    minTrades: cfg.minTrades,
    minWinRate: cfg.minWinRate,
    minRewardRisk: cfg.minRewardRisk,
  });

  // H-13: risk-adjusted R:R — paper R:R에서 round-trip 실행 비용 차감
  const rawRR = report.rewardRisk;
  const costAdjustedRR = rawRR > 0 ? rawRR - (cfg.estimatedCostPct * 2 * rawRR) : rawRR;
  const rrMet = costAdjustedRR >= cfg.minRewardRisk;

  const reasons: string[] = [];
  if (!report.criteria.minTradesMet) {
    reasons.push(`Trades ${report.totalTrades}/${cfg.minTrades} — insufficient sample`);
  }
  if (!report.criteria.winRateMet) {
    reasons.push(`Win rate ${(report.winRate * 100).toFixed(1)}% < ${(cfg.minWinRate * 100).toFixed(0)}%`);
  }
  if (!rrMet) {
    reasons.push(`Cost-adjusted R:R ${costAdjustedRR.toFixed(2)} < ${cfg.minRewardRisk.toFixed(1)} (raw=${rawRR.toFixed(2)}, cost=${(cfg.estimatedCostPct * 100).toFixed(1)}%)`);
  }

  const passed = report.criteria.minTradesMet && report.criteria.winRateMet && rrMet;

  if (passed) {
    log.info(
      `✅ Pre-flight PASSED: ${report.totalTrades} trades, ` +
      `WR=${(report.winRate * 100).toFixed(1)}%, R:R=${costAdjustedRR.toFixed(2)} (raw=${rawRR.toFixed(2)}), ` +
      `Edge=${report.edgeScore.toFixed(1)} (${report.edgeDecision})`
    );
  } else {
    if (report.edgeGateStatus !== 'pass') {
      reasons.push(`Edge gate ${report.edgeDecision}${report.edgeGateReasons.length > 0 ? ` (${report.edgeGateReasons.join(', ')})` : ''}`);
    }
    const msg = `Pre-flight FAILED for live mode: ${reasons.join(' | ')}`;
    if (cfg.enforceGate) {
      log.error(`🚫 ${msg} — falling back to paper mode`);
    } else {
      log.warn(`⚠️ ${msg} — enforceGate=false, proceeding with live`);
    }
  }

  return {
    passed,
    tradingMode: cfg.tradingMode,
    totalTrades: report.totalTrades,
    winRate: report.winRate,
    rewardRisk: costAdjustedRR,
    edgeScore: report.edgeScore,
    edgeDecision: report.edgeDecision,
    reasons,
  };
}
