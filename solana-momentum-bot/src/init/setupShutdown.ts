// Graceful shutdown 등록 — SIGINT / SIGTERM 핸들러.
// main() 에서 만든 모든 long-lived 핸들/스토어를 ShutdownContext 한 객체로 받아 단계별 stop.
//
// Why: 17개 변수가 main() local closure 에 흩어져 있어 readability 가 무너졌었음.
// context 형태로 묶어 lifecycle 관리 책임을 한 곳에 집중.

import { Pool } from 'pg';
import type { Notifier } from '../notifier';
import type { Ingester } from '../ingester';
import type { EventMonitor } from '../event';
import type { UniverseEngine } from '../universe';
import type { ScannerEngine } from '../scanner';
import type {
  HeliusPoolDiscovery,
  HeliusWSIngester,
  MicroCandleBuilder,
  ReplayWarmSync,
  RealtimeAdmissionTracker,
  RealtimeAdmissionStore,
} from '../realtime';
import type { RuntimeDiagnosticsTracker } from '../reporting';
import type { ExecutionLock } from '../state';
import type { HealthMonitor } from '../utils/healthMonitor';
import { stopWalletStopGuardPoller } from '../risk/walletStopGuard';
import { stopWalletDeltaComparator } from '../risk/walletDeltaComparator';
import { stopJupiter429SummaryLoop } from '../observability/jupiterRateLimitMetric';
import { stopKolHunter } from '../orchestration/kolSignalHandler';
import { stopKolPaperNotifier } from '../orchestration/kolPaperNotifier';
import { stopKolDbWatcher } from '../kol/db';
import { createModuleLogger } from '../utils/logger';
import type { MonitoringHandles } from './monitoringLoops';

const log = createModuleLogger('Shutdown');

export interface ShutdownContext {
  monitoringHandles: MonitoringHandles;
  pendingAliasCleanups: Map<string, { timer: NodeJS.Timeout; poolAddress: string }>;
  realtimeAdmissionTracker: RealtimeAdmissionTracker | null;
  realtimeAdmissionStore: RealtimeAdmissionStore | null;
  runtimeDiagnosticsTracker: RuntimeDiagnosticsTracker;
  ingester: Ingester;
  eventMonitor: EventMonitor;
  universeEngine: UniverseEngine;
  scanner: ScannerEngine | null;
  replayWarmSync: ReplayWarmSync | null;
  realtimeCandleBuilder: MicroCandleBuilder | null;
  heliusPoolDiscovery: HeliusPoolDiscovery | null;
  heliusIngester: HeliusWSIngester | null;
  executionLock: ExecutionLock;
  healthMonitor: HealthMonitor;
  kolTracker: { stop: () => Promise<void> } | null;
  dbPool: Pool;
  notifier?: Notifier;  // unused but kept for symmetry / future hooks
}

export function setupShutdown(c: ShutdownContext): void {
  const shutdown = async () => {
    log.info('Shutting down...');
    clearInterval(c.monitoringHandles.positionCheckInterval);
    clearInterval(c.monitoringHandles.regimeInterval);
    clearInterval(c.monitoringHandles.pruneInterval);
    if (c.monitoringHandles.kolHourlyDigestInterval) {
      clearInterval(c.monitoringHandles.kolHourlyDigestInterval);
    }
    if (c.monitoringHandles.pureWsPaperDigestInterval) {
      clearInterval(c.monitoringHandles.pureWsPaperDigestInterval);
    }
    if (c.monitoringHandles.rotationPaperDigestInterval) {
      clearInterval(c.monitoringHandles.rotationPaperDigestInterval);
    }
    // 2026-04-27: 추가 telemetry/scheduler intervals (이전엔 unstored → leak).
    if (c.monitoringHandles.dailySummaryInterval) {
      clearInterval(c.monitoringHandles.dailySummaryInterval);
    }
    if (c.monitoringHandles.pureWsV2TelemetryInterval) {
      clearInterval(c.monitoringHandles.pureWsV2TelemetryInterval);
    }
    if (c.monitoringHandles.canaryAutoResetInterval) {
      clearInterval(c.monitoringHandles.canaryAutoResetInterval);
    }
    // Why: grace period timer가 shutdown 후 발동하면 stopped ingester 호출 → 에러 방지
    for (const { timer } of c.pendingAliasCleanups.values()) {
      clearTimeout(timer);
    }
    c.pendingAliasCleanups.clear();
    if (c.realtimeAdmissionTracker && c.realtimeAdmissionStore) {
      await c.realtimeAdmissionStore.save(c.realtimeAdmissionTracker.exportSnapshot()).catch((error) => {
        log.warn(`Failed to persist realtime admission snapshot: ${error}`);
      });
    }
    await c.runtimeDiagnosticsTracker.flush().catch((error) => {
      log.warn(`Failed to persist runtime diagnostics snapshot: ${error}`);
    });
    await c.ingester.stop();
    c.eventMonitor.stop();
    c.universeEngine.stop();
    if (c.scanner) c.scanner.stop();
    c.replayWarmSync?.stop();
    if (c.realtimeCandleBuilder) c.realtimeCandleBuilder.stop();
    if (c.heliusPoolDiscovery) await c.heliusPoolDiscovery.stop();
    if (c.heliusIngester) await c.heliusIngester.stop();
    c.executionLock.destroy();
    c.healthMonitor.stop();
    stopWalletStopGuardPoller();
    stopWalletDeltaComparator();
    stopJupiter429SummaryLoop();
    stopKolHunter();
    stopKolPaperNotifier();  // QA fix E: kolHunterEvents listener 해제 (test env hygiene)
    if (c.kolTracker) await c.kolTracker.stop();
    stopKolDbWatcher();
    await c.dbPool.end();
    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
