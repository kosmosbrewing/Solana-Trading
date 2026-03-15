import { EdgeTracker } from '../reporting';
import { BacktestResult, BacktestTrade } from './types';

/**
 * 백테스트 결과 리포터
 */
export class BacktestReporter {
  /**
   * 콘솔에 요약 리포트 출력
   */
  printSummary(result: BacktestResult): void {
    const hr = '─'.repeat(60);
    console.log(`\n${hr}`);
    console.log(`  BACKTEST REPORT: ${result.strategy.toUpperCase()}`);
    console.log(hr);
    console.log(`  Pair:            ${result.pairAddress}`);
    console.log(`  Candles:         ${result.candleCount}`);
    console.log(`  Date Range:      ${fmt(result.dateRange.start)} → ${fmt(result.dateRange.end)}`);
    console.log(`  Initial Balance: ${result.config.initialBalance} SOL`);
    console.log(hr);

    // Trade Stats
    console.log(`  Total Trades:    ${result.totalTrades}`);
    console.log(`  Wins / Losses:   ${result.wins} / ${result.losses}`);
    console.log(`  Win Rate:        ${pct(result.winRate)}`);
    console.log(hr);

    // PnL
    console.log(`  Gross PnL:       ${result.grossPnl.toFixed(6)} SOL`);
    console.log(`  Net PnL:         ${result.netPnl.toFixed(6)} SOL (${pct(result.netPnlPct)})`);
    console.log(`  Final Equity:    ${result.finalEquity.toFixed(6)} SOL`);
    console.log(`  Profit Factor:   ${result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2)}`);
    console.log(hr);

    // Risk Metrics
    console.log(`  Max Drawdown:    ${result.maxDrawdown.toFixed(6)} SOL (${pct(result.maxDrawdownPct)})`);
    console.log(`  Sharpe Ratio:    ${result.sharpeRatio.toFixed(2)}`);
    console.log(`  Avg Win:         ${pct(result.avgWinPct)}`);
    console.log(`  Avg Loss:        ${pct(result.avgLossPct)}`);
    console.log(`  Largest Win:     ${result.largestWin.toFixed(6)} SOL`);
    console.log(`  Largest Loss:    ${result.largestLoss.toFixed(6)} SOL`);
    console.log(`  Avg Hold (bars): ${result.avgHoldingBars.toFixed(1)}`);
    console.log(hr);

    // Risk Rejections
    const rej = result.rejections;
    const totalRej =
      rej.dailyLimit +
      rej.drawdownHalt +
      rej.cooldown +
      rej.positionOpen +
      rej.zeroSize +
      rej.executionViability +
      rej.gradeFiltered +
      rej.safetyFiltered;
    if (totalRej > 0) {
      console.log(`  Risk Rejections: ${totalRej} total`);
      if (rej.dailyLimit > 0) console.log(`    Daily limit:   ${rej.dailyLimit}`);
      if (rej.drawdownHalt > 0) console.log(`    Drawdown halt: ${rej.drawdownHalt}`);
      if (rej.cooldown > 0)   console.log(`    Cooldown:      ${rej.cooldown}`);
      if (rej.positionOpen > 0) console.log(`    Position open: ${rej.positionOpen}`);
      if (rej.zeroSize > 0)   console.log(`    Zero size:     ${rej.zeroSize}`);
      if (rej.executionViability > 0) console.log(`    Exec viability: ${rej.executionViability}`);
      console.log(hr);
    }

    const grades = result.gradeDistribution;
    const totalGrades = grades.A + grades.B + grades.C;
    if (totalGrades > 0) {
      console.log(`  Grade Dist.:     A=${grades.A} B=${grades.B} C=${grades.C}`);
      if (rej.gradeFiltered > 0) console.log(`    Grade filtered: ${rej.gradeFiltered}`);
      if (rej.safetyFiltered > 0) console.log(`    Safety filtered: ${rej.safetyFiltered}`);
      console.log(hr);
    }

    this.printEdgeSummary(result.trades);

    // Exit Reason Breakdown
    this.printExitBreakdown(result.trades);
    console.log(hr);
  }

  /**
   * 트레이드 로그 출력
   */
  printTradeLog(trades: BacktestTrade[], limit?: number): void {
    const shown = limit ? trades.slice(0, limit) : trades;
    console.log(`\n  TRADE LOG (${shown.length}/${trades.length} trades)`);
    console.log('  ' + '─'.repeat(110));
    console.log(
      '  ' +
      pad('#', 4) +
      pad('Strategy', 14) +
        pad('Entry', 14) +
        pad('Exit', 14) +
        pad('Grade', 8) +
        pad('PnL %', 10) +
        pad('PnL SOL', 12) +
        pad('Exit Reason', 16) +
      pad('Bars', 6) +
      pad('Entry Time', 20)
    );
    console.log('  ' + '─'.repeat(110));

    for (const t of shown) {
      console.log(
        '  ' +
        pad(String(t.id), 4) +
        pad(t.strategy, 14) +
        pad(t.entryPrice.toPrecision(6), 14) +
        pad(t.exitPrice.toPrecision(6), 14) +
        pad(t.breakoutGrade || '-', 8) +
        pad(pct(t.pnlPct), 10) +
        pad(t.pnlSol.toFixed(6), 12) +
        pad(t.exitReason, 16) +
        pad(String(t.exitIdx - t.entryIdx), 6) +
        pad(fmt(t.entryTime), 20)
      );
    }

    if (limit && trades.length > limit) {
      console.log(`  ... ${trades.length - limit} more trades not shown`);
    }
  }

