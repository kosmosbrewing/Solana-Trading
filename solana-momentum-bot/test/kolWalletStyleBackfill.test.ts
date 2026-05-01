/**
 * KOL Wallet Style backfill tests (2026-05-01, Stream G).
 */

import {
  computeStyleMetrics,
  inferLaneRole,
  inferTradingStyle,
  classifyDiff,
  buildDiffReport,
  parseSince,
  STYLE_SCHEMA_VERSION,
} from '../scripts/kol-wallet-style-backfill';
import type { DiffEntry, KolDbWalletEntry } from '../scripts/kol-wallet-style-backfill';

const NOW = 1_700_000_000_000; // ms

function tx(opts: { kolId: string; tokenMint: string; action: 'buy' | 'sell'; ts: number }): {
  kolId: string; tokenMint: string; action: 'buy' | 'sell'; timestamp: number;
} {
  return { kolId: opts.kolId, tokenMint: opts.tokenMint, action: opts.action, timestamp: opts.ts };
}

describe('parseSince', () => {
  it('30d 정상', () => {
    const t = parseSince('30d');
    expect(Date.now() - t).toBeCloseTo(30 * 86400000, -3);
  });

  it('invalid → throw', () => {
    expect(() => parseSince('foo')).toThrow();
  });
});

describe('computeStyleMetrics', () => {
  it('샘플 0 → unknown role/style', () => {
    const m = computeStyleMetrics('decu', [], [], 0);
    expect(m.sampleCount).toBe(0);
    expect(m.suggestedLaneRole).toBe('unknown');
    expect(m.suggestedTradingStyle).toBe('unknown');
  });

  it('scalper 패턴 (quick sell + short hold) → trading_style=scalper', () => {
    const txs = [
      tx({ kolId: 'k1', tokenMint: 'M1', action: 'buy', ts: NOW - 10_000 }),
      tx({ kolId: 'k1', tokenMint: 'M1', action: 'sell', ts: NOW - 8_000 }), // 2초 hold
      tx({ kolId: 'k1', tokenMint: 'M2', action: 'buy', ts: NOW - 7_000 }),
      tx({ kolId: 'k1', tokenMint: 'M2', action: 'sell', ts: NOW - 6_500 }),
    ];
    const m = computeStyleMetrics('k1', txs, [], NOW - 60_000);
    expect(m.sampleCount).toBe(2);
    expect(m.quickSellRatio).toBeGreaterThan(0.5);
    expect(m.suggestedTradingStyle).toBe('scalper');
  });

  it('longhold 패턴 (>= 24h hold) → trading_style=longhold', () => {
    const day = 86400 * 1000;
    const txs = [
      tx({ kolId: 'k1', tokenMint: 'M1', action: 'buy', ts: NOW - 2 * day }),
      tx({ kolId: 'k1', tokenMint: 'M1', action: 'sell', ts: NOW - day }), // 24h hold
    ];
    const m = computeStyleMetrics('k1', txs, [], NOW - 7 * day);
    expect(m.suggestedTradingStyle).toBe('longhold');
  });

  it('swing 패턴 (1h ≤ hold < 24h) → trading_style=swing', () => {
    const txs = [
      tx({ kolId: 'k1', tokenMint: 'M1', action: 'buy', ts: NOW - 3 * 3600 * 1000 }),
      tx({ kolId: 'k1', tokenMint: 'M1', action: 'sell', ts: NOW - 3600 * 1000 }), // 2h hold
    ];
    const m = computeStyleMetrics('k1', txs, [], NOW - 86400_000);
    expect(m.suggestedTradingStyle).toBe('swing');
  });

  it('window 밖 tx 제외', () => {
    const txs = [
      tx({ kolId: 'k1', tokenMint: 'M1', action: 'buy', ts: NOW - 100 * 86400_000 }), // 100일 전
      tx({ kolId: 'k1', tokenMint: 'M2', action: 'buy', ts: NOW - 1000 }),
    ];
    const m = computeStyleMetrics('k1', txs, [], NOW - 86400_000); // 1일 window
    expect(m.sampleCount).toBe(1);
  });

  it('same-token re-entry 비율', () => {
    const txs = [
      tx({ kolId: 'k1', tokenMint: 'M1', action: 'buy', ts: NOW - 10_000 }),
      tx({ kolId: 'k1', tokenMint: 'M1', action: 'sell', ts: NOW - 9000 }),
      tx({ kolId: 'k1', tokenMint: 'M1', action: 'buy', ts: NOW - 8000 }), // 재진입
      tx({ kolId: 'k1', tokenMint: 'M2', action: 'buy', ts: NOW - 7000 }),
    ];
    const m = computeStyleMetrics('k1', txs, [], NOW - 60_000);
    // 2 distinct tokens, 1 re-entry → ratio 0.5
    expect(m.sameTokenReEntryRatio).toBeCloseTo(0.5, 2);
  });
});

