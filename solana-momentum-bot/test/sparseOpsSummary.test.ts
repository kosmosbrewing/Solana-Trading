import fs from 'fs';
import os from 'os';
import path from 'path';
import { mkdtempSync } from 'fs';
import { buildSparseOpsSummaryMessage, loadSparseOpsSummary } from '../src/reporting/sparseOpsSummary';

describe('sparseOpsSummary', () => {
  it('builds a compact operator-friendly sparse summary', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'sparse-ops-'));
    const sessionDir = path.join(root, 'sessions', 'session-1');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'current-session.json'), JSON.stringify({
      datasetDir: sessionDir,
      startedAt: '2026-04-05T05:24:58.037Z',
    }));
    fs.writeFileSync(path.join(root, 'runtime-diagnostics.json'), JSON.stringify({
      events: [
        { type: 'trigger_stats', timestampMs: Date.parse('2026-04-05T06:10:30.119Z'), detail: 'evals=9843 signals=0(sparse=0 boosted=0) insuffCandles=28 volInsuf=83 sparseInsuf=9758 lowBuyRatio=2 cooldown=0' },
        { type: 'alias_miss', timestampMs: Date.parse('2026-04-05T06:00:00.000Z'), reason: 'AhuQ6rsnPLbQEXmYwLwWxMmPoc8ZsFwwSxAUym6RKtta' },
        { type: 'alias_miss', timestampMs: Date.parse('2026-04-05T06:00:01.000Z'), reason: 'AhuQ6rsnPLbQEXmYwLwWxMmPoc8ZsFwwSxAUym6RKtta' },
        { type: 'alias_miss', timestampMs: Date.parse('2026-04-05T06:00:02.000Z'), reason: '7Ccf3PNRT5SByzdRE3XiHyptqcDY8c3iDzvBMUGDNzVe' },
        { type: 'candidate_evicted', timestampMs: Date.parse('2026-04-05T06:05:00.000Z'), tokenMint: 'idle-token-1', reason: 'idle', detail: 'idleSec=640|immediate=true' },
        { type: 'candidate_evicted', timestampMs: Date.parse('2026-04-05T06:05:01.000Z'), tokenMint: 'idle-token-1', reason: 'idle', detail: 'idleSec=601|immediate=true' },
        { type: 'candidate_evicted', timestampMs: Date.parse('2026-04-05T06:05:02.000Z'), tokenMint: 'score-token-1', reason: 'score', detail: 'score=42' },
      ],
    }));
    fs.writeFileSync(path.join(sessionDir, 'realtime-signals.jsonl'), '');

    const summary = loadSparseOpsSummary(root, 4, 2);
    const message = buildSparseOpsSummaryMessage(summary);

    expect(message).toContain('희박 거래 점검 (4h)');
    expect(message).toContain('- 신호 0건 | 실제 진입 0건 | 진단 이벤트 7건');
    expect(message).toContain('- 트리거: 평가 9843회 | 신호 0건 | 희박 데이터 부족 9758회 | sparse 신호 0건 | 부스트 0건');
    expect(message).toContain('- 판단: 희박 거래 데이터 부족이 우세함');
    expect(message).toContain('AhuQ6rsn...Ktta 2건');
    expect(message).toContain('7Ccf3PNR...NzVe 1건');
    expect(message).toContain('idle_evicted=2');
    expect(message).toContain('top idle-evicted tickers: idle-token-1 2건');
  });
});
