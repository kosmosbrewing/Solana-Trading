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

export function buildTradeOpenMessage(order: Order, txSignature?: string): string {
  const entryNotionalSol = order.price * order.quantity;
  const shortTradeId = order.tradeId ? order.tradeId.slice(0, 8) : undefined;
  const headline = buildOpenHeadline(order.tokenSymbol, order.pairAddress, shortTradeId);
  const entryLine = buildEntryLine(order, entryNotionalSol);
  const gapLine = buildEntryGapLine(order);
  const stopLine = buildExitLevelLine('손절', order.price, order.stopLoss, order.quantity, 'stop');
  const tp1Line = buildExitLevelLine('TP1', order.price, order.takeProfit1, order.quantity, 'take_profit');
  const tp2Line = buildExitLevelLine('TP2', order.price, order.takeProfit2, order.quantity, 'take_profit');
  const qualityLine = order.breakoutScore != null
    ? `- 시그널 품질: ${order.breakoutScore}점 (${escapeHtml(formatGrade(order.breakoutGrade ?? 'N/A'))})`
    : '';
  const sizeLine = formatSizeConstraint(order.sizeConstraint);

  return [
    headline,
    `- 전략: ${escapeHtml(formatStrategy(order.strategy))}`,
    entryLine,
    stopLine,
    tp1Line,
    tp2Line,
    sizeLine ? `- 포지션 제한: ${escapeHtml(sizeLine)}` : '',
    qualityLine,
    gapLine,
    `- 컨트랙트: <code>${escapeHtml(order.pairAddress)}</code>`,
    txSignature ? `- tx: <code>${escapeHtml(txSignature)}</code>` : '',
  ].filter(Boolean).join('\n');
}

function buildOpenHeadline(
  symbol: string | undefined,
  pairAddress: string,
  shortTradeId: string | undefined
): string {
  const label = symbol ? `<b>${escapeHtml(symbol)}</b>` : `<b>${escapeHtml(shortenAddress(pairAddress))}</b> (ticker 미확인)`;
  const id = shortTradeId ? ` <code>${escapeHtml(shortTradeId)}</code>` : '';
  return `🟢 <b>포지션 진입</b> ${label}${id}`;
}

function buildEntryLine(order: Order, entryNotionalSol: number): string {
  const symbol = order.tokenSymbol ? ` ${escapeHtml(order.tokenSymbol)}` : '';
  return `- 진입: ${entryNotionalSol.toFixed(6)} SOL @ ${order.price.toFixed(8)} (수량 ${order.quantity.toFixed(6)}${symbol})`;
}

function buildEntryGapLine(order: Order): string {
  if (order.plannedEntryPrice == null || order.plannedEntryPrice <= 0) return '';
  const gapPct = ((order.price - order.plannedEntryPrice) / order.plannedEntryPrice) * 100;
  if (Math.abs(gapPct) < GAP_EPSILON_PCT) return '';
  return `- Entry gap: ${gapPct >= 0 ? '+' : ''}${gapPct.toFixed(2)}% (planned=${order.plannedEntryPrice.toFixed(8)} → fill=${order.price.toFixed(8)})`;
}

export function buildTradeCloseMessage(trade: Trade): string {
  // 2026-04-29 간소화: 8라인 → 4라인. wallet ground truth (실 체결가) 기준만 표시.
  // 제거: 사유 별도 라인 / 비용 라인 / Exit gap 라인 / 결과 라벨 / 슬리피지 (DB ledger 에 보존됨).
  // 보존: 손익 (실 wallet delta), 가격 (실 fill), 컨트랙트, tx (체결 검증용).
  const pnl = trade.pnl;
  const pnlPct = calculatePnlPct(trade);
  const duration = trade.closedAt ? formatShortDuration(trade.closedAt.getTime() - trade.createdAt.getTime()) : '';
  const reasonText = formatCloseReason(trade.exitReason);
  const headline = buildCloseHeadline(trade);
  const pnlText = `${formatSignedSol(pnl)}${pnlPct != null ? ` (${formatSignedPercent(pnlPct)})` : ''}`;
  const exit = trade.exitPrice != null ? trade.exitPrice.toFixed(8) : 'N/A';
  const meta = [reasonText, duration ? `보유 ${duration}` : ''].filter(Boolean).join(' · ');

  return [
    headline,
    `- 손익: ${pnlText} · ${escapeHtml(meta)}`,
    `- 가격: ${trade.entryPrice.toFixed(8)} → ${exit}`,
    `- <code>${escapeHtml(trade.pairAddress)}</code>`,
    trade.txSignature ? `- tx: <code>${escapeHtml(trade.txSignature)}</code>` : '',
  ].filter(Boolean).join('\n');
}

function buildCloseHeadline(trade: Trade): string {
  const pnl = trade.pnl;
  const icon = pnl != null && pnl >= 0 ? '✅' : '❌';
  const label = trade.tokenSymbol
    ? `<b>${escapeHtml(trade.tokenSymbol)}</b>`
    : `<b>${escapeHtml(shortenAddress(trade.pairAddress))}</b>`;
  const shortId = trade.id.slice(0, 8);
  return `${icon} <b>포지션 종료</b> ${label} <code>${escapeHtml(shortId)}</code>`;
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

function formatSizeConstraint(value?: SizeConstraint): string {
  if (!value) return '';
  return SIZE_CONSTRAINT_LABELS[value] ?? value;
}

function formatCloseReason(value?: CloseReason): string {
  if (!value) return '사유 없음';
  return CLOSE_REASON_LABELS[value] ?? value;
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

function buildExitLevelLine(
  label: string,
  entryPrice: number,
  targetPrice: number,
  quantity: number,
  kind: 'stop' | 'take_profit'
): string {
  if (
    !Number.isFinite(entryPrice) || entryPrice <= 0 ||
    !Number.isFinite(targetPrice) || targetPrice <= 0 ||
    !Number.isFinite(quantity) || quantity <= 0
  ) {
    return `- ${label}: 미설정 (유효한 ${kind === 'stop' ? '손절가' : '목표가'} 없음 / 재검토 필요)`;
  }
  const pnlSol = (targetPrice - entryPrice) * quantity;
  const pnlPct = entryPrice > 0 ? (targetPrice - entryPrice) / entryPrice : null;
  const reviewNeeded = kind === 'stop'
    ? !(targetPrice > 0 && targetPrice < entryPrice)
    : !(targetPrice > entryPrice);
  // Why: percentage를 앞에 두면 "손익 방향"이 한 눈에 들어옴 (price는 부가 정보).
  return [
    `- ${label}: `,
    pnlPct != null ? formatSignedPercent(pnlPct) : '—',
    ` · ${formatSignedSolDetailed(pnlSol)}`,
    ` @ ${targetPrice.toFixed(8)}`,
    reviewNeeded ? ' · 재검토 필요' : '',
  ].join('');
}

function formatSignedSolDetailed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(6)} SOL`;
}
