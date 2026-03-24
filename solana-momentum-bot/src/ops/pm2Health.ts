import { Pm2ProcessStatus } from './pm2Service';

export type HealthLevel = 'healthy' | 'degraded' | 'down';

export interface ProcessHealth {
  process: Pm2ProcessStatus;
  level: HealthLevel;
  reasons: string[];
}

export interface Pm2HealthSummary {
  overall: HealthLevel;
  processes: ProcessHealth[];
}

const RECENT_RESTART_WINDOW_MS = 15 * 60 * 1000;

export function buildPm2HealthSummary(processes: Pm2ProcessStatus[]): Pm2HealthSummary {
  const evaluated = processes.map(evaluateProcessHealth);
  return {
    overall: evaluateOverallHealth(evaluated),
    processes: evaluated,
  };
}

export function evaluateProcessHealth(process: Pm2ProcessStatus): ProcessHealth {
  const reasons: string[] = [];
  let level: HealthLevel = 'healthy';

  if (process.status !== 'online' || process.pid == null) {
    level = 'down';
    reasons.push(`status=${process.status}`);
  }

  if (process.restarts > 0) {
    const reason = process.uptimeMs != null && process.uptimeMs <= RECENT_RESTART_WINDOW_MS
      ? `recent restart x${process.restarts}`
      : `restart count x${process.restarts}`;
    reasons.push(reason);
    if (level === 'healthy') level = 'degraded';
  }

  if (process.memoryMb === 0 && process.status === 'online' && process.uptimeMs != null && process.uptimeMs > 60_000) {
    reasons.push('memory report is 0MB');
    if (level === 'healthy') level = 'degraded';
  }

  return { process, level, reasons };
}

function evaluateOverallHealth(processes: ProcessHealth[]): HealthLevel {
  if (processes.some((process) => process.level === 'down')) return 'down';
  if (processes.some((process) => process.level === 'degraded')) return 'degraded';
  return 'healthy';
}
