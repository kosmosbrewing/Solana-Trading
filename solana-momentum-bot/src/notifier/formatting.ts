export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

export function formatKstDate(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return String(value);
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const lookup = new Map(parts.map((part) => [part.type, part.value]));

  return `${lookup.get('year')}-${lookup.get('month')}-${lookup.get('day')}`;
}

export function formatKstDateTimeLabel(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return String(value);
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const lookup = new Map(parts.map((part) => [part.type, part.value]));

  return [
    `${lookup.get('year')}-${lookup.get('month')}-${lookup.get('day')}`,
    `${lookup.get('hour')}:${lookup.get('minute')}:${lookup.get('second')} KST`,
  ].join(' ');
}

export function formatCompactUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return formatCompactNumber(value / 1_000_000_000, 'B');
  if (abs >= 1_000_000) return formatCompactNumber(value / 1_000_000, 'M');
  if (abs >= 1_000) return formatCompactNumber(value / 1_000, 'K');
  return value.toFixed(0);
}

export function formatKstDateTime(unixSec: number): string {
  if (!Number.isFinite(unixSec)) return String(unixSec);
  const date = new Date(unixSec * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const lookup = new Map(parts.map((part) => [part.type, part.value]));
  const centiseconds = Math.floor(date.getUTCMilliseconds() / 10);
  return [
    `${lookup.get('year')}-${lookup.get('month')}-${lookup.get('day')}`,
    `${lookup.get('hour')}:${lookup.get('minute')}:${lookup.get('second')}.${String(centiseconds).padStart(2, '0')}`,
  ].join(' ');
}

export function formatIntervalSeconds(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value % 3600 === 0) return `${value / 3600}h`;
  if (value % 60 === 0) return `${value / 60}m`;
  return `${value}s`;
}

function formatCompactNumber(value: number, suffix: string): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return `${trimTrailingZeros(value.toFixed(digits))}${suffix}`;
}

function trimTrailingZeros(value: string): string {
  return value.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}
