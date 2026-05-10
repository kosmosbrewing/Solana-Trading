import { Pm2ProcessStatus } from './pm2Service';
import { Pm2HealthSummary } from './pm2Health';
import { listProcessAliases } from './telegramControlPolicy';

const TELEGRAM_LIMIT = 4000;

export function formatHelpMessage(allowedProcesses: string[]): string {
  const processes = allowedProcesses
    .map((name) => `<code>${escapeHtml(listProcessAliases(name).join('/'))}</code>`)
    .join(', ');
  return [
    '<b>Ops 명령어</b>',
    '<code>/status</code> 상태 요약',
    '<code>/list</code> 상태 요약',
    '<code>/health</code> 가용성 상태 점검',
    '<code>/report</code> 최근 운영 heartbeat 조회',
    '<code>/heartbeat</code> 최근 운영 heartbeat 조회',
    '<code>/restart &lt;name|alias&gt;</code> ecosystem config 재적용 후 재시작',
    '<code>/stop &lt;name|alias&gt;</code> 프로세스 중지',
    '<code>/logs &lt;name|alias&gt;</code> 최근 로그 30줄',
    `대상 프로세스: ${processes}`,
  ].join('\n');
}

export function formatStatusMessage(processes: Pm2ProcessStatus[]): string {
  if (processes.length === 0) {
    return '<b>PM2 상태</b>\n등록된 프로세스가 없다.';
  }

  const lines = processes
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((process) => {
      const uptime = process.uptimeMs == null ? 'n/a' : formatDuration(process.uptimeMs);
      const pid = process.pid == null ? 'n/a' : String(process.pid);
      const aliases = listProcessAliases(process.name).slice(1);
      const icon = iconForStatus(process.status);
      const statusLabel = formatProcessStatus(process.status);
      const title = aliases.length > 0
        ? `<b>${escapeHtml(process.name)}</b> <code>(${escapeHtml(aliases.join(', '))})</code>`
        : `<b>${escapeHtml(process.name)}</b>`;
      return [
        `${icon} ${title}`,
        `상태 ${escapeHtml(statusLabel)} | pid ${pid} | 재시작 ${process.restarts}회 | CPU ${process.cpuPct}% | 메모리 ${escapeHtml(formatMemory(process))} | 가동 ${uptime}`,
      ].join(' ');
    });

  return ['<b>PM2 상태</b>', ...lines].join('\n');
}

export function formatActionMessage(action: string, processName: string, output: string): string {
  return [
    `<b>${escapeHtml(action.toUpperCase())} 완료</b> <code>${escapeHtml(processName)}</code>`,
    `<pre>${escapeHtml(truncateText(output || 'No output', 3400))}</pre>`,
  ].join('\n');
}

export function formatLogsMessage(processName: string, output: string): string {
  return [
    `<b>최근 로그</b> <code>${escapeHtml(processName)}</code>`,
    `<pre>${escapeHtml(truncateText(output || 'No logs', 3400))}</pre>`,
  ].join('\n');
}

export function formatErrorMessage(message: string): string {
  return trimTelegramMessage(`<b>ERROR</b>\n${escapeHtml(message)}`);
}

export function formatHealthMessage(summary: Pm2HealthSummary): string {
  const lines = summary.processes
    .sort((a, b) => a.process.name.localeCompare(b.process.name))
    .map((entry) => {
      const aliases = listProcessAliases(entry.process.name).slice(1);
      const label = aliases.length > 0
        ? `${entry.process.name} (${aliases.join(', ')})`
        : entry.process.name;
      const reasons = entry.reasons.length > 0 ? ` | ${entry.reasons.join(', ')}` : '';
      return `${iconForLevel(entry.level)} <code>${escapeHtml(label)}</code> ${escapeHtml(formatHealthLevel(entry.level))}${escapeHtml(reasons)}`;
    });

  return trimTelegramMessage([
    `<b>PM2 헬스</b> ${iconForLevel(summary.overall)} <b>${escapeHtml(formatHealthLevel(summary.overall))}</b>`,
    ...lines,
  ].join('\n'));
}

function trimTelegramMessage(message: string): string {
  if (message.length <= TELEGRAM_LIMIT) return message;
  return `${message.slice(0, TELEGRAM_LIMIT - 15)}\n...<i>truncated</i>`;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

function formatMemory(process: Pm2ProcessStatus): string {
  if (process.maxMemoryMb == null || process.maxMemoryMb <= 0) return `${process.memoryMb}MB`;
  const ratio = Math.round((process.memoryMb / process.maxMemoryMb) * 100);
  return `${process.memoryMb}MB/${process.maxMemoryMb}MB (${ratio}%)`;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 13)}\n...truncated`;
}

function iconForLevel(level: 'healthy' | 'degraded' | 'down'): string {
  switch (level) {
    case 'healthy':
      return '🟢';
    case 'degraded':
      return '🟡';
    case 'down':
      return '🔴';
  }
}

function iconForStatus(status: string): string {
  return status === 'online' ? '🟢' : status === 'stopped' ? '🟡' : '🔴';
}

function formatProcessStatus(status: string): string {
  switch (status) {
    case 'online':
      return '정상';
    case 'stopped':
      return '중지';
    case 'errored':
      return '오류';
    default:
      return status;
  }
}

function formatHealthLevel(level: 'healthy' | 'degraded' | 'down'): string {
  switch (level) {
    case 'healthy':
      return '정상';
    case 'degraded':
      return '주의';
    case 'down':
      return '다운';
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
