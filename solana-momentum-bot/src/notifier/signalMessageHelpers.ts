import { Signal } from '../utils/types';
import {
  formatCompactUsd,
  formatIntervalSeconds,
  formatKstDateTime,
  formatPercent,
} from './formatting';

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
  volumeMcapRatio: '24H 거래대금 / 시총',
  mevMarginPct: 'MEV 여유폭',
  highestHigh: '직전 돌파 고가',
  confirmPriceChangePct: '확인 봉 상승률',
  confirmBullishBars: '확인 양봉 수',
  atr: 'ATR',
};

const SUMMARY_META_KEYS = new Set([
  'ammFeePct',
  'avgVolume',
  'confirmIntervalSec',
  'currentVolume',
  'currentVolume24hUsd',
  'marketCapUsd',
  'volumeMcapRatio',
  'primaryCandleCloseSec',
  'primaryCandleStartSec',
  'primaryIntervalSec',
  'realtimeSignal',
]);
const COMPACT_USD_META_KEYS = new Set(['avgVolume', 'currentVolume', 'currentVolume24hUsd']);
const PERCENT_META_KEYS = new Set(['confirmPriceChangePct', 'mevMarginPct', 'spreadPct', 'top10HolderPct', 'volumeMcapRatio']);
const PRICE_META_KEYS = new Set(['highestHigh']);

export function buildSignalSummaryLines(signal: Signal): string[] {
  const lines = [
    buildMarketSummaryLine(signal),
    buildVolumeSummaryLine(signal),
    buildCostSummaryLine(signal),
  ];
  return lines.filter(Boolean);
}

export function buildSignalDetailLines(signal: Signal): string[] {
  const lines = [
    buildIntervalSummaryLine(signal),
    buildCandleWindowLine(signal),
    buildFlowSummaryLine(signal),
    ...Object.entries(signal.meta)
      .filter(([key]) => !SUMMARY_META_KEYS.has(key))
      .map(([key, value]) => `- ${formatMetaLabel(key)}: ${formatMetricValue(key, value)}`),
  ];
  return lines.filter(Boolean);
}

function buildMarketSummaryLine(signal: Signal): string {
  const marketCap = signal.meta.marketCapUsd;
  if (marketCap == null && signal.poolTvl == null) return '';
  if (marketCap != null && signal.poolTvl != null) {
    return `- MC / TVL: $${formatCompactUsd(marketCap)} / $${formatCompactUsd(signal.poolTvl)}`;
  }
  if (marketCap != null) return `- MC: $${formatCompactUsd(marketCap)}`;
  return `- TVL: $${formatCompactUsd(signal.poolTvl!)}`;
}

function buildVolumeSummaryLine(signal: Signal): string {
  const volume24h = signal.meta.currentVolume24hUsd;
  const volumeMcapRatio = signal.meta.volumeMcapRatio;
  if (volume24h != null && volumeMcapRatio != null) {
    return `- 24H 거래대금 / 시총: $${formatCompactUsd(volume24h)} / ${formatPercent(volumeMcapRatio)}`;
  }
  return volume24h != null ? `- 24H 거래대금: $${formatCompactUsd(volume24h)}` : '';
}

function buildCostSummaryLine(signal: Signal): string {
  const spread = signal.spreadPct != null ? formatPercent(signal.spreadPct) : null;
  const fee = signal.meta.ammFeePct != null ? formatPercent(signal.meta.ammFeePct) : null;
  if (spread && fee) return `- 스프레드 / AMM 수수료: ${spread} / ${fee}`;
  if (spread) return `- 스프레드: ${spread}`;
  if (fee) return `- AMM 수수료: ${fee}`;
  return '';
}

function buildIntervalSummaryLine(signal: Signal): string {
  const primary = signal.meta.primaryIntervalSec;
  const confirm = signal.meta.confirmIntervalSec;
  if (primary == null && confirm == null) return '';
  if (primary != null && confirm != null) {
    return `- 메인 봉 / 확인 봉: ${formatIntervalSeconds(primary)} / ${formatIntervalSeconds(confirm)}`;
  }
  if (primary != null) return `- 메인 봉: ${formatIntervalSeconds(primary)}`;
  return `- 확인 봉: ${formatIntervalSeconds(confirm!)}`;
}

function buildCandleWindowLine(signal: Signal): string {
  const start = signal.meta.primaryCandleStartSec;
  const close = signal.meta.primaryCandleCloseSec;
  if (start == null && close == null) return '';
  if (start != null && close != null) {
    return `- 캔들: ${formatKstDateTime(start)} → ${formatKstDateTime(close)}`;
  }
  return start != null ? `- Candle Start: ${formatKstDateTime(start)}` : `- Candle Close: ${formatKstDateTime(close!)}`;
}

function buildFlowSummaryLine(signal: Signal): string {
  const avgVolume = signal.meta.avgVolume;
  const currentVolume = signal.meta.currentVolume;
  if (avgVolume == null && currentVolume == null) return '';
  if (avgVolume != null && currentVolume != null) {
    return `- 평균 / 현재 거래량: $${formatCompactUsd(avgVolume)} / $${formatCompactUsd(currentVolume)}`;
  }
  if (avgVolume != null) return `- Avg Volume: $${formatCompactUsd(avgVolume)}`;
  return `- Current Volume: $${formatCompactUsd(currentVolume!)}`;
}

function formatMetaLabel(key: string): string {
  return META_LABELS[key] ?? startCase(key);
}

function formatMetricValue(key: string, value: number): string {
  if (!Number.isFinite(value)) return 'N/A';
  if (COMPACT_USD_META_KEYS.has(key)) return `$${formatCompactUsd(value)}`;
  if (PERCENT_META_KEYS.has(key)) return formatPercent(value);
  if (PRICE_META_KEYS.has(key)) return value.toFixed(8);
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}

function startCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
