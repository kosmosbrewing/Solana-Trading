import {
  AlertLevel,
  BreakoutGrade,
  CloseReason,
  Order,
  Signal,
  SizeConstraint,
  StrategyName,
  Trade,
} from '../utils/types';
import {
  escapeHtml,
  formatPercent,
  formatShortDuration,
  formatSignedPercent,
  formatSignedSol,
  koreanRoParticle,
  shortenAddress,
} from './formatting';
import { buildSignalDetailLines, buildSignalSummaryLines } from './signalMessageHelpers';

const STRATEGY_LABELS: Record<StrategyName, string> = {
  volume_spike: 'Volume Spike',
  bootstrap_10s: 'Bootstrap 10s',
  core_momentum: 'Core Momentum',
  tick_momentum: 'Tick Momentum',
  fib_pullback: 'Fib Pullback',
  new_lp_sniper: 'New LP Sniper',
  momentum_cascade: 'Momentum Cascade',
  cupsey_flip_10s: 'Cupsey Flip 10s',
  migration_reclaim: 'Migration Reclaim',
  pure_ws_breakout: 'Pure WS Breakout',
  pure_ws_swing_v2: 'Pure WS Swing v2',
  kol_hunter: 'KOL Hunter (live canary)',
};

const CLOSE_REASON_LABELS: Record<CloseReason, string> = {
  DEGRADED_EXIT: '유동성/체결 품질 저하',
  STOP_LOSS: '손절',
  TAKE_PROFIT_1: '1차 익절',
  TAKE_PROFIT_2: '2차 익절',
  TRAILING_STOP: '트레일링 스탑',
  TIME_STOP: '시간 종료',
  EXHAUSTION: '모멘텀 소진',
  REJECT_HARD_CUT: '초기 하드컷',
  REJECT_TIMEOUT: '초기 관찰 종료',
  WINNER_TIME_STOP: 'winner 시간 종료',
  WINNER_TRAILING: 'winner 트레일링',
  WINNER_BREAKEVEN: 'winner 본전 보호',
  EMERGENCY: '긴급 종료',
  MANUAL: '수동 종료',
  RECOVERED_CLOSED: '복구 후 정리',
  ORPHAN_NO_BALANCE: '잔고 없음 (고아 포지션 정리)',
};

const SIZE_CONSTRAINT_LABELS: Record<SizeConstraint, string> = {
  RISK: '리스크 한도 기준',
  LIQUIDITY: '유동성 한도 기준',
  EMERGENCY: '긴급 축소',
};

const EDGE_STATE_LABELS: Record<string, string> = {
  Bootstrap: '초기 수집 단계',
  Calibration: '보정 단계',
  Confirmed: '검증 통과',
  Proven: '장기 검증 통과',
};

// Why: Entry/Exit gap의 부동소수점 노이즈로 "0.00%" 같은 무의미한 gap이
//      표시되는 것을 방지. 1bp 미만은 실질적 의미 없음.
const GAP_EPSILON_PCT = 0.01;

export function buildAlertMessage(level: AlertLevel, context: string, message: string): string {
  const title = level === 'CRITICAL' ? 'Critical Alert' : 'Warning Alert';
  return [
    `${level === 'CRITICAL' ? '🔴' : '🟡'} <b>${title}</b>`,
    `- 영역: ${escapeHtml(context)}`,
    `- 내용: ${escapeHtml(message)}`,
  ].join('\n');
}

export function buildSignalMessage(signal: Signal): string {
  const grade = signal.breakoutScore?.grade ?? 'N/A';
  const score = signal.breakoutScore?.totalScore ?? 0;
  const summaryLines = buildSignalSummaryLines(signal);
  const detailLines = buildSignalDetailLines(signal);
  const signalTimestampIso = signal.timestamp.toISOString();

  return [
    `🟢 <b>${escapeHtml(signal.action)} 시그널</b>`,
    buildInstrumentLine(signal.tokenSymbol, signal.pairAddress),
    `- 전략: ${escapeHtml(formatStrategy(signal.strategy))}`,
    `- 컨트랙트: <code>${escapeHtml(signal.pairAddress)}</code>`,
    `- 시그널 시각(UTC): <code>${escapeHtml(signalTimestampIso)}</code>`,
    `- 감지 가격: ${signal.price.toFixed(8)}`,
    `- 시그널 품질: ${score}점 (${escapeHtml(formatGrade(grade))})`,
    ...summaryLines,
    detailLines.length > 0 ? '' : '',
    detailLines.length > 0 ? '진입 근거' : '',
    ...detailLines,
  ].filter(Boolean).join('\n');
}

// 2026-04-29: 진입/종료 알림 일관 emoji + 3-line 표준화.
//   - 🟢 진입 (OPEN, 항상 동일)
//   - 🔴 종료 (CLOSE, 항상 동일 — pnl 부호로 W/L 표시)
//   - 3 라인 max: 헤드라인 / 핵심 정보 / 컨트랙트+tx
// 제거: 전략 라벨 / 슬리피지 / Entry/Exit gap / 시그널 품질 / 사이즈 제한 (모두 ledger 보존).

