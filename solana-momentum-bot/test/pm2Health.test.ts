import { buildPm2HealthSummary, evaluateProcessHealth } from '../src/ops/pm2Health';
import { Pm2ProcessStatus } from '../src/ops/pm2Service';

function buildProcess(overrides: Partial<Pm2ProcessStatus> = {}): Pm2ProcessStatus {
  return {
    name: 'momentum-bot',
    status: 'online',
    pid: 1234,
    restarts: 0,
    cpuPct: 1,
    memoryMb: 64,
    maxMemoryMb: 1536,
    uptimeMs: 60_000,
    ...overrides,
  };
}

describe('pm2Health', () => {
  test('marks online process as healthy', () => {
    expect(evaluateProcessHealth(buildProcess()).level).toBe('healthy');
  });

  test('marks restarted process as degraded', () => {
    const health = evaluateProcessHealth(buildProcess({ restarts: 2, uptimeMs: 5_000 }));
    expect(health.level).toBe('degraded');
    expect(health.reasons).toContain('recent restart x2');
  });

  test('marks offline process as down', () => {
    const health = evaluateProcessHealth(buildProcess({ status: 'stopped', pid: null }));
    expect(health.level).toBe('down');
  });

  test('marks near-memory-limit process as degraded', () => {
    const health = evaluateProcessHealth(buildProcess({ memoryMb: 1300, maxMemoryMb: 1536 }));
    expect(health.level).toBe('degraded');
    expect(health.reasons).toContain('memory 1300MB/1536MB (85%)');
  });

  test('builds down overall state when one process is down', () => {
    const summary = buildPm2HealthSummary([
      buildProcess(),
      buildProcess({ name: 'momentum-shadow', status: 'errored', pid: null }),
    ]);
    expect(summary.overall).toBe('down');
  });
});
