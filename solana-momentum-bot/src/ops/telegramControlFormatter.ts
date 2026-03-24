import { Pm2ProcessStatus } from './pm2Service';

const TELEGRAM_LIMIT = 4000;

export function formatHelpMessage(allowedProcesses: string[]): string {
  const processes = allowedProcesses.map((name) => `<code>${escapeHtml(name)}</code>`).join(', ');
  return [
    '<b>PM2 Control Commands</b>',
    '<code>/status</code> 상태 요약',
    '<code>/list</code> 상태 요약',
    '<code>/restart &lt;name&gt;</code> 프로세스 재시작',
    '<code>/stop &lt;name&gt;</code> 프로세스 중지',
    '<code>/logs &lt;name&gt;</code> 최근 로그 30줄',
    `Allowed: ${processes}`,
  ].join('\n');
}

export function formatStatusMessage(processes: Pm2ProcessStatus[]): string {
  if (processes.length === 0) {
    return '<b>PM2 Status</b>\n등록된 프로세스가 없다.';
  }

  const lines = processes
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((process) => {
      const uptime = process.uptimeMs == null ? 'n/a' : formatDuration(process.uptimeMs);
      const pid = process.pid == null ? 'n/a' : String(process.pid);
      return [
        `<b>${escapeHtml(process.name)}</b>`,
        `status=${escapeHtml(process.status)}`,
        `pid=${pid}`,
        `restarts=${process.restarts}`,
        `cpu=${process.cpuPct}%`,
        `mem=${process.memoryMb}MB`,
        `uptime=${uptime}`,
      ].join(' ');
    });

  return ['<b>PM2 Status</b>', ...lines].join('\n');
}

export function formatActionMessage(action: string, processName: string, output: string): string {
  return [
    `<b>${escapeHtml(action.toUpperCase())}</b> <code>${escapeHtml(processName)}</code>`,
    `<pre>${escapeHtml(truncateText(output || 'No output', 3400))}</pre>`,
  ].join('\n');
}

export function formatLogsMessage(processName: string, output: string): string {
  return [
    `<b>LOGS</b> <code>${escapeHtml(processName)}</code>`,
    `<pre>${escapeHtml(truncateText(output || 'No logs', 3400))}</pre>`,
  ].join('\n');
}

export function formatErrorMessage(message: string): string {
  return trimTelegramMessage(`<b>ERROR</b>\n${escapeHtml(message)}`);
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

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 13)}\n...truncated`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
