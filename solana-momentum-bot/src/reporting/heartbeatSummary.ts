import { PaperMetricsSummary } from './paperMetrics';
import { RegimeState } from '../risk/regimeFilter';

export const HEARTBEAT_WINDOW_HOURS = 4;

export function buildHeartbeatTradingSummary(params: {
  tradingMode: 'paper' | 'live';
  windowHours: number;
  balanceSol: number;
  pnl: number;
  enteredTrades: number;
  closedTrades: number;
  openTrades: number;
}): string {
  const modeLabel = params.tradingMode === 'live' ? 'Live' : 'Paper';
  return [
    `📊 ${modeLabel} · ${params.windowHours}h`,
    `잔액 ${params.balanceSol.toFixed(4)} SOL | 손익 ${formatSignedSol(params.pnl)}`,
    `최근 ${params.windowHours}h 진입 ${params.enteredTrades}건 | 종료 ${params.closedTrades}건 | 오픈 ${params.openTrades}건`,
  ].join('\n');
}

export function buildHeartbeatPerformanceSummary(summary: PaperMetricsSummary): string | undefined {
  if (summary.totalTrades === 0) {
    return undefined;
  }

  const lines = [
    `전적 ${summary.wins}W ${summary.losses}L (${(summary.winRate * 100).toFixed(0)}%)`,
    `오진 ${(summary.falsePositiveRate * 100).toFixed(0)}% | TP1 ${(summary.tp1HitRate * 100).toFixed(0)}%`,
  ];

  if (Number.isFinite(summary.avgMaePct) && Number.isFinite(summary.avgMfePct)) {
    lines.splice(1, 0, `▼ 역행 ${summary.avgMaePct.toFixed(2)}% | ▲ 순행 ${summary.avgMfePct.toFixed(2)}%`);
  }

  return lines.join('\n');
}

export function buildHeartbeatRegimeSummary(regime: RegimeState): string {
  const regimeIcon = regime.regime === 'risk_on' ? '🟢' : regime.regime === 'risk_off' ? '🔴' : '🟡';
  const solIcon = regime.solTrendBullish ? '🟢' : '🔴';
  const solLabel = regime.solTrendBullish ? '강세' : '약세';
  return (
    `🔍 시장: ${regimeIcon} ${regime.regime} (${regime.sizeMultiplier}x)\n` +
    `SOL ${solIcon}${solLabel} | 확산 ${(regime.breadthPct * 100).toFixed(0)}% | 후속 ${(regime.followThroughPct * 100).toFixed(0)}%`
  );
}

function formatSignedSol(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(4)} SOL`;
}
