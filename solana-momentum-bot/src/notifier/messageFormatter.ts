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
  const pnl = trade.pnl;
  const pnlPct = calculatePnlPct(trade);
  const duration = trade.closedAt ? formatShortDuration(trade.closedAt.getTime() - trade.createdAt.getTime()) : '';
  const resultLabel = pnl == null ? '결과 미정' : pnl >= 0 ? '이익 실현' : '손실 확정';
  const shortId = trade.id.slice(0, 8);
  const reasonText = formatCloseReason(trade.exitReason);
  const particle = koreanRoParticle(reasonText);
  const reasonLine = [
    `${reasonText}${particle} 종료`,
    duration ? `보유 ${duration}` : '',
  ].filter(Boolean).join(' · ');
  const pnlLine = buildCloseProfitLine(trade, pnl, pnlPct);
  const priceLine = buildClosePriceLine(trade);
  const gapLine = buildExitGapLine(trade);
  const costLine = buildCostSummaryLine(trade);
  const headline = buildCloseHeadline(trade, pnl, resultLabel, shortId);

  return [
    headline,
    `- 전략: ${escapeHtml(formatStrategy(trade.strategy))}`,
    `- 사유: ${escapeHtml(reasonLine)}`,
    pnlLine,
    priceLine,
    costLine,
    gapLine,
    `- 컨트랙트: <code>${escapeHtml(trade.pairAddress)}</code>`,
    trade.txSignature ? `- tx: <code>${escapeHtml(trade.txSignature)}</code>` : '',
  ].filter(Boolean).join('\n');
}

function buildCloseHeadline(
  trade: Trade,
  pnl: number | undefined,
  resultLabel: string,
  shortId: string
): string {
  const icon = pnl != null && pnl >= 0 ? '✅' : '❌';
  const label = trade.tokenSymbol
    ? `<b>${escapeHtml(trade.tokenSymbol)}</b>`
    : `<b>${escapeHtml(shortenAddress(trade.pairAddress))}</b> (ticker 미확인)`;
  return `${icon} <b>포지션 종료</b> ${label} <code>${escapeHtml(shortId)}</code> · ${resultLabel}`;
}

function buildCloseProfitLine(trade: Trade, pnl: number | undefined, pnlPct: number | null): string {
  const pnlText = `${formatSignedSol(pnl)}${pnlPct != null ? ` (${formatSignedPercent(pnlPct)})` : ''}`;
  const slippageText = trade.slippage != null ? ` · 슬리피지 ${formatPercent(trade.slippage)}` : '';
  return `- 실현 손익: ${pnlText}${slippageText}`;
}

function buildClosePriceLine(trade: Trade): string {
  const exit = trade.exitPrice != null ? trade.exitPrice.toFixed(8) : 'N/A';
  return `- 가격: ${trade.entryPrice.toFixed(8)} → ${exit}`;
}

function buildExitGapLine(trade: Trade): string {
  if (trade.decisionPrice == null || trade.exitPrice == null || trade.decisionPrice <= 0) return '';
  const gapPct = ((trade.exitPrice - trade.decisionPrice) / trade.decisionPrice) * 100;
  if (Math.abs(gapPct) < GAP_EPSILON_PCT) return '';
  return `- Exit gap: ${gapPct >= 0 ? '+' : ''}${gapPct.toFixed(2)}% (decision=${trade.decisionPrice.toFixed(8)} → fill=${trade.exitPrice.toFixed(8)})`;
}

function buildCostSummaryLine(trade: Trade): string {
  const parts: string[] = [];
  if (trade.entrySlippageBps != null) parts.push(`entry ${trade.entrySlippageBps}bps`);
  if (trade.exitSlippageBps != null) parts.push(`exit ${trade.exitSlippageBps}bps`);
  if (trade.entryPriceImpactPct != null) parts.push(`impact ${trade.entryPriceImpactPct.toFixed(2)}%`);
  if (trade.roundTripCostPct != null) parts.push(`rtCost ${trade.roundTripCostPct.toFixed(2)}%`);
  if (parts.length === 0) return '';
  return `- 비용: ${parts.join(' · ')}`;
}

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