export function buildTradeOpenMessage(order: Order, txSignature?: string): string {
  // 2026-04-29: actualNotionalSol (RPC 측정 wallet delta) 우선 사용.
  //   - 정상: order.actualNotionalSol = buyResult.actualInputUiAmount = wallet 차감 SOL (fee 포함)
  //   - fallback (partialFillDataMissing): order.actualNotionalSol = plannedEntryNotionalSol (planned)
  //     → 알림에 `⚠ planned (RPC 측정 누락)` flag 표시.
  //   - 미전파 (legacy): price × quantity 로 fallback.
  const entryNotionalSol = order.actualNotionalSol ?? (order.price * order.quantity);
  const shortTradeId = order.tradeId ? order.tradeId.slice(0, 8) : '';
  const symbol = order.tokenSymbol ?? shortenAddress(order.pairAddress);
  const slPct = ((order.stopLoss - order.price) / order.price) * 100;
  const tp1Pct = ((order.takeProfit1 - order.price) / order.price) * 100;
  const tp2Pct = ((order.takeProfit2 - order.price) / order.price) * 100;
  const txShort = txSignature ? txSignature.slice(0, 12) : '';
  const fallbackFlag = order.partialFillDataMissing ? ' · ⚠ planned (RPC 측정 누락)' : '';
  const strategyBadge = buildTradeStrategyBadge(order);
  const strategySuffix = strategyBadge ? ` · <code>${escapeHtml(strategyBadge)}</code>` : '';

  const headline = `🟢 <b>진입</b> <b>${escapeHtml(symbol)}</b>${shortTradeId ? ` <code>${escapeHtml(shortTradeId)}</code>` : ''}${strategySuffix}`;
  const detail = `${entryNotionalSol.toFixed(4)} SOL @ ${order.price.toFixed(8)} · SL ${slPct.toFixed(0)}% / TP +${tp1Pct.toFixed(0)}% / +${tp2Pct.toFixed(0)}%${fallbackFlag}`;
  // 2026-05-01 (Sprint Y2): cost decomposition. swap + rent + fee 분리 표시 → 외부 explorer USD 비교 정합.
  //   ATA rent 자동 회수 정책 (운영자 manual) 정합 — 실 token 가격은 swap-only 기준 분명히.
  //   ataRent === 0 (재진입) 또는 분해 실패 시 단순 표시 (이전 동작 유지).
  // 2026-05-01 (Y2 G1 fix): partialFillDataMissing 시 costLine 미표시.
  //   entryNotionalSol 이 planned 로 fallback 됐는데 swap/rent/fee 는 실측 → 합계 mismatch 발생.
  //   운영자 혼선 차단 위해 partial fill 데이터 정합 안 될 때는 detail 만 표시 (⚠ planned flag 유지).
  let costLine: string | null = null;
  if (
    !order.partialFillDataMissing &&
    typeof order.swapInputSol === 'number' && order.swapInputSol > 0 &&
    typeof order.ataRentSol === 'number' && order.ataRentSol > 0
  ) {
    const fee = (order.networkFeeSol ?? 0) + (order.jitoTipSol ?? 0);
    costLine = `└ swap ${order.swapInputSol.toFixed(4)} + rent ${order.ataRentSol.toFixed(4)}${fee > 0 ? ` + fee ${fee.toFixed(4)}` : ''} SOL`;
  }
  const linkLine = `<code>${escapeHtml(order.pairAddress)}</code>${txShort ? ` · tx <code>${escapeHtml(txShort)}</code>` : ''}`;

  return [headline, detail, costLine, linkLine].filter((l): l is string => l != null).join('\n');
}

