import axios, { AxiosInstance } from 'axios';
import { StrategyEdgeStats } from '../reporting';
import { createModuleLogger } from '../utils/logger';
import { Signal, Trade, Order, AlertLevel } from '../utils/types';

const log = createModuleLogger('Notifier');

const ALERT_EMOJI: Record<AlertLevel, string> = {
  CRITICAL: '🔴',
  WARNING: '🟡',
  TRADE: '🟢',
  INFO: '⚪',
};

interface ThrottleEntry {
  lastSent: number;
  count: number;
  hourStart: number;
}

export class Notifier {
  private client: AxiosInstance;
  private chatId: string;
  private enabled: boolean;
  private throttle: Map<string, ThrottleEntry> = new Map();

  constructor(botToken: string, chatId: string) {
    this.chatId = chatId;
    this.enabled = !!(botToken && chatId);

    this.client = axios.create({
      baseURL: `https://api.telegram.org/bot${botToken}`,
      timeout: 10000,
    });

    if (!this.enabled) {
      log.warn('Telegram notifier disabled — missing BOT_TOKEN or CHAT_ID');
    }
  }

  // ─── 4-Level Alert System ───

  async sendCritical(context: string, message: string): Promise<void> {
    const msg = [
      `${ALERT_EMOJI.CRITICAL} <b>CRITICAL: ${context}</b>`,
      message,
    ].join('\n');
    await this.send(msg);
  }

  async sendWarning(context: string, message: string): Promise<void> {
    const key = `warning:${context}`;
    if (this.isThrottled(key, 5 * 60 * 1000)) return;
    this.updateThrottle(key);

    const msg = [
      `${ALERT_EMOJI.WARNING} <b>WARNING: ${context}</b>`,
      message,
    ].join('\n');
    await this.send(msg);
  }

  async sendTradeAlert(message: string): Promise<void> {
    const msg = `${ALERT_EMOJI.TRADE} ${message}`;
    await this.send(msg);
  }

  async sendInfo(message: string): Promise<void> {
    const key = 'info';
    if (this.isHourlyThrottled(key, 5)) return;
    this.updateThrottle(key);

    const msg = `${ALERT_EMOJI.INFO} ${message}`;
    await this.send(msg);
  }

  // ─── Trade-specific alerts ───

  async sendSignal(signal: Signal): Promise<void> {
    const grade = signal.breakoutScore?.grade || 'N/A';
    const score = signal.breakoutScore?.totalScore ?? 0;

    const msg = [
      `${ALERT_EMOJI.TRADE} <b>SIGNAL: ${signal.action}</b>`,
      `Strategy: ${signal.strategy}`,
      `Pair: <code>${signal.pairAddress}</code>`,
      `Price: ${signal.price.toFixed(8)}`,
      `Score: ${score} (Grade ${grade})`,
      signal.poolTvl ? `TVL: $${signal.poolTvl.toFixed(0)}` : '',
      '',
      ...Object.entries(signal.meta).map(
        ([k, v]) => `  ${k}: ${typeof v === 'number' ? v.toFixed(4) : v}`
      ),
    ].filter(Boolean).join('\n');

    await this.send(msg);
  }

  async sendTradeOpen(order: Order, txSignature?: string): Promise<void> {
    const grade = order.breakoutGrade || 'N/A';
    const constraint = order.sizeConstraint || 'N/A';

    const msg = [
      `${ALERT_EMOJI.TRADE} <b>ENTRY: ${order.strategy}</b>`,
      `Score: ${order.breakoutScore ?? 'N/A'} (Grade ${grade})`,
      `Size: ${order.quantity.toFixed(6)} SOL (${constraint})`,
      `Price: ${order.price.toFixed(8)}`,
      `SL: ${order.stopLoss.toFixed(8)}`,
      `TP1: ${order.takeProfit1.toFixed(8)} | TP2: ${order.takeProfit2.toFixed(8)}`,
      txSignature ? `TX: <code>${txSignature}</code>` : '',
    ].filter(Boolean).join('\n');

    await this.send(msg);
  }

  async sendTradeClose(trade: Trade): Promise<void> {
    const pnlIcon = (trade.pnl || 0) >= 0 ? '✅' : '❌';
    const msg = [
      `${pnlIcon} <b>EXIT: ${trade.strategy}</b>`,
      `Reason: ${trade.exitReason || 'N/A'}`,
      `Entry: ${trade.entryPrice.toFixed(8)} → Exit: ${trade.exitPrice?.toFixed(8) || 'N/A'}`,
      `PnL: ${trade.pnl?.toFixed(6) || 'N/A'} SOL`,
      `Slippage: ${((trade.slippage || 0) * 100).toFixed(2)}%`,
      trade.txSignature ? `TX: <code>${trade.txSignature}</code>` : '',
    ].filter(Boolean).join('\n');

    await this.send(msg);
  }

