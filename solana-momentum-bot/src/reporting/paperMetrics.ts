import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('PaperMetrics');

export interface PaperTradeRecord {
  id: string;
  pairAddress: string;
  strategy: string;
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  entryTime: Date;
  exitTime?: Date;
  exitReason?: string;
  /** Maximum Adverse Excursion — 진입 후 최대 역행폭 (%) */
  mae: number;
  /** Maximum Favorable Excursion — 진입 후 최대 순행폭 (%) */
  mfe: number;
  /** Actual price impact at entry (from Jupiter quote) */
  entryPriceImpactPct?: number;
  /** Time from signal to fill (ms) — quote decay 추적 */
  timeToFillMs?: number;
  /** Quote price vs actual fill price difference */
  quoteDecayPct?: number;
  /** Was this a false positive? (ended in SL hit) */
  falsePositive: boolean;
  /** Security gate flags at entry */
  securityFlags?: string[];
  /** Regime at entry */
  regimeAtEntry?: string;
}

export interface PaperMetricsSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Average MAE across all trades */
  avgMaePct: number;
  /** Average MFE across all trades */
  avgMfePct: number;
  /** False positive rate (SL hits / total) */
  falsePositiveRate: number;
  /** Average price impact at entry */
  avgPriceImpactPct: number;
  /** Average quote decay */
  avgQuoteDecayPct: number;
  /** Average time to fill */
  avgTimeToFillMs: number;
  /** Trades per regime */
  tradesByRegime: Record<string, { count: number; winRate: number }>;
  /** TP1 hit rate (follow-through metric for RegimeFilter) */
  tp1HitRate: number;
}

/**
 * Paper Trading Metrics Tracker
 *
 * Phase 1B 측정 항목:
 *   - false positive rate
 *   - price impact (실측 vs 추정)
 *   - quote decay (시간 경과에 따른 가격 변동)
 *   - MAE/MFE (Maximum Adverse/Favorable Excursion)
 *   - time-to-fill
 *   - regime별 성과
 */
export class PaperMetricsTracker {
  private trades: PaperTradeRecord[] = [];
  private maxTradesInMemory = 500;

  recordEntry(trade: Omit<PaperTradeRecord, 'mae' | 'mfe' | 'falsePositive'>): string {
    const record: PaperTradeRecord = {
      ...trade,
      mae: 0,
      mfe: 0,
      falsePositive: false,
    };
    this.trades.push(record);
    this.pruneOldTrades();
    log.info(`Paper entry: ${trade.strategy} ${trade.pairAddress} @ ${trade.entryPrice}`);
    return trade.id;
  }

  updateExcursion(id: string, currentPrice: number): void {
    const trade = this.trades.find(t => t.id === id);
    if (!trade || trade.exitPrice != null) return;

    const excursionPct = (currentPrice - trade.entryPrice) / trade.entryPrice;

    // MAE = worst drawdown from entry (negative excursion)
    if (excursionPct < 0) {
      trade.mae = Math.min(trade.mae, excursionPct);
    }
    // MFE = best profit from entry (positive excursion)
    if (excursionPct > 0) {
      trade.mfe = Math.max(trade.mfe, excursionPct);
    }
  }

  recordExit(id: string, exitPrice: number, exitReason: string): void {
    const trade = this.trades.find(t => t.id === id);
    if (!trade) return;

    trade.exitPrice = exitPrice;
    trade.exitTime = new Date();
    trade.exitReason = exitReason;
    trade.falsePositive = exitReason === 'STOP_LOSS';

    const pnlPct = ((exitPrice - trade.entryPrice) / trade.entryPrice * 100).toFixed(2);
    log.info(
      `Paper exit: ${trade.strategy} ${trade.pairAddress} ` +
      `pnl=${pnlPct}% mae=${(trade.mae * 100).toFixed(2)}% mfe=${(trade.mfe * 100).toFixed(2)}% ` +
      `reason=${exitReason} fp=${trade.falsePositive}`
    );
  }