export function buildTradeCloseMessage(trade: Trade): string {
  const pnl = trade.pnl;
  const pnlPct = calculatePnlPct(trade);
  const duration = trade.closedAt ? formatShortDuration(trade.closedAt.getTime() - trade.createdAt.getTime()) : '';
  const reasonText = formatCloseReason(trade.exitReason);
  const symbol = trade.tokenSymbol ?? shortenAddress(trade.pairAddress);
  const shortId = trade.id.slice(0, 8);
  const exit = trade.exitPrice != null ? trade.exitPrice.toFixed(8) : 'N/A';
  const pnlText = `${formatSignedSol(pnl)}${pnlPct != null ? ` (${formatSignedPercent(pnlPct)})` : ''}`;
  const txShort = trade.txSignature ? trade.txSignature.slice(0, 12) : '';
  const strategyBadge = buildTradeStrategyBadge(trade);
  const strategySuffix = strategyBadge ? ` · <code>${escapeHtml(strategyBadge)}</code>` : '';

  const headline = `🔴 <b>종료</b> <b>${escapeHtml(symbol)}</b> <code>${escapeHtml(shortId)}</code>${strategySuffix} · ${pnlText}`;
  const meta = [reasonText, duration ? `보유 ${duration}` : '', `${trade.entryPrice.toFixed(8)} → ${exit}`]
    .filter(Boolean).join(' · ');
  // 2026-05-01 (Sprint Z+1): entry rent 분 visibility 보조 line.
  //   pnl / pnlPct 자체는 wallet-delta 기준 (rent 포함, 사용자 권고 정합).
  //   ataRentSol > 0 (신규 토큰 첫 진입) 시 손실/이익 중 rent 분 SOL 명시 → 운영자 manual 회수 결정 보조.
  const rentLine = (trade.ataRentSol != null && trade.ataRentSol > 0)
    ? `└ entry rent ${trade.ataRentSol.toFixed(4)} SOL 포함 (회수 시 환급 가능)`
    : null;
  const linkLine = `<code>${escapeHtml(trade.pairAddress)}</code>${txShort ? ` · tx <code>${escapeHtml(txShort)}</code>` : ''}`;

  return [headline, escapeHtml(meta), rentLine, linkLine].filter((l): l is string => l != null).join('\n');
}

// 2026-04-29 간소화: buildCloseProfitLine / buildClosePriceLine / buildExitGapLine /
//   buildCostSummaryLine 4 helper 제거 — 모두 close 메시지 inline 으로 통합.
//   slippage / cost / exit gap 정보는 trade ledger (executed-sells.jsonl) 에 보존되므로
//   알림 noise 만 줄이고 분석 데이터는 무손실.

export function buildRecoveryReportMessage(details: string[]): string {
  return [
    `🔄 <b>복구 리포트</b>`,
    ...(details.length > 0
      ? details.map(detail => `- ${escapeHtml(detail)}`)
      : ['- 상세 내용 없음']),
  ].join('\n');
}

function calculatePnlPct(trade: Trade): number | null {
  if (trade.pnl == null) return null;
  const notional = trade.entryPrice * trade.quantity;
  if (!Number.isFinite(notional) || notional <= 0) return null;
  return trade.pnl / notional;
}

export function formatStrategy(strategy: StrategyName): string {
  return STRATEGY_LABELS[strategy] ?? strategy;
}

function formatGrade(grade: BreakoutGrade | 'N/A'): string {
  return grade === 'N/A' ? '등급 없음' : `${grade}등급`;
}

// 2026-04-29: formatSizeConstraint / buildExitLevelLine / formatSignedSolDetailed / GAP_EPSILON_PCT
//   helper 4종 제거 — 진입/종료 알림 일관 emoji + 3-line 표준화 시 inline 으로 통합됨.

function formatCloseReason(value?: CloseReason): string {
  if (!value) return '사유 없음';
  return CLOSE_REASON_LABELS[value] ?? value;
}

function buildTradeStrategyBadge(trade: Pick<Order | Trade, 'strategy' | 'sourceLabel' | 'discoverySource'>): string | null {
  const source = trade.sourceLabel?.trim();
  if (source && source !== 'unknown') {
    return formatSourceLabelBadge(source);
  }
  if (trade.strategy === 'kol_hunter') return 'kol';
  if (trade.strategy === 'pure_ws_breakout') return 'pure-ws';
  if (trade.strategy === 'pure_ws_swing_v2') return 'pure-ws swing';
  return null;
}

function formatSourceLabelBadge(sourceLabel: string): string {
  const known: Record<string, string> = {
    kol_hunter_smart_v3: 'smart-v3',
    smart_v3_fast_fail: 'smart-v3 fast',
    smart_v3_runner_relaxed: 'smart-v3 runner',
    kol_hunter_swing_v2: 'swing-v2',
    kol_hunter_rotation_v1: 'rotation-v1',
    rotation_underfill_v1: 'rotation underfill',
    rotation_exit_kol_flow_v1: 'rotation exit-flow',
    rotation_underfill_exit_flow_v1: 'rotation underfill+flow',
    rotation_chase_topup_v1: 'rotation chase',
    kol_hunter_capitulation_rebound_v1: 'capitulation',
    ws_burst_v2: 'pure-ws',
  };
  if (known[sourceLabel]) return known[sourceLabel];
  return sourceLabel
    .replace(/^kol_hunter_/, '')
    .replace(/_v\d+$/, '')
    .replace(/_/g, ' ')
    .slice(0, 32);
}

export function formatEdgeState(value: string): string {
  return EDGE_STATE_LABELS[value] ?? value;
}

function buildInstrumentLine(symbol: string | undefined, pairAddress: string): string {
  if (symbol) {
    return `- 종목: <b>${escapeHtml(symbol)}</b>`;
  }
  return `- 종목: <b>${escapeHtml(shortenAddress(pairAddress))}</b> (ticker 미확인)`;
}