  async sendRecoveryReport(details: string[]): Promise<void> {
    const msg = [
      `🔄 <b>RECOVERY</b>`,
      ...details.map(d => `  ${d}`),
    ].join('\n');

    await this.send(msg);
  }

  async sendError(context: string, error: unknown): Promise<void> {
    await this.sendCritical(context,
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  async sendDailySummary(report: {
    totalTrades: number;
    wins: number;
    losses: number;
    pnl: number;
    portfolioValue: number;
    bestTrade?: { pair: string; pnl: number; score: number; grade: string };
    worstTrade?: { pair: string; pnl: number; score: number; grade: string };
    signalsDetected: number;
    signalsExecuted: number;
    signalsFiltered: number;
    dailyLossUsed: number;
    dailyLossLimit: number;
    consecutiveLosses: number;
    uptime: number;
    restarts: number;
    edgeStats?: StrategyEdgeStats[];
  }): Promise<void> {
    const winRate = report.totalTrades > 0
      ? ((report.wins / report.totalTrades) * 100).toFixed(1)
      : '0';
    const pnlPct = report.portfolioValue > 0
      ? ((report.pnl / report.portfolioValue) * 100).toFixed(1)
      : '0';

    const lines = [
      `📊 <b>Daily Report — ${new Date().toISOString().slice(0, 10)}</b>`,
      '',
      `Trades: ${report.totalTrades} (Win: ${report.wins}, Loss: ${report.losses})`,
      `PnL: ${report.pnl >= 0 ? '+' : ''}${report.pnl.toFixed(4)} SOL (${pnlPct}%)`,
      `Win Rate: ${winRate}%`,
    ];

    if (report.bestTrade) {
      lines.push(`Best: ${report.bestTrade.pair.slice(0, 8)}... +${report.bestTrade.pnl.toFixed(4)} (Score:${report.bestTrade.score} ${report.bestTrade.grade})`);
    }
    if (report.worstTrade) {
      lines.push(`Worst: ${report.worstTrade.pair.slice(0, 8)}... ${report.worstTrade.pnl.toFixed(4)} (Score:${report.worstTrade.score} ${report.worstTrade.grade})`);
    }

    lines.push(
      '',
      `Signals: ${report.signalsDetected} → ${report.signalsExecuted} exec (${report.signalsFiltered} filtered)`,
      '',
      `Risk:`,
      `  Daily Loss: ${(report.dailyLossUsed * 100).toFixed(1)}% / ${(report.dailyLossLimit * 100).toFixed(1)}%`,
      `  Consec. Losses: ${report.consecutiveLosses}`,
      '',
      `Uptime: ${formatDuration(report.uptime)} (restarts: ${report.restarts})`
    );

    const visibleEdgeStats = (report.edgeStats ?? []).filter(stat => stat.totalTrades > 0);
    if (visibleEdgeStats.length > 0) {
      lines.push('', 'EdgeTracker:');
      for (const stat of visibleEdgeStats) {
        const rewardRisk = Number.isFinite(stat.rewardRisk) ? stat.rewardRisk.toFixed(2) : 'inf';
        const kelly = stat.kellyEligible ? `${(stat.kellyFraction * 100).toFixed(1)}%` : 'locked';
        lines.push(
          `  ${stat.strategy}: ${stat.edgeState} | WR ${(stat.winRate * 100).toFixed(1)}% | ` +
          `R:R ${rewardRisk} | Sharpe ${stat.sharpeRatio.toFixed(2)} | ` +
          `MaxL ${stat.maxConsecutiveLosses} | Kelly ${kelly}`
        );
      }
    }

    await this.send(lines.join('\n'));
  }

  // ─── Throttling ───

  private isThrottled(key: string, windowMs: number): boolean {
    const entry = this.throttle.get(key);
    if (!entry) return false;
    return Date.now() - entry.lastSent < windowMs;
  }

  private isHourlyThrottled(key: string, maxPerHour: number): boolean {
    const entry = this.throttle.get(key);
    if (!entry) return false;
    const currentHour = Math.floor(Date.now() / 3_600_000);
    if (entry.hourStart !== currentHour) return false;
    return entry.count >= maxPerHour;
  }

  private updateThrottle(key: string): void {
    const currentHour = Math.floor(Date.now() / 3_600_000);
    const existing = this.throttle.get(key);

    if (existing && existing.hourStart === currentHour) {
      existing.lastSent = Date.now();
      existing.count++;
    } else {
      this.throttle.set(key, {
        lastSent: Date.now(),
        count: 1,
        hourStart: currentHour,
      });
    }
  }

  private async send(text: string): Promise<void> {
    if (!this.enabled) {
      log.debug(`[Telegram disabled] ${text.replace(/<[^>]*>/g, '')}`);
      return;
    }

    try {
      await this.client.post('/sendMessage', {
        chat_id: this.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (error) {
      log.error(`Telegram send failed: ${error}`);
    }
  }
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m`;
}