describe('inferLaneRole', () => {
  it('high copy score + ≥1h hold → copy_core', () => {
    expect(inferLaneRole({
      avgHoldSec: 3600,
      copyabilityScore: 0.8,
      quickSellRatio: 0.1,
    })).toBe('copy_core');
  });

  it('mid score + low quickSell → discovery_canary', () => {
    expect(inferLaneRole({
      avgHoldSec: 1800,
      copyabilityScore: 0.5,
      quickSellRatio: 0.3,
    })).toBe('discovery_canary');
  });

  it('low score → observer', () => {
    expect(inferLaneRole({
      avgHoldSec: 600,
      copyabilityScore: 0.1,
      quickSellRatio: 0.8,
    })).toBe('observer');
  });

  it('avgHoldSec 미공급 → unknown', () => {
    expect(inferLaneRole({ copyabilityScore: 0.5 })).toBe('unknown');
  });
});

describe('inferTradingStyle', () => {
  it.each([
    [86400, 'longhold'],
    [86400 * 2, 'longhold'],
    [3600, 'swing'],
    [3600 * 5, 'swing'],
    [10, 'unknown'], // quick sell ratio 미제공
  ])('avgHoldSec %d → %s', (sec, expected) => {
    expect(inferTradingStyle({ avgHoldSec: sec })).toBe(expected);
  });

  it('< 1h hold + quick sell ≥ 50% → scalper', () => {
    expect(inferTradingStyle({ avgHoldSec: 100, quickSellRatio: 0.7 })).toBe('scalper');
  });
});

describe('classifyDiff', () => {
  it('NO_CHANGE: role + style 일치', () => {
    const cur: KolDbWalletEntry = {
      id: 'k1',
      lane_role: 'copy_core',
      trading_style: 'longhold',
    };
    const cat = classifyDiff(cur, {
      kolId: 'k1',
      sampleCount: 10,
      suggestedLaneRole: 'copy_core',
      suggestedTradingStyle: 'longhold',
    });
    expect(cat).toBe('NO_CHANGE');
  });

  it('PROMOTE: 비-copy_core → copy_core 추천', () => {
    const cur: KolDbWalletEntry = { id: 'k1', lane_role: 'discovery_canary', trading_style: 'swing' };
    expect(classifyDiff(cur, {
      kolId: 'k1',
      sampleCount: 10,
      suggestedLaneRole: 'copy_core',
      suggestedTradingStyle: 'longhold',
    })).toBe('PROMOTE');
  });

  it('DEMOTE: 비-observer → observer 추천', () => {
    const cur: KolDbWalletEntry = { id: 'k1', lane_role: 'discovery_canary', trading_style: 'scalper' };
    expect(classifyDiff(cur, {
      kolId: 'k1',
      sampleCount: 10,
      suggestedLaneRole: 'observer',
      suggestedTradingStyle: 'scalper',
    })).toBe('DEMOTE');
  });

  it('RECLASSIFY: role / style 변경 (PROMOTE/DEMOTE 아님)', () => {
    const cur: KolDbWalletEntry = { id: 'k1', lane_role: 'discovery_canary', trading_style: 'scalper' };
    expect(classifyDiff(cur, {
      kolId: 'k1',
      sampleCount: 10,
      suggestedLaneRole: 'discovery_canary',
      suggestedTradingStyle: 'swing',
    })).toBe('RECLASSIFY');
  });
});

describe('buildDiffReport', () => {
  it('PROMOTE / DEMOTE / RECLASSIFY summary 포함', () => {
    const diffs: DiffEntry[] = [
      {
        kolId: 'k1',
        currentLaneRole: 'discovery_canary',
        suggestedLaneRole: 'copy_core',
        currentTradingStyle: 'swing',
        suggestedTradingStyle: 'longhold',
        category: 'PROMOTE',
        metrics: {
          kolId: 'k1',
          sampleCount: 30,
          copyabilityScore: 0.85,
          avgHoldSec: 7200,
          suggestedLaneRole: 'copy_core',
          suggestedTradingStyle: 'longhold',
        },
      },
    ];
    const md = buildDiffReport(diffs);
    expect(md).toContain('PROMOTE: 1');
    expect(md).toContain('DEMOTE: 0');
    expect(md).toContain('| k1 |');
    expect(md).toContain('Schema');
    expect(md).toContain(STYLE_SCHEMA_VERSION);
    expect(md).toContain('rollout rule 4');
  });

  it('빈 list → summary 만', () => {
    const md = buildDiffReport([]);
    expect(md).toContain('PROMOTE: 0');
    expect(md).toContain('DEMOTE: 0');
  });
});