  getSummary(windowHours = 48): PaperMetricsSummary {
    const cutoff = new Date(Date.now() - windowHours * 3600_000);
    const recent = this.trades.filter(t => t.entryTime >= cutoff && t.exitPrice != null);

    const wins = recent.filter(t => t.exitPrice! > t.entryPrice);
    const losses = recent.filter(t => t.exitPrice! <= t.entryPrice);
    const tp1Hits = recent.filter(t => t.exitReason === 'TAKE_PROFIT_1' || t.exitReason === 'TAKE_PROFIT_2');

    const avgMae = recent.length > 0
      ? recent.reduce((sum, t) => sum + t.mae, 0) / recent.length
      : 0;
    const avgMfe = recent.length > 0
      ? recent.reduce((sum, t) => sum + t.mfe, 0) / recent.length
      : 0;
    const avgImpact = recent.filter(t => t.entryPriceImpactPct != null);
    const avgDecay = recent.filter(t => t.quoteDecayPct != null);
    const avgFill = recent.filter(t => t.timeToFillMs != null);

    // Trades by regime
    const regimeMap: Record<string, { count: number; wins: number }> = {};
    for (const t of recent) {
      const r = t.regimeAtEntry ?? 'unknown';
      if (!regimeMap[r]) regimeMap[r] = { count: 0, wins: 0 };
      regimeMap[r].count++;
      if (t.exitPrice! > t.entryPrice) regimeMap[r].wins++;
    }
    const tradesByRegime: Record<string, { count: number; winRate: number }> = {};
    for (const [r, v] of Object.entries(regimeMap)) {
      tradesByRegime[r] = { count: v.count, winRate: v.count > 0 ? v.wins / v.count : 0 };
    }

    return {
      totalTrades: recent.length,
      wins: wins.length,
      losses: losses.length,
      winRate: recent.length > 0 ? wins.length / recent.length : 0,
      avgMaePct: avgMae * 100,
      avgMfePct: avgMfe * 100,
      falsePositiveRate: recent.length > 0
        ? recent.filter(t => t.falsePositive).length / recent.length
        : 0,
      avgPriceImpactPct: avgImpact.length > 0
        ? avgImpact.reduce((s, t) => s + t.entryPriceImpactPct!, 0) / avgImpact.length
        : 0,
      avgQuoteDecayPct: avgDecay.length > 0
        ? avgDecay.reduce((s, t) => s + t.quoteDecayPct!, 0) / avgDecay.length
        : 0,
      avgTimeToFillMs: avgFill.length > 0
        ? avgFill.reduce((s, t) => s + t.timeToFillMs!, 0) / avgFill.length
        : 0,
      tradesByRegime,
      tp1HitRate: recent.length > 0 ? tp1Hits.length / recent.length : 0,
    };
  }

  /** Format summary for Telegram/log output */
  formatSummaryText(windowHours = 48): string {
    const s = this.getSummary(windowHours);
    const lines = [
      `📊 Paper Metrics (last ${windowHours}h)`,
      `Trades: ${s.totalTrades} | Win: ${s.wins} | Loss: ${s.losses} | WR: ${(s.winRate * 100).toFixed(0)}%`,
      `MAE: ${s.avgMaePct.toFixed(2)}% | MFE: ${s.avgMfePct.toFixed(2)}%`,
      `FP Rate: ${(s.falsePositiveRate * 100).toFixed(0)}% | TP1 Hit: ${(s.tp1HitRate * 100).toFixed(0)}%`,
      `Avg Impact: ${s.avgPriceImpactPct.toFixed(3)}% | Quote Decay: ${s.avgQuoteDecayPct.toFixed(3)}%`,
    ];

    if (Object.keys(s.tradesByRegime).length > 0) {
      lines.push('Regime:');
      for (const [regime, data] of Object.entries(s.tradesByRegime)) {
        lines.push(`  ${regime}: ${data.count} trades, WR ${(data.winRate * 100).toFixed(0)}%`);
      }
    }

    return lines.join('\n');
  }

  getOpenTrades(): PaperTradeRecord[] {
    return this.trades.filter(t => t.exitPrice == null);
  }

  private pruneOldTrades(): void {
    if (this.trades.length > this.maxTradesInMemory) {
      this.trades = this.trades.slice(-this.maxTradesInMemory);
    }
  }
}
