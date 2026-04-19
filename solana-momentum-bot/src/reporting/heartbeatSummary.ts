import { PaperMetricsSummary } from './paperMetrics';
import { MarketRegime, RegimeState } from '../risk/regimeFilter';

export const HEARTBEAT_WINDOW_HOURS = 4;

// Why: 텔레그램 알림을 사용자 친화적으로 유지하기 위해 regime 내부 식별자를 한국어로 표기.
const REGIME_LABELS: Record<MarketRegime, string> = {
  risk_on: '위험선호',
  neutral: '중립',
  risk_off: '위험회피',
};

const REGIME_ICONS: Record<MarketRegime, string> = {
  risk_on: '🟢',
  neutral: '🟡',
  risk_off: '🔴',
};

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
    `📊 ${modeLabel} · 최근 ${params.windowHours}h`,
    `잔액 ${params.balanceSol.toFixed(4)} SOL (손익 ${formatSignedSol(params.pnl)})`,
    `진입 ${params.enteredTrades} · 종료 ${params.closedTrades} · 오픈 ${params.openTrades}`,
  ].join('\n');
}

export function buildHeartbeatPerformanceSummary(summary: PaperMetricsSummary): string | undefined {
  if (summary.totalTrades === 0) {
    return undefined;
  }

  const lines = [
    `전적 ${summary.wins}W ${summary.losses}L (${(summary.winRate * 100).toFixed(0)}%)`,
    `오진 ${(summary.falsePositiveRate * 100).toFixed(0)}% · TP1 ${(summary.tp1HitRate * 100).toFixed(0)}%`,
  ];

  if (Number.isFinite(summary.avgMaePct) && Number.isFinite(summary.avgMfePct)) {
    lines.splice(1, 0, `▼ 역행 ${summary.avgMaePct.toFixed(2)}% · ▲ 순행 ${summary.avgMfePct.toFixed(2)}%`);
  }

  return lines.join('\n');
}

export function buildHeartbeatRegimeSummary(regime: RegimeState): string {
  const icon = REGIME_ICONS[regime.regime];
  const label = REGIME_LABELS[regime.regime];
  const solIcon = regime.solTrendBullish ? '🟢' : '🔴';
  const solLabel = regime.solTrendBullish ? '강세' : '약세';
  return (
    `🔍 시장: ${icon} ${label} (${regime.sizeMultiplier}x)\n` +
    `SOL ${solIcon}${solLabel} · 확산 ${(regime.breadthPct * 100).toFixed(0)}% · 후속 ${(regime.followThroughPct * 100).toFixed(0)}%`
  );
}

function formatSignedSol(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(4)} SOL`;
}
