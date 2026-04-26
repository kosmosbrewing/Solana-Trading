/**
 * Lane Outcome Reconciler tests — Kelly Controller P0 (2026-04-26)
 *
 * ADR: docs/design-docs/lane-edge-controller-kelly-2026-04-25.md §10 P0
 * Acceptance criteria (§11):
 *  - kelly_eligible 은 reconcile 'ok' + executed_ledger/wallet_delta_comparator 만 true
 *  - duplicate_buy / orphan_sell / open_row_stale / wallet_drift 는 모두 false
 *  - cohort key = laneName × armName × (kolCluster or discoverySource)
 */
jest.mock('../src/utils/logger', () => ({
  createModuleLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import {
  reconcileLaneOutcomes,
  resolveLaneName,
  resolveArmName,
  buildCohortKey,
  type BuyLedgerRecord,
  type SellLedgerRecord,
} from '../src/risk/laneOutcomeReconciler';

const NOW_MS = new Date('2026-04-26T12:00:00Z').getTime();
const ONE_HOUR_MS = 60 * 60 * 1000;

function buy(opts: Partial<BuyLedgerRecord> = {}): BuyLedgerRecord {
  return {
    positionId: opts.positionId ?? 'pos-1',
    txSignature: opts.txSignature ?? 'buy-tx-1',
    strategy: opts.strategy ?? 'pure_ws_breakout',
    pairAddress: opts.pairAddress ?? 'PAIR1',
    tokenSymbol: opts.tokenSymbol ?? 'TOK',
    actualEntryPrice: 1,
    actualQuantity: 100,
    spentSol: opts.spentSol ?? 0.01,
    recordedAt: opts.recordedAt ?? new Date(NOW_MS - ONE_HOUR_MS).toISOString(),
    laneName: opts.laneName,
    armName: opts.armName,
    discoverySource: opts.discoverySource,
    paperOnly: opts.paperOnly,
  };
}

function sell(opts: Partial<SellLedgerRecord> = {}): SellLedgerRecord {
  return {
    positionId: opts.positionId ?? 'pos-1',
    txSignature: opts.txSignature ?? 'sell-tx-1',
    entryTxSignature: opts.entryTxSignature ?? 'buy-tx-1',
    strategy: opts.strategy ?? 'pure_ws_breakout',
    pairAddress: opts.pairAddress ?? 'PAIR1',
    receivedSol: opts.receivedSol ?? 0.012,
    holdSec: 60,
    exitReason: 'WINNER_TRAILING',
    recordedAt: opts.recordedAt ?? new Date(NOW_MS - 30 * 60 * 1000).toISOString(),
    mfePctPeak: opts.mfePctPeak,
    t1VisitAtSec: opts.t1VisitAtSec,
    t2VisitAtSec: opts.t2VisitAtSec,
    t3VisitAtSec: opts.t3VisitAtSec,
    walletDeltaSol: opts.walletDeltaSol,
    dbPnlSol: opts.dbPnlSol,
    dbPnlDriftSol: opts.dbPnlDriftSol,
  };
}

describe('laneOutcomeReconciler', () => {
  describe('resolveLaneName', () => {
    it('legacy strategy 명을 lane 으로 정규화', () => {
      expect(resolveLaneName('cupsey_flip_10s')).toBe('cupsey_flip_10s');
      expect(resolveLaneName('pure_ws_breakout')).toBe('pure_ws_breakout');
      expect(resolveLaneName('kol_hunter')).toBe('kol_hunter');
      expect(resolveLaneName('migration_reclaim')).toBe('migration_reclaim');
    });

    it('신규 ledger 의 laneName 우선', () => {
      expect(resolveLaneName('legacy_xyz', 'kol_hunter')).toBe('kol_hunter');
    });

    it('알 수 없는 strategy → unknown', () => {
      expect(resolveLaneName('foo_bar')).toBe('unknown');
      expect(resolveLaneName(undefined)).toBe('unknown');
    });
  });

  describe('resolveArmName', () => {
    it('armName 명시 시 그대로', () => {
      expect(resolveArmName(buy({ armName: 'v2_burst' }))).toBe('v2_burst');
    });
    it('armName 없으면 discoverySource', () => {
      expect(resolveArmName(buy({ discoverySource: 'kol_lexapro' }))).toBe('kol_lexapro');
    });
    it('둘 다 없으면 default', () => {
      expect(resolveArmName(buy())).toBe('default');
    });
  });

  describe('buildCohortKey', () => {
    it('3 차원 key (P0/P1 한정)', () => {
      expect(buildCohortKey('kol_hunter', 'lexapro', 'tier_S')).toBe('kol_hunter|lexapro|tier_S');
    });
    it('cluster 없으면 na', () => {
      expect(buildCohortKey('pure_ws_breakout', 'v2_burst')).toBe('pure_ws_breakout|v2_burst|na');
    });
  });

  describe('reconcile — happy path', () => {
    it('단일 buy ↔ 단일 sell → ok / kelly_eligible=true', () => {
      const { records, summary } = reconcileLaneOutcomes(
        [buy({ spentSol: 0.01 })],
        [sell({ receivedSol: 0.012 })],
        { nowMs: NOW_MS }
      );
      expect(records).toHaveLength(1);
      expect(records[0].reconcileStatus).toBe('ok');
      expect(records[0].kellyEligible).toBe(true);
      expect(records[0].walletTruthSource).toBe('executed_ledger');
      expect(records[0].matchedBuyId).toBeDefined();
      expect(records[0].matchedSellId).toBeDefined();
      expect(records[0].realizedPnlSol).toBeCloseTo(0.002, 6);
      expect(summary.kellyEligibleRatio).toBe(1.0);
      expect(summary.p0GateMet).toBe(true);
    });

    it('lane name 정규화 ledger 의 strategy 따라', () => {
      const { records } = reconcileLaneOutcomes(
        [buy({ strategy: 'kol_hunter' })],
        [sell({ strategy: 'kol_hunter' })],
        { nowMs: NOW_MS }
      );
      expect(records[0].laneName).toBe('kol_hunter');
    });
  });

  describe('reconcile — duplicate_buy', () => {
    it('동일 entryTxSignature 가 buy ledger 에 2회 → kelly_eligible=false', () => {
      const { records, summary } = reconcileLaneOutcomes(
        [
          buy({ positionId: 'pos-A', txSignature: 'tx-dup' }),
          buy({ positionId: 'pos-B', txSignature: 'tx-dup' }),
        ],
        [],
        { nowMs: NOW_MS }
      );
      expect(records).toHaveLength(2);
      for (const r of records) {
        expect(r.reconcileStatus).toBe('duplicate_buy');
        expect(r.kellyEligible).toBe(false);
        expect(r.walletTruthSource).toBe('unreconciled');
      }
      expect(summary.byStatus.duplicate_buy).toBe(2);
      expect(summary.p0GateMet).toBe(false);
    });

    it('QA F2: duplicate_buy record 의 positionId 가 unique (다운스트림 dedup 안전)', () => {
      const { records } = reconcileLaneOutcomes(
        [
          buy({ positionId: 'shared-id', txSignature: 'tx-dup' }),
          buy({ positionId: 'shared-id', txSignature: 'tx-dup' }),
        ],
        [],
        { nowMs: NOW_MS }
      );
      const ids = records.map((r) => r.positionId);
      expect(new Set(ids).size).toBe(2);
      expect(ids).toContain('shared-id#dup0');
      expect(ids).toContain('shared-id#dup1');
    });
  });

  describe('reconcile — paperOnly (QA F6)', () => {
    it('paperOnly=true 인 buy 는 status=ok 여도 kellyEligible=false (ADR §3 준수)', () => {
      const { records } = reconcileLaneOutcomes(
        [buy({ paperOnly: true, spentSol: 0.01 })],
        [sell({ receivedSol: 0.012 })],
        { nowMs: NOW_MS }
      );
      expect(records[0].reconcileStatus).toBe('ok');
      expect(records[0].paperOnly).toBe(true);
      expect(records[0].kellyEligible).toBe(false);
    });

    it('paperOnly=false (또는 미명시) 는 정상 ok → kellyEligible=true', () => {
      const { records } = reconcileLaneOutcomes(
        [buy({ paperOnly: false, spentSol: 0.01 })],
        [sell({ receivedSol: 0.012 })],
        { nowMs: NOW_MS }
      );
      expect(records[0].kellyEligible).toBe(true);
    });
  });

  describe('reconcile — duplicate sell (QA F4)', () => {
    it('같은 entryTxSignature 에 sell 이 2 → 첫 sell 만 paired, 나머지는 orphan_sell 로 기록', () => {
      const { records, summary } = reconcileLaneOutcomes(
        [buy({ positionId: 'pos-A', txSignature: 'tx-A', spentSol: 0.01 })],
        [
          sell({ positionId: 'pos-A', txSignature: 'sell-1', entryTxSignature: 'tx-A', receivedSol: 0.012 }),
          sell({ positionId: 'extra', txSignature: 'sell-2', entryTxSignature: 'tx-A', receivedSol: 0.013 }),
        ],
        { nowMs: NOW_MS }
      );
      expect(records).toHaveLength(2);
      const paired = records.find((r) => r.reconcileStatus === 'ok');
      const orphan = records.find((r) => r.reconcileStatus === 'orphan_sell');
      expect(paired).toBeDefined();
      expect(orphan).toBeDefined();
      // unique positionId 보장 — duplicate index suffix
      expect(orphan!.positionId).toBe('extra#dup1');
      expect(orphan!.matchedSellId).toBe('extra'); // sell 자체의 positionId 는 그대로
      expect(orphan!.exitTxSignature).toBe('sell-2');
      expect(summary.byStatus.orphan_sell).toBe(1);
    });
  });

  describe('reconcile — orphan_sell', () => {
    it('sell 의 entryTxSignature 가 buy 에 없음 → kelly_eligible=false', () => {
      const { records, summary } = reconcileLaneOutcomes(
        [],
        [sell({ entryTxSignature: 'tx-missing-buy' })],
        { nowMs: NOW_MS }
      );
      expect(records).toHaveLength(1);
      expect(records[0].reconcileStatus).toBe('orphan_sell');
      expect(records[0].kellyEligible).toBe(false);
      expect(records[0].matchedBuyId).toBeNull();
      expect(records[0].matchedSellId).not.toBeNull();
      expect(summary.byStatus.orphan_sell).toBe(1);
    });
  });

  describe('reconcile — open_row_stale', () => {
    it('buy 만 있고 24h 이상 경과 → kelly_eligible=false', () => {
      const oldBuy = buy({
        recordedAt: new Date(NOW_MS - 25 * ONE_HOUR_MS).toISOString(),
      });
      const { records, summary } = reconcileLaneOutcomes(
        [oldBuy],
        [],
        { nowMs: NOW_MS, openRowStaleHours: 24 }
      );
      expect(records).toHaveLength(1);
      expect(records[0].reconcileStatus).toBe('open_row_stale');
      expect(records[0].kellyEligible).toBe(false);
      expect(records[0].matchedSellId).toBeNull();
      expect(summary.byStatus.open_row_stale).toBe(1);
    });

    it('buy 만 있지만 1h 경과 — open 상태로 record 생성 안 함', () => {
      const recentBuy = buy({
        recordedAt: new Date(NOW_MS - ONE_HOUR_MS).toISOString(),
      });
      const { records } = reconcileLaneOutcomes(
        [recentBuy],
        [],
        { nowMs: NOW_MS, openRowStaleHours: 24 }
      );
      expect(records).toHaveLength(0);
    });
  });

  describe('reconcile — wallet_drift', () => {
    it('QA F1: drift 시 walletTruthSource=unreconciled (둘 다 신뢰 못함)', () => {
      const { records, summary } = reconcileLaneOutcomes(
        [buy({ spentSol: 0.01 })],
        [sell({ receivedSol: 0.012, dbPnlDriftSol: 0.05 })], // tolerance 0.01 초과
        { nowMs: NOW_MS, walletDriftToleranceSol: 0.01 }
      );
      expect(records).toHaveLength(1);
      expect(records[0].reconcileStatus).toBe('wallet_drift');
      expect(records[0].walletTruthSource).toBe('unreconciled');
      expect(records[0].kellyEligible).toBe(false);
      expect(summary.byStatus.wallet_drift).toBe(1);
    });

    it('DB pnl drift 가 tolerance 이내 → status=ok, kelly_eligible=true', () => {
      const { records } = reconcileLaneOutcomes(
        [buy({ spentSol: 0.01 })],
        [sell({ receivedSol: 0.012, dbPnlDriftSol: 0.005 })],
        { nowMs: NOW_MS, walletDriftToleranceSol: 0.01 }
      );
      expect(records[0].reconcileStatus).toBe('ok');
      expect(records[0].kellyEligible).toBe(true);
    });
  });

  describe('summary — P0 gate', () => {
    it('eligibleRatio ≥ 0.95 → p0GateMet=true', () => {
      const cases: BuyLedgerRecord[] = [];
      const sells: SellLedgerRecord[] = [];
      // 19 ok + 1 orphan = 19/20 = 95%
      for (let i = 0; i < 19; i += 1) {
        const tx = `tx-${i}`;
        cases.push(buy({ positionId: `pos-${i}`, txSignature: tx }));
        sells.push(sell({
          positionId: `pos-${i}`,
          txSignature: `sell-${i}`,
          entryTxSignature: tx,
        }));
      }
      sells.push(sell({ positionId: 'orphan', txSignature: 'sell-x', entryTxSignature: 'no-buy-tx' }));
      const { summary } = reconcileLaneOutcomes(cases, sells, { nowMs: NOW_MS });
      expect(summary.kellyEligibleRatio).toBeCloseTo(0.95, 2);
      expect(summary.p0GateMet).toBe(true);
    });

    it('eligibleRatio < 0.95 → p0GateMet=false', () => {
      const { summary } = reconcileLaneOutcomes(
        [buy({ txSignature: 't1' }), buy({ txSignature: 't1' })], // duplicate
        [],
        { nowMs: NOW_MS }
      );
      expect(summary.kellyEligibleRatio).toBe(0);
      expect(summary.p0GateMet).toBe(false);
    });
  });

  describe('summary — by lane', () => {
    it('lane 별 카운트 분리', () => {
      const { summary } = reconcileLaneOutcomes(
        [
          buy({ positionId: 'kp1', txSignature: 'kt1', strategy: 'kol_hunter' }),
          buy({ positionId: 'pp1', txSignature: 'pt1', strategy: 'pure_ws_breakout' }),
        ],
        [
          sell({ positionId: 'kp1', txSignature: 'ks1', entryTxSignature: 'kt1', strategy: 'kol_hunter' }),
          sell({ positionId: 'pp1', txSignature: 'ps1', entryTxSignature: 'pt1', strategy: 'pure_ws_breakout' }),
        ],
        { nowMs: NOW_MS }
      );
      expect(summary.byLane.kol_hunter).toBe(1);
      expect(summary.byLane.pure_ws_breakout).toBe(1);
    });
  });

  describe('record fields', () => {
    it('5 핵심 필드 (kelly_eligible / reconcile_status / matched_buy_id / matched_sell_id / wallet_truth_source) 모두 존재', () => {
      const { records } = reconcileLaneOutcomes(
        [buy()],
        [sell()],
        { nowMs: NOW_MS }
      );
      const r = records[0];
      expect(r).toHaveProperty('kellyEligible');
      expect(r).toHaveProperty('reconcileStatus');
      expect(r).toHaveProperty('matchedBuyId');
      expect(r).toHaveProperty('matchedSellId');
      expect(r).toHaveProperty('walletTruthSource');
    });

    it('discoverySource / paperOnly 전파', () => {
      const { records } = reconcileLaneOutcomes(
        [buy({ discoverySource: 'kol_lexapro', paperOnly: true })],
        [sell()],
        { nowMs: NOW_MS }
      );
      expect(records[0].discoverySource).toBe('kol_lexapro');
      expect(records[0].paperOnly).toBe(true);
    });

    it('P2-4 microstructure 필드 (mfePctPeak / t1/t2/t3 visit) 전파', () => {
      const { records } = reconcileLaneOutcomes(
        [buy()],
        [sell({ mfePctPeak: 0.5, t1VisitAtSec: 100, t2VisitAtSec: null })],
        { nowMs: NOW_MS }
      );
      expect(records[0].maxMfePct).toBe(0.5);
      expect(records[0].t1VisitAtSec).toBe(100);
      expect(records[0].t2VisitAtSec).toBeNull();
    });
  });
});
