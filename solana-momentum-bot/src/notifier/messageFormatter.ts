import { StrategyEdgeStats } from '../reporting';
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
const STRATEGY_LABELS: Record<StrategyName, string> = {
  volume_spike: 'Volume Spike',
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

const META_LABELS: Record<string, string> = {
  buyRatio: '매수 비중',
  buyRatioScore: '매수 비중 점수',
  volumeScore: '거래량 점수',
  volumeRatio: '거래량 배수',
  volumeSpike: '거래량 급증',
  multiTfScore: '멀티 타임프레임 점수',
  whaleScore: '고래 점수',
  lpScore: 'LP 점수',
  totalScore: '총점',
  spreadPct: '스프레드',
  top10HolderPct: '상위 10 보유 비중',
  marketCap: '시가총액',
  marketCapUsd: '시가총액(USD)',
  mcapVolumeScore: '시총/거래량 점수',
  mevMarginPct: 'MEV 여유폭',
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
  const metaLines = Object.entries(signal.meta).map(([key, value]) =>
    `- ${escapeHtml(formatMetaLabel(key))}: ${formatMetricValue(value)}`
  );

  return [
    `🟢 <b>시그널 감지</b>`,
    `- 액션: ${escapeHtml(signal.action)}`,
    `- 전략: ${escapeHtml(formatStrategy(signal.strategy))}`,
    `- 페어: <code>${escapeHtml(signal.pairAddress)}</code>`,
    `- 현재 가격: ${signal.price.toFixed(8)}`,
    `- 점수: ${score}점 (${escapeHtml(formatGrade(grade))})`,
    signal.poolTvl ? `- TVL: $${formatUsd(signal.poolTvl)}` : '',
    signal.spreadPct != null ? `- 스프레드: ${formatPercent(signal.spreadPct)}` : '',
    metaLines.length > 0 ? '' : '',
    metaLines.length > 0 ? '세부 지표' : '',
    ...metaLines,
  ].filter(Boolean).join('\n');
}

export function buildTradeOpenMessage(order: Order, txSignature?: string): string {
  return [
    `🟢 <b>포지션 진입 완료</b>`,
    `- 전략: ${escapeHtml(formatStrategy(order.strategy))}`,
    `- 페어: <code>${escapeHtml(order.pairAddress)}</code>`,
    `- 진입 가격: ${order.price.toFixed(8)}`,
    `- 주문 수량: ${order.quantity.toFixed(6)} SOL`,
    `- 포지션 제한: ${escapeHtml(formatSizeConstraint(order.sizeConstraint))}`,
    `- 손절가: ${order.stopLoss.toFixed(8)}`,
    `- 익절가: 1차 ${order.takeProfit1.toFixed(8)} / 2차 ${order.takeProfit2.toFixed(8)}`,
    order.breakoutScore != null
      ? `- 시그널 점수: ${order.breakoutScore}점 (${escapeHtml(formatGrade(order.breakoutGrade ?? 'N/A'))})`
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
    `- 전략: ${escapeHtml(formatStrategy(trade.strategy))}`,
    `- 페어: <code>${escapeHtml(trade.pairAddress)}</code>`,
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

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function calculatePnlPct(trade: Trade): number | null {
  if (trade.pnl == null) return null;
  const notional = trade.entryPrice * trade.quantity;
  if (!Number.isFinite(notional) || notional <= 0) return null;
  return trade.pnl / notional;
}

function formatMetaLabel(key: string): string {
  return META_LABELS[key] ?? startCase(key);
}

function formatMetricValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
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

function formatUsd(value: number): string {
  return value.toFixed(0);
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatSignedPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}

export function formatSignedSol(value?: number): string {
  if (value == null) return 'N/A';
  return `${value >= 0 ? '+' : ''}${value.toFixed(4)} SOL`;
}

export function formatRewardRisk(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : 'inf';
}

export function shortenAddress(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}...${value.slice(-4)}`;
}

export function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m`;
}

function startCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase());
}
