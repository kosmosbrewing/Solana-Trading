import { Trade } from '../utils/types';

// ─── Explained Entry Ratio ───────────────────────���───
// Why: MEASUREMENT.md "설명된 진입 비율" — source attribution 있는 trade 비율
//
// 현재 sourceLabel은 두 가지 계층이 혼재:
//   1) discovery provenance: new_lp_sniper 경로 (birdeye_ws, scanner_dex_boost 등)
//   2) signal path: trigger/strategy 경로 (trigger_momentum, strategy_volume_spike 등)
//
// MEASUREMENT.md��� 의도하는 "왜 이 토큰을 샀는가"는 (1)에 가깝지만,
// trigger/strategy 경로에는 아직 discovery source 전달 파이프라인이 없어서
// signal path label로 대체합니다. 따라서 현재 ratio는 과대계상 가능성이 있으며,
// Mission Gate 판정(≥90% hard gate)에는 사용하지 않습니다.
//
// TODO: UniverseEngine → CandleHandler → Trigger 경로에 discoverySource ���드 추가 후
//       sourceLabel(discovery) vs signalPath 분리 구현
export interface ExplainedEntryRatioResult {
  total: number;
  explained: number;
  unexplained: number;
  ratio: number;
  meetsMeasurementTarget: boolean;  // ratio >= 0.9 (참고용, hard gate로 사용 금지)
}

export function computeExplainedEntryRatio(
  trades: Array<{ sourceLabel?: string }>
): ExplainedEntryRatioResult {
  const total = trades.length;
  if (total === 0) {
    return { total: 0, explained: 0, unexplained: 0, ratio: 0, meetsMeasurementTarget: false };
  }
  const unexplained = trades.filter(
    t => !t.sourceLabel || t.sourceLabel === 'unknown'
  ).length;
  const explained = total - unexplained;
  const ratio = explained / total;
  return {
    total,
    explained,
    unexplained,
    ratio,
    meetsMeasurementTarget: ratio >= 0.9,
  };
}

// ─── Source Outcome Stats ────────────────────────────
export interface SourceOutcomeStats {
  sourceLabel: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  pnl: number;
}

export function summarizeTradesBySource(trades: Trade[]): SourceOutcomeStats[] {
  const grouped = new Map<string, { totalTrades: number; wins: number; losses: number; pnl: number }>();

  for (const trade of trades) {
    if (trade.status !== 'CLOSED' || trade.pnl == null) continue;

    const sourceLabel = trade.sourceLabel ?? 'unknown';
    const current = grouped.get(sourceLabel) ?? {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      pnl: 0,
    };

    current.totalTrades += 1;
    current.pnl += trade.pnl;
    if (trade.pnl > 0) {
      current.wins += 1;
    } else {
      current.losses += 1;
    }

    grouped.set(sourceLabel, current);
  }

  return [...grouped.entries()]
    .map(([sourceLabel, value]) => ({
      sourceLabel,
      totalTrades: value.totalTrades,
      wins: value.wins,
      losses: value.losses,
      winRate: value.totalTrades > 0 ? value.wins / value.totalTrades : 0,
      pnl: value.pnl,
    }))
    .sort((left, right) => {
      if (right.totalTrades !== left.totalTrades) return right.totalTrades - left.totalTrades;
      if (right.pnl !== left.pnl) return right.pnl - left.pnl;
      return left.sourceLabel.localeCompare(right.sourceLabel);
    });
}
