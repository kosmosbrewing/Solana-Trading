import fs from 'fs';
import os from 'os';
import path from 'path';
import { mkdtempSync } from 'fs';
import {
  buildCohortFunnelBreakdown,
  buildSparseOpsSummaryMessage,
  loadSparseOpsSummary,
  type SparseOpsDiagnosticEvent,
} from '../src/reporting/sparseOpsSummary';

describe('sparseOpsSummary', () => {
  it('compresses normal idle sparse summary for Telegram', () => {
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
        { type: 'cupsey_funnel', timestampMs: Date.parse('2026-04-05T06:01:00.000Z'), detail: 'signals=12 gate_pass=4 stalk=4 entry=1 tx_ok=1 db_ok=1 notif_ok=1 closed=1' },
        { type: 'candidate_evicted', timestampMs: Date.parse('2026-04-05T06:05:00.000Z'), tokenMint: 'idle-token-1', reason: 'idle', detail: 'idleSec=640|immediate=true' },
        { type: 'candidate_evicted', timestampMs: Date.parse('2026-04-05T06:05:01.000Z'), tokenMint: 'idle-token-1', reason: 'idle', detail: 'idleSec=601|immediate=true' },
        { type: 'candidate_evicted', timestampMs: Date.parse('2026-04-05T06:05:02.000Z'), tokenMint: 'score-token-1', reason: 'score', detail: 'score=42' },
        { type: 'admission_skip', timestampMs: Date.parse('2026-04-05T06:06:00.000Z'), reason: 'unsupported_dex' },
        { type: 'admission_skip', timestampMs: Date.parse('2026-04-05T06:06:01.000Z'), reason: 'no_pairs' },
      ],
    }));
    fs.writeFileSync(path.join(sessionDir, 'realtime-signals.jsonl'), '');

    const summary = loadSparseOpsSummary(root, 4, 2);
    const message = buildSparseOpsSummaryMessage(summary);

    expect(message).toContain('희박 거래: 정상 idle (4h)');
    expect(message).toContain('- 신호 0건 → live 0건');
    expect(message).toContain('- 병목: DEX 미지원 / 페어 없음');
    expect(message).not.toContain('- 상태:');
    expect(message).not.toContain('- 판단:');
    expect(message).not.toContain('- 후보:');
    expect(message).not.toContain('진단 이벤트');
    expect(message).not.toContain('alias miss');
    expect(message).not.toContain('Freshness');
    expect(message).not.toContain('Cohort funnel');
  });

  it('expands sparse summary when signals exist but live entries are blocked', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'sparse-ops-active-'));
    const sessionDir = path.join(root, 'sessions', 'session-1');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'current-session.json'), JSON.stringify({
      datasetDir: sessionDir,
      startedAt: '2026-04-05T05:24:58.037Z',
    }));
    fs.writeFileSync(path.join(root, 'runtime-diagnostics.json'), JSON.stringify({
      events: [
        {
          type: 'trigger_stats',
          timestampMs: Date.parse('2026-04-05T06:10:30.119Z'),
          detail: 'evals=100 signals=1(sparse=0 boosted=0) insuffCandles=0 volInsuf=0 sparseInsuf=0 lowBuyRatio=0 cooldown=0 idleSkip=0 activePairs=3 sparsePairs=1',
        },
        { type: 'admission_skip', timestampMs: Date.parse('2026-04-05T06:06:00.000Z'), reason: 'unsupported_dex' },
        { type: 'admission_skip', timestampMs: Date.parse('2026-04-05T06:06:01.000Z'), reason: 'no_pairs' },
      ],
    }));
    fs.writeFileSync(path.join(sessionDir, 'realtime-signals.jsonl'), [
      JSON.stringify({ id: 's1', timestamp: '2026-04-05T06:09:00.000Z', status: 'rejected' }),
    ].join('\n') + '\n');

    const summary = loadSparseOpsSummary(root, 4, 2);
    const message = buildSparseOpsSummaryMessage(summary);

    expect(message).toContain('희박 거래: 진입 없음 (4h)');
    expect(message).toContain('- 상태: 활성 pair 3 · sparse pair 1');
    expect(message).toContain('- 병목: unsupported_dex 1, no_pairs 1');
    expect(message).toContain('- 후보: seen 0 · admSkip 2 · idleEvict 0');
  });

  it('partitions cohort funnel counts by cohort label and stage', () => {
    // Why: Phase 1 의 핵심 관측 축 — fresh cohort 가 어느 funnel stage 에서
    //      떨어지는지 숫자로 보이는지 검증한다.
    const events: SparseOpsDiagnosticEvent[] = [
      // fresh: 2 seen, 1 admission skip, 1 evict
      { type: 'realtime_candidate_seen', tokenMint: 'tok-f1', cohort: 'fresh' },
      { type: 'realtime_candidate_seen', tokenMint: 'tok-f2', cohort: 'fresh' },
      { type: 'admission_skip', tokenMint: 'tok-f1', reason: 'no_pairs', cohort: 'fresh' },
      { type: 'candidate_evicted', tokenMint: 'tok-f2', reason: 'idle', cohort: 'fresh' },
      // mid: 1 seen, 1 pre-reject
      { type: 'realtime_candidate_seen', tokenMint: 'tok-m1', cohort: 'mid' },
      { type: 'pre_watchlist_reject', tokenMint: 'tok-m2', reason: 'unsupported_dex', cohort: 'mid' },
      // mature: 1 risk reject
      { type: 'risk_rejection', tokenMint: 'tok-x1', reason: 'max_concurrent', cohort: 'mature' },
      // cohort 누락 이벤트 → unknown 버킷
      { type: 'realtime_candidate_seen', tokenMint: 'tok-u1' },
      // funnel 외 이벤트는 무시되어야 함 (rate_limit 등)
      { type: 'rate_limit', source: 'gecko', cohort: 'fresh' },
    ];

    const byCohort = buildCohortFunnelBreakdown(events);

    expect(byCohort.fresh).toEqual({
      candidateSeen: 2,
      preWatchlistReject: 0,
      admissionSkip: 1,
      candidateEvicted: 1,
      riskRejection: 0,
    });
    expect(byCohort.mid).toEqual({
      candidateSeen: 1,
      preWatchlistReject: 1,
      admissionSkip: 0,
      candidateEvicted: 0,
      riskRejection: 0,
    });
    expect(byCohort.mature).toEqual({
      candidateSeen: 0,
      preWatchlistReject: 0,
      admissionSkip: 0,
      candidateEvicted: 0,
      riskRejection: 1,
    });
    expect(byCohort.unknown).toEqual({
      candidateSeen: 1,
      preWatchlistReject: 0,
      admissionSkip: 0,
      candidateEvicted: 0,
      riskRejection: 0,
    });
  });

  it('returns zero-filled breakdown for all cohorts when events are empty', () => {
    const byCohort = buildCohortFunnelBreakdown([]);
    for (const cohort of ['fresh', 'mid', 'mature', 'unknown'] as const) {
      expect(byCohort[cohort]).toEqual({
        candidateSeen: 0,
        preWatchlistReject: 0,
        admissionSkip: 0,
        candidateEvicted: 0,
        riskRejection: 0,
      });
    }
  });
});
