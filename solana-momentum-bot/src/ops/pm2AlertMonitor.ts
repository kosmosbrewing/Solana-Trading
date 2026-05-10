import { Notifier } from '../notifier';
import { createModuleLogger } from '../utils/logger';
import { Pm2ProcessStatus, Pm2Service } from './pm2Service';

const log = createModuleLogger('Pm2AlertMonitor');
const MONITOR_INTERVAL_MS = 60_000;
const MANUAL_ACTION_SUPPRESS_MS = 120_000;
const MEMORY_WARNING_RATIO = 0.85;
const MEMORY_CRITICAL_RATIO = 0.95;

interface SnapshotEntry {
  status: string;
  restarts: number;
  memoryPressure: MemoryPressureLevel;
}

type MemoryPressureLevel = 'normal' | 'warning' | 'critical';

export class Pm2AlertMonitor {
  private lastCheckedAt = 0;
  private snapshot = new Map<string, SnapshotEntry>();
  private manualActionSuppressUntil = new Map<string, number>();

  constructor(
    private pm2Service: Pm2Service,
    private notifier: Notifier,
    private allowedProcesses: string[]
  ) {}

  async initialize(): Promise<void> {
    try {
      this.snapshot = this.buildSnapshot(await this.fetchProcesses());
    } catch (error) {
      log.warn(`Initial PM2 snapshot failed: ${error}`);
    }
  }

  markManualAction(processName: string): void {
    this.manualActionSuppressUntil.set(processName, Date.now() + MANUAL_ACTION_SUPPRESS_MS);
  }

  async tick(): Promise<void> {
    if (Date.now() - this.lastCheckedAt < MONITOR_INTERVAL_MS) return;
    this.lastCheckedAt = Date.now();

    const processes = await this.fetchProcesses();
    const nextSnapshot = this.buildSnapshot(processes);

    for (const process of processes) {
      const previous = this.snapshot.get(process.name);
      const suppressed = this.isSuppressed(process.name);
      if (!previous) continue;

      if (!suppressed && previous.status !== process.status) {
        await this.notifyStatusChange(previous.status, process);
      }

      if (!suppressed && process.restarts > previous.restarts) {
        const delta = process.restarts - previous.restarts;
        await this.notifier.sendWarning(
          `PM2 Restart ${process.name}`,
          `${process.name} restarted ${delta} time(s) | status=${process.status} | uptime=${formatUptime(process.uptimeMs)} | memory=${formatMemory(process)}`
        );
      }

      if (!suppressed && shouldNotifyMemoryPressure(previous.memoryPressure, process)) {
        const nextPressure = evaluateMemoryPressure(process);
        const title = nextPressure === 'critical' ? `PM2 Memory Critical ${process.name}` : `PM2 Memory Warning ${process.name}`;
        const body = `${process.name} memory=${formatMemory(process)} | status=${process.status} | uptime=${formatUptime(process.uptimeMs)}`;
        if (nextPressure === 'critical') {
          await this.notifier.sendCritical(title, body);
        } else {
          await this.notifier.sendWarning(title, body);
        }
      }
    }

    for (const processName of this.snapshot.keys()) {
      if (!nextSnapshot.has(processName) && !this.isSuppressed(processName)) {
        await this.notifier.sendCritical(`PM2 Missing ${processName}`, `${processName} is missing from pm2 status output`);
      }
    }

    this.snapshot = nextSnapshot;
  }

  private async fetchProcesses(): Promise<Pm2ProcessStatus[]> {
    return (await this.pm2Service.listProcesses())
      .filter((process) => this.allowedProcesses.includes(process.name));
  }

  private buildSnapshot(processes: Pm2ProcessStatus[]): Map<string, SnapshotEntry> {
    return new Map(processes.map((process) => [
      process.name,
      { status: process.status, restarts: process.restarts, memoryPressure: evaluateMemoryPressure(process) },
    ]));
  }

  private async notifyStatusChange(previousStatus: string, process: Pm2ProcessStatus): Promise<void> {
    if (process.status === 'online') {
      await this.notifier.sendMessage(
        `🟢 PM2 recovery: <code>${process.name}</code> ${previousStatus} -> online | uptime=${formatUptime(process.uptimeMs)}`
      );
      return;
    }

    await this.notifier.sendCritical(
      `PM2 Status ${process.name}`,
      `${process.name} changed ${previousStatus} -> ${process.status}`
    );
  }

  private isSuppressed(processName: string): boolean {
    const suppressedUntil = this.manualActionSuppressUntil.get(processName) || 0;
    return suppressedUntil > Date.now();
  }
}

function formatUptime(uptimeMs: number | null): string {
  if (uptimeMs == null) return 'n/a';
  const totalSeconds = Math.max(0, Math.floor(uptimeMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function shouldNotifyMemoryPressure(previous: MemoryPressureLevel, process: Pm2ProcessStatus): boolean {
  const next = evaluateMemoryPressure(process);
  if (next === 'normal') return false;
  return memoryPressureRank(next) > memoryPressureRank(previous);
}

function evaluateMemoryPressure(process: Pm2ProcessStatus): MemoryPressureLevel {
  if (process.maxMemoryMb == null || process.maxMemoryMb <= 0) return 'normal';
  const ratio = process.memoryMb / process.maxMemoryMb;
  if (ratio >= MEMORY_CRITICAL_RATIO) return 'critical';
  if (ratio >= MEMORY_WARNING_RATIO) return 'warning';
  return 'normal';
}

function memoryPressureRank(level: MemoryPressureLevel): number {
  switch (level) {
    case 'normal':
      return 0;
    case 'warning':
      return 1;
    case 'critical':
      return 2;
  }
}

function formatMemory(process: Pm2ProcessStatus): string {
  if (process.maxMemoryMb == null || process.maxMemoryMb <= 0) return `${process.memoryMb}MB`;
  const ratio = Math.round((process.memoryMb / process.maxMemoryMb) * 100);
  return `${process.memoryMb}MB/${process.maxMemoryMb}MB (${ratio}%)`;
}
