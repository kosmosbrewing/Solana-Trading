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
  formatDuration,
  formatPercent,
  formatSignedPercent,
  formatSignedSol,
  shortenAddress,
} from './formatting';
import { buildSignalDetailLines, buildSignalSummaryLines } from './signalMessageHelpers';

const STRATEGY_LABELS: Record<StrategyName, string> = {
  volume_spike: 'Volume Spike',
  bootstrap_10s: 'Bootstrap 10s',
  core_momentum: 'Core Momentum',
  fib_pullback: 'Fib Pullback',
  new_lp_sniper: 'New LP Sniper',
  momentum_cascade: 'Momentum Cascade',
};

const CLOSE_REASON_LABELS: Record<CloseReason, string> = {
  DEGRADED_EXIT: '유동성/체결 품질 저하',
  STOP_LOSS: '손절',
  TAKE_PROFIT_1: '1차 익절',
  TAKE_PROFIT_2: '2차 익절',
  TRAILING_STOP: '트레일링 스탑',
  TIME_STOP: '시간 종료',
  EXHAUSTION: '모멘텀 소진',
  EMERGENCY: '긴급 종료',
  MANUAL: '수동 종료',
  RECOVERED_CLOSED: '복구 후 정리',
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

  return [
    `🟢 <b>${escapeHtml(signal.action)} 시그널</b>`,
    buildInstrumentLine(signal.tokenSymbol, signal.pairAddress),
    `- 전략: ${escapeHtml(formatStrategy(signal.strategy))}`,
    `- 컨트랙트: <code>${escapeHtml(signal.pairAddress)}</code>`,
    `- 현재 가격: ${signal.price.toFixed(8)}`,
    `- 품질 점수: ${score}점 (${escapeHtml(formatGrade(grade))})`,
    ...summaryLines,
    detailLines.length > 0 ? '' : '',
    detailLines.length > 0 ? '세부 지표' : '',
    ...detailLines,
  ].filter(Boolean).join('\n');
}

export function buildTradeOpenMessage(order: Order, txSignature?: string): string {
  const entryNotionalSol = order.price * order.quantity;
  return [
    `🟢 <b>포지션 진입 완료</b>`,
    buildInstrumentLine(order.tokenSymbol, order.pairAddress),
    `- 전략: ${escapeHtml(formatStrategy(order.strategy))}`,
    `- 컨트랙트: <code>${escapeHtml(order.pairAddress)}</code>`,
    `- 진입 가격: ${order.price.toFixed(8)}`,
    `- 진입 금액: ${entryNotionalSol.toFixed(6)} SOL`,
    `- 수량: ${order.quantity.toFixed(6)}${order.tokenSymbol ? ` ${escapeHtml(order.tokenSymbol)}` : ''}`,
    buildExitLevelLine('손절', order.price, order.stopLoss, order.quantity, 'stop'),
    buildExitLevelLine('1차 익절', order.price, order.takeProfit1, order.quantity, 'take_profit'),
    buildExitLevelLine('2차 익절', order.price, order.takeProfit2, order.quantity, 'take_profit'),
    `- 포지션 제한: ${escapeHtml(formatSizeConstraint(order.sizeConstraint))}`,
    order.breakoutScore != null
      ? `- 시그널 품질: ${order.breakoutScore}점 (${escapeHtml(formatGrade(order.breakoutGrade ?? 'N/A'))})`
      : '',
    txSignature ? `- 트랜잭션: <code>${escapeHtml(txSignature)}</code>` : '',
  ].filter(Boolean).join('\n');
}

export function buildTradeCloseMessage(trade: Trade): string {
  const pnl = trade.pnl;
  const pnlPct = calculatePnlPct(trade);
  const duration = trade.closedAt ? formatDuration(trade.closedAt.getTime() - trade.createdAt.getTime()) : '';
  const resultLabel = pnl == null ? '결과 미정' : pnl >= 0 ? '이익 실현' : '손실 확정';

  return [
    `${pnl != null && pnl >= 0 ? '✅' : '❌'} <b>포지션 종료</b>`,
    buildInstrumentLine(trade.tokenSymbol, trade.pairAddress),
    `- 전략: ${escapeHtml(formatStrategy(trade.strategy))}`,
    `- 컨트랙트: <code>${escapeHtml(trade.pairAddress)}</code>`,
    `- 종료 사유: ${escapeHtml(formatCloseReason(trade.exitReason))}`,
    `- 결과: ${resultLabel}`,
    `- 가격: ${trade.entryPrice.toFixed(8)} → ${trade.exitPrice?.toFixed(8) ?? 'N/A'}`,
    `- 실현 손익: ${formatSignedSol(pnl)}${pnlPct != null ? ` (${formatSignedPercent(pnlPct)})` : ''}`,
    trade.slippage != null ? `- 슬리피지: ${formatPercent(trade.slippage)}` : '',
    duration ? `- 보유 시간: ${duration}` : '',
    trade.txSignature ? `- 트랜잭션: <code>${escapeHtml(trade.txSignature)}</code>` : '',
  ].filter(Boolean).join('\n');
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
  if (!value) return '제한 정보 없음';
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
  return [
    `- ${label}: ${targetPrice.toFixed(8)} `,
    `(${formatSignedSolDetailed(pnlSol)}`,
    pnlPct != null ? ` / ${formatSignedPercent(pnlPct)}` : '',
    reviewNeeded ? ' / 재검토 필요' : '',
    ')',
  ].join('');
}

function formatSignedSolDetailed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(6)} SOL`;
}