  /**
   * Equity curve 텍스트 차트 (ASCII)
   */
  printEquityCurve(result: BacktestResult, width: number = 60): void {
    const curve = result.equityCurve;
    if (curve.length < 2) return;

    console.log(`\n  EQUITY CURVE`);
    console.log('  ' + '─'.repeat(width + 20));

    const equities = curve.map(p => p.equity);
    const min = Math.min(...equities);
    const max = Math.max(...equities);
    const range = max - min || 1;

    // Sample points to fit width
    const step = Math.max(1, Math.floor(curve.length / 20));
    for (let i = 0; i < curve.length; i += step) {
      const pt = curve[i];
      const barLen = Math.round(((pt.equity - min) / range) * width);
      const bar = '█'.repeat(Math.max(1, barLen));
      const dd = pt.drawdown > 0 ? ` DD:${pct(pt.drawdown)}` : '';
      console.log(`  ${fmt(pt.timestamp)} │${bar} ${pt.equity.toFixed(4)}${dd}`);
    }

    // Always show last point
    const last = curve[curve.length - 1];
    if (curve.length % step !== 1) {
      const barLen = Math.round(((last.equity - min) / range) * width);
      const bar = '█'.repeat(Math.max(1, barLen));
      const dd = last.drawdown > 0 ? ` DD:${pct(last.drawdown)}` : '';
      console.log(`  ${fmt(last.timestamp)} │${bar} ${last.equity.toFixed(4)}${dd}`);
    }
  }

  /**
   * CSV로 트레이드 로그 내보내기
   */
  exportTradesCsv(trades: BacktestTrade[]): string {
    const header = 'id,strategy,grade,score,entry_time,exit_time,entry_price,stop_loss,exit_price,quantity,pnl_sol,pnl_pct,exit_reason,bars_held,peak_price';
    const rows = trades.map(t =>
      [
        t.id, t.strategy,
        t.breakoutGrade ?? '',
        t.breakoutScore ?? '',
        t.entryTime.toISOString(), t.exitTime.toISOString(),
        t.entryPrice, t.stopLoss, t.exitPrice, t.quantity,
        t.pnlSol.toFixed(8), (t.pnlPct * 100).toFixed(4),
        t.exitReason, t.exitIdx - t.entryIdx, t.peakPrice,
      ].join(',')
    );
    return [header, ...rows].join('\n');
  }

  /**
   * CSV로 equity curve 내보내기
   */
  exportEquityCsv(result: BacktestResult): string {
    const header = 'timestamp,equity,drawdown,trade_id';
    const rows = result.equityCurve.map(p =>
      [
        p.timestamp.toISOString(),
        p.equity.toFixed(8),
        (p.drawdown * 100).toFixed(4),
        p.tradeId ?? '',
      ].join(',')
    );
    return [header, ...rows].join('\n');
  }

  private printExitBreakdown(trades: BacktestTrade[]): void {
    if (trades.length === 0) return;

    const counts: Record<string, number> = {};
    for (const t of trades) {
      counts[t.exitReason] = (counts[t.exitReason] || 0) + 1;
    }

    console.log(`  Exit Reasons:`);
    for (const [reason, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${pad(reason, 16)} ${count} (${pct(count / trades.length)})`);
    }
  }

  private printEdgeSummary(trades: BacktestTrade[]): void {
    const edgeTracker = new EdgeTracker(
      trades.map(trade => ({
        pairAddress: trade.pairAddress,
        strategy: trade.strategy,
        entryPrice: trade.entryPrice,
        stopLoss: trade.stopLoss,
        quantity: trade.quantity,
        pnl: trade.pnlSol,
      }))
    );
    const stats = edgeTracker.getAllStrategyStats().filter(stat => stat.totalTrades > 0);
    if (stats.length === 0) return;

    console.log(`  EdgeTracker:`);
    for (const stat of stats) {
      const rewardRisk = Number.isFinite(stat.rewardRisk) ? stat.rewardRisk.toFixed(2) : 'inf';
      const kelly = stat.kellyEligible ? `${(stat.kellyFraction * 100).toFixed(1)}%` : 'locked';
      console.log(
        `    ${pad(stat.strategy, 14)} ${pad(stat.edgeState, 12)} ` +
        `WR ${pad(pct(stat.winRate), 9)} RR ${pad(rewardRisk, 6)} ` +
        `Sharpe ${pad(stat.sharpeRatio.toFixed(2), 6)} ` +
        `MaxL ${pad(String(stat.maxConsecutiveLosses), 3)} Kelly ${kelly}`
      );
    }
    console.log('  ' + '─'.repeat(60));
  }
}

// ─── Helpers ───

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function pad(s: string, len: number): string {
  return s.padEnd(len);
}
