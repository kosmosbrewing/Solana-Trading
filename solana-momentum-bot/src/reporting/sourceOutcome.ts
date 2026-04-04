import { Trade } from '../utils/types';

// ─── Explained Entry Ratio ────────────────────────────
// Why: MEASUREMENT.md "설명된 진입 비율" — "왜 이 토큰을 샀는가"에 답할 수 있는
// discovery provenance가 있는 entry 비율.
//
// 우선순위:
//   1) discoverySource — discovery provenance (권장/정식 기준)
//   2) sourceLabel — legacy fallback 또는 sandbox path 보조 기준
//
// sourceLabel은 signal path와 discovery path가 일부 혼재할 수 있으므로
// discoverySource가 있으면 항상 그 값을 우선한다.
export interface ExplainedEntryRatioResult {
  total: number;
  explained: number;
  unexplained: number;
  ratio: number;
  meetsMeasurementTarget: boolean;  // ratio >= 0.9 (참고용, hard gate로 사용 금지)
}

export function computeExplainedEntryRatio(
  trades: Array<{ discoverySource?: string; sourceLabel?: string }>
): ExplainedEntryRatioResult {
  const total = trades.length;
  if (total === 0) {
    return { total: 0, explained: 0, unexplained: 0, ratio: 0, meetsMeasurementTarget: false };
  }
  const unexplained = trades.filter((t) => {
    const label = normalizeAttributionLabel(t.discoverySource) ?? normalizeAttributionLabel(t.sourceLabel);
    return !label;
  }).length;
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

function normalizeAttributionLabel(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized === 'unknown') return undefined;
  return normalized;
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
