import { FAKE_FILL_SLIPPAGE_BPS_THRESHOLD } from '../utils/constants';

interface EdgeLikeTrade {
  entryPrice: number;
  stopLoss: number;
  quantity: number;
  pnl: number;
  /** Phase B1: planned vs actual entry 단위 정합성 체크용 — 없으면 검사 생략 */
  plannedEntryPrice?: number | null;
  /** Phase B1: TP인데 음수 PnL 필터용 — 없으면 검사 생략 */
  exitReason?: string | null;
  /** 2026-04-07: Jupiter Ultra saturated slippage / fake-fill 감지 (>=9000bps) */
  exitSlippageBps?: number | null;
  /** 2026-04-07: tradeExecution이 DB에 기록한 anomaly reason (fake_fill_*, slippage_saturated=*) */
  exitAnomalyReason?: string | null;
}

export interface EdgeInputSanitizerResult<T> {
  trades: T[];
  droppedCount: number;
  keptCount: number;
  /** Phase B1: drop 사유별 카운트 (ledger-audit on/off 비교용) */
  dropReasonCounts: Record<string, number>;
}

const MAX_REASONABLE_RISK_PCT = 0.9;

// Phase B1: CRITICAL_LIVE에서 관측된 BTW/pippin/stonks planned/actual ratio는
// 0.000001 ~ 200 수준이었다. 0.5~2.0 밖이면 단위 오염/ decimals 누락 가능성이 압도적으로 높다.
const PLANNED_ENTRY_RATIO_MIN = 0.5;
const PLANNED_ENTRY_RATIO_MAX = 2.0;

// Phase B1: take_profit 계열 exit_reason인데 pnl<0은 P0-C 사이드이펙트(alignOrderToExecutedEntry가
// 광적인 TP/SL을 저장한 뒤 즉시 trigger)라고 추정된다. 원장 정합성 회복 전까지 EdgeTracker 입력에서 제외.
const TP_EXIT_REASONS = new Set([
  'TAKE_PROFIT_1',
  'TAKE_PROFIT_2',
  'TRAILING_STOP', // 이익 상태 trailing 종료 (pnl<0은 단위 오염 의심)
]);

// 2026-04-07: Jupiter Ultra outputAmountResult="0" 케이스는 exit_slippage_bps=10000(=100%)으로
// 저장된다. 9000bps 이상이면 정상 체결이 아닌 saturated swap으로 간주하고 edge 표본에서 제외.
// 임계값은 src/utils/constants.ts에 공유 상수로 존재.

export type SanitizerDropReason =
  | 'invalid_entry_price'
  | 'invalid_stop_loss'
  | 'invalid_quantity'
  | 'invalid_pnl'
  | 'stop_above_entry'
  | 'zero_planned_risk'
  | 'risk_pct_too_high'
  | 'planned_entry_ratio_corrupt'
  | 'tp_negative_pnl'
  | 'fake_fill_slippage';

export function sanitizeEdgeLikeTrades<T extends EdgeLikeTrade>(
  trades: T[]
): EdgeInputSanitizerResult<T> {
  const sanitized: T[] = [];
  const dropReasonCounts: Record<string, number> = {};

  for (const trade of trades) {
    const reason = validateEdgeLikeTradeReason(trade);
    if (reason === null) {
      sanitized.push(trade);
    } else {
      dropReasonCounts[reason] = (dropReasonCounts[reason] ?? 0) + 1;
    }
  }

  return {
    trades: sanitized,
    droppedCount: trades.length - sanitized.length,
    keptCount: sanitized.length,
    dropReasonCounts,
  };
}

export function isValidEdgeLikeTrade(trade: EdgeLikeTrade): boolean {
  return validateEdgeLikeTradeReason(trade) === null;
}

/**
 * Phase B1 — drop reason을 분리 반환.
 * 원본 isValidEdgeLikeTrade는 boolean만 필요하므로 그대로 두고, 내부는 이 함수에 위임.
 */
export function validateEdgeLikeTradeReason(
  trade: EdgeLikeTrade
): SanitizerDropReason | null {
  if (!Number.isFinite(trade.entryPrice) || trade.entryPrice <= 0) return 'invalid_entry_price';
  if (!Number.isFinite(trade.stopLoss) || trade.stopLoss <= 0) return 'invalid_stop_loss';
  if (!Number.isFinite(trade.quantity) || trade.quantity <= 0) return 'invalid_quantity';
  if (!Number.isFinite(trade.pnl)) return 'invalid_pnl';

  // Why: 현재 전략은 long-only라 stop-loss는 entry 아래에 있어야 한다.
  if (trade.stopLoss >= trade.entryPrice) return 'stop_above_entry';

  const plannedRiskPct = Math.abs(trade.entryPrice - trade.stopLoss) / trade.entryPrice;
  if (!Number.isFinite(plannedRiskPct) || plannedRiskPct <= 0) return 'zero_planned_risk';

  // Why: 90%+ risk는 정상 모멘텀 주문식으로 보기 어렵고, price corruption 잔재일 가능성이 높다.
  if (plannedRiskPct >= MAX_REASONABLE_RISK_PCT) return 'risk_pct_too_high';

  // Phase B1: planned vs actual entry 단위 정합성
  if (trade.plannedEntryPrice != null && trade.plannedEntryPrice > 0) {
    const ratio = trade.entryPrice / trade.plannedEntryPrice;
    if (!Number.isFinite(ratio) || ratio < PLANNED_ENTRY_RATIO_MIN || ratio > PLANNED_ENTRY_RATIO_MAX) {
      return 'planned_entry_ratio_corrupt';
    }
  }

  // 2026-04-07: Fake-fill (Jupiter saturated swap) — tradeExecution 마킹이 있거나 slippage가 9000bps 이상이면
  //            exitPrice가 currentPrice로 마스킹된 contaminated row이므로 edge 입력에서 제외.
  //            양수 PnL로 위장되는 케이스까지 잡기 위해 tp_negative_pnl 체크보다 먼저 실행.
  if (trade.exitAnomalyReason && trade.exitAnomalyReason.length > 0) {
    return 'fake_fill_slippage';
  }
  if (trade.exitSlippageBps != null && trade.exitSlippageBps >= FAKE_FILL_SLIPPAGE_BPS_THRESHOLD) {
    return 'fake_fill_slippage';
  }

  // Phase B1: TP 계열인데 pnl<0은 P0-C contaminated trade — EdgeTracker 입력에서 제거
  if (trade.exitReason && TP_EXIT_REASONS.has(trade.exitReason) && trade.pnl < 0) {
    return 'tp_negative_pnl';
  }

  return null;
}
