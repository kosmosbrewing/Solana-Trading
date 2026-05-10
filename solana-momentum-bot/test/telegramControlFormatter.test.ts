import {
  formatActionMessage,
  formatHealthMessage,
  formatHelpMessage,
  formatLogsMessage,
  formatStatusMessage,
} from '../src/ops/telegramControlFormatter';
import { Pm2HealthSummary } from '../src/ops/pm2Health';
import { Pm2ProcessStatus } from '../src/ops/pm2Service';

describe('telegramControlFormatter', () => {
  it('formats help text with clearer ops wording', () => {
    const message = formatHelpMessage(['momentum-bot', 'momentum-ops-bot']);

    expect(message).toContain('<b>Ops 명령어</b>');
    expect(message).toContain('<code>/report</code> 최근 운영 heartbeat 조회');
    expect(message).toContain('대상 프로세스:');
  });

  it('formats pm2 status with icons and operator-friendly labels', () => {
    const processes: Pm2ProcessStatus[] = [
      {
        name: 'momentum-bot',
        status: 'online',
        pid: 123,
        restarts: 1,
        cpuPct: 12,
        memoryMb: 256,
        maxMemoryMb: 1536,
        uptimeMs: 3_661_000,
      },
    ];

    const message = formatStatusMessage(processes);
    expect(message).toContain('<b>PM2 상태</b>');
    expect(message).toContain('🟢 <b>momentum-bot</b>');
    expect(message).toContain('상태 정상 | pid 123 | 재시작 1회 | CPU 12% | 메모리 256MB/1536MB (17%) | 가동 1h 1m 1s');
  });

  it('formats health and action/log outputs with Korean labels', () => {
    const summary: Pm2HealthSummary = {
      overall: 'degraded',
      processes: [
        {
          process: {
            name: 'momentum-ops-bot',
            status: 'online',
            pid: 456,
            restarts: 2,
            cpuPct: 5,
            memoryMb: 64,
            maxMemoryMb: 256,
            uptimeMs: 120_000,
          },
          level: 'degraded',
          reasons: ['recent restart x2'],
        },
      ],
    };

    expect(formatHealthMessage(summary)).toContain('<b>PM2 헬스</b> 🟡 <b>주의</b>');
    expect(formatHealthMessage(summary)).toContain('🟡 <code>momentum-ops-bot');
    expect(formatActionMessage('restart', 'momentum-bot', 'done')).toContain('<b>RESTART 완료</b>');
    expect(formatLogsMessage('momentum-bot', 'line1')).toContain('<b>최근 로그</b>');
  });
});
