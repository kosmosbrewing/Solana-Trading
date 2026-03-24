import { Notifier } from '../notifier';
import { createModuleLogger } from '../utils/logger';
import { Pm2ProcessStatus, Pm2Service } from './pm2Service';

const log = createModuleLogger('Pm2AlertMonitor');
const MONITOR_INTERVAL_MS = 60_000;
const MANUAL_ACTION_SUPPRESS_MS = 120_000;

interface SnapshotEntry {
  status: string;
  restarts: number;
}

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
          `${process.name} restarted ${delta} time(s) | status=${process.status} | uptime=${formatUptime(process.uptimeMs)}`
        );
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
      { status: process.status, restarts: process.restarts },
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
