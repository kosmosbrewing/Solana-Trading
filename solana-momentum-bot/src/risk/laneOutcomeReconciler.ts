/**
 * Lane Outcome Reconciler — Kelly Controller P0 (2026-04-26)
 *
 * ADR: docs/design-docs/lane-edge-controller-kelly-2026-04-25.md §10 P0
 *
 * Pure function — `executed-buys.jsonl` + `executed-sells.jsonl` 입력 → `LaneOutcomeRecord[]`.
 * I/O 는 caller (CLI script) 가 담당. 테스트 용이.
 *
 * Reconcile 전략:
 *   1. Buy 를 (laneName, entryTxSignature) 키로 인덱스
 *   2. Sell 의 entryTxSignature 로 buy 조회 → paired
 *   3. 동일 buy txSignature 가 2+ entry → duplicate_buy
 *   4. Buy 없이 sell 만 → orphan_sell
 *   5. Sell 없이 buy 만 + N시간 경과 → open_row_stale
 *   6. Wallet delta 와 receivedSol-spentSol drift 비교 → wallet_drift
 *
 * 모든 분류는 결정적이고 idempotent (같은 입력 → 같은 출력).
 */
import type {
  LaneName,
  ArmName,
  LaneOutcomeRecord,
  ReconcileStatus,
  ReconcileSummary,
  WalletTruthSource,
} from './laneOutcomeTypes';

// ─── Input shapes (CLI 가 jsonl 에서 읽어 전달) ───

export interface BuyLedgerRecord {
  positionId?: string;
  txSignature?: string;
  strategy?: string;
  pairAddress?: string;
  tokenSymbol?: string;
  actualEntryPrice?: number;
  actualQuantity?: number;
  signalTimeSec?: number;
  recordedAt?: string;
  // 신규 lane 메타 (handler 가 기록):
  laneName?: string;
  armName?: string;
  discoverySource?: string;
  paperOnly?: boolean;
  spentSol?: number;
}

export interface SellLedgerRecord {
  positionId?: string;
  txSignature?: string;
  entryTxSignature?: string;
  strategy?: string;
  eventType?: string;
  isPartialReduce?: boolean;
  positionStillOpen?: boolean;
  pairAddress?: string;
  tokenSymbol?: string;
  exitReason?: string;
  receivedSol?: number;
  actualExitPrice?: number;
  holdSec?: number;
  recordedAt?: string;
  // P2-4 fields
  mfePctPeak?: number;
  t1VisitAtSec?: number | null;
  t2VisitAtSec?: number | null;
  t3VisitAtSec?: number | null;
  // P0-4 wallet drift snapshot
  walletDeltaSol?: number;
  dbPnlSol?: number;
  dbPnlDriftSol?: number;
  // 신규 lane 메타
  laneName?: string;
  armName?: string;
}

function isPartialReduceLedgerRow(row: SellLedgerRecord): boolean {
  return row.isPartialReduce === true ||
    row.positionStillOpen === true ||
    row.eventType === 'rotation_flow_live_reduce';
}

export interface ReconcileConfig {
  /** open_row_stale 판정 threshold (epoch ms 기준 N 시간). 기본 24h. */
  openRowStaleHours: number;
  /** wallet_drift 판정 threshold (sol). 기본 0.01 SOL = 1% × 0.01 ticket. */
  walletDriftToleranceSol: number;
  /** 현재 시점 (테스트용 주입, 기본 Date.now()). */
  nowMs?: number;
  /** P0 gate 통과 기준 — kellyEligible 비율. 기본 0.95. */
  p0GateThreshold: number;
}

export const DEFAULT_RECONCILE_CONFIG: ReconcileConfig = {
  openRowStaleHours: 24,
  walletDriftToleranceSol: 0.01,
  p0GateThreshold: 0.95,
};

// ─── Lane / Arm normalization ───

/**
 * Strategy / lane / arm 매핑 — legacy strategy 명, 신규 lane 명 모두 단일 LaneName 으로 정규화.
 */
export function resolveLaneName(strategy: string | undefined, laneName?: string): LaneName {
  // 신규 ledger 가 명시한 laneName 우선
  if (laneName && isKnownLane(laneName)) return laneName as LaneName;
  // legacy strategy 매핑
  switch (strategy) {
    case 'cupsey_flip_10s':
    case 'pure_ws_breakout':
    case 'kol_hunter':
    case 'migration_reclaim':
    case 'bootstrap_10s':
    case 'volume_spike':
    case 'fib_pullback':
    case 'core_momentum':
    case 'new_lp_sniper':
      return strategy;
    default:
      return 'unknown';
  }
}

function isKnownLane(name: string): boolean {
  return [
    'cupsey_flip_10s', 'pure_ws_breakout', 'kol_hunter', 'migration_reclaim',
    'bootstrap_10s', 'volume_spike', 'fib_pullback', 'core_momentum', 'new_lp_sniper',
  ].includes(name);
}

/**
 * Arm 명시 추출 — buy ledger 의 armName, 없으면 discoverySource fallback, 그것도 없으면 'default'.
 */
export function resolveArmName(buy: BuyLedgerRecord): ArmName {
  if (buy.armName) return buy.armName;
  if (buy.discoverySource) return buy.discoverySource;
  return 'default';
}

/**
 * Cohort key builder — P0/P1 한정 3 차원: laneName × armName × (kolCluster or discoverySource).
 * 차원 추가는 ADR 필수 (lane-edge-controller-kelly-2026-04-25.md §5.1).
 */
export function buildCohortKey(
  laneName: LaneName,
  armName: ArmName,
  kolClusterOrDiscovery?: string
): string {
  const cluster = kolClusterOrDiscovery ?? 'na';
  return `${laneName}|${armName}|${cluster}`;
}

// ─── Reconciler ───

export function reconcileLaneOutcomes(
  buys: BuyLedgerRecord[],
  sells: SellLedgerRecord[],
  config: Partial<ReconcileConfig> = {}
): { records: LaneOutcomeRecord[]; summary: ReconcileSummary } {
  const cfg = { ...DEFAULT_RECONCILE_CONFIG, ...config };
  const nowMs = cfg.nowMs ?? Date.now();

  // 1. Buy index by entryTxSignature — duplicate detection
  const buyByTx = new Map<string, BuyLedgerRecord[]>();
  for (const buy of buys) {
    if (!buy.txSignature) continue;
    const arr = buyByTx.get(buy.txSignature) ?? [];
    arr.push(buy);
    buyByTx.set(buy.txSignature, arr);
  }

  // 2. Sell index by entryTxSignature
  const sellByEntryTx = new Map<string, SellLedgerRecord[]>();
  for (const sell of sells) {
    if (isPartialReduceLedgerRow(sell)) continue;
    if (!sell.entryTxSignature) continue;
    const arr = sellByEntryTx.get(sell.entryTxSignature) ?? [];
    arr.push(sell);
    sellByEntryTx.set(sell.entryTxSignature, arr);
  }

  const records: LaneOutcomeRecord[] = [];
  const consumedSells = new Set<string>(); // sell.txSignature

  // 3. Walk buys
  for (const [entryTx, buyArr] of buyByTx) {
    if (buyArr.length > 1) {
      // duplicate_buy — 모든 buy 를 별도 record 로 표시 (kellyEligible=false)
      // QA F2 (2026-04-26): 같은 entryTxSignature → 같은 positionId 이면 다운스트림 dedup 깨짐.
      // duplicate index 를 record positionId 에 suffix 로 붙여 unique 화.
      for (let i = 0; i < buyArr.length; i += 1) {
        records.push(buildRecord({
          buy: buyArr[i],
          sell: null,
          status: 'duplicate_buy',
          walletTruthSource: 'unreconciled',
          duplicateIndex: i,
          nowMs,
        }));
      }
      continue;
    }

    const buy = buyArr[0];
    const sells = sellByEntryTx.get(entryTx) ?? [];

    if (sells.length === 0) {
      // open_row_stale 판정
      const buyMs = parseRecordedAt(buy.recordedAt) ?? nowMs;
      const ageHours = (nowMs - buyMs) / (60 * 60 * 1000);
      if (ageHours >= cfg.openRowStaleHours) {
        records.push(buildRecord({
          buy,
          sell: null,
          status: 'open_row_stale',
          walletTruthSource: 'unreconciled',
          nowMs,
        }));
      } else {
        // 미체결 trade — record 생성 안 함 (다음 reconcile 사이클에서 paired 될 가능성)
      }
      continue;
    }

    // Paired — 첫 sell 매칭 (FIFO).
    const sell = sells[0];
    if (sell.txSignature) consumedSells.add(sell.txSignature);
    // QA F4 (2026-04-26): 같은 entryTxSignature 에 sell 이 2+ → silent loss 방지.
    // 추가 sell 은 별도 orphan_sell 로 기록 (duplicate sell 도 reconcile 실패 표지).
    for (let i = 1; i < sells.length; i += 1) {
      const extra = sells[i];
      if (extra.txSignature) consumedSells.add(extra.txSignature);
      records.push(buildRecord({
        buy: null,
        sell: extra,
        status: 'orphan_sell',
        walletTruthSource: 'unreconciled',
        duplicateIndex: i,
        nowMs,
      }));
    }

    // Wallet drift 판정
    const spentSol = buy.spentSol ?? estimateSpentSol(buy) ?? 0;
    const receivedSol = sell.receivedSol ?? 0;
    const realizedPnl = receivedSol - spentSol;
    const dbPnl = sell.dbPnlSol;
    const drift = sell.dbPnlDriftSol ?? (dbPnl != null ? dbPnl - realizedPnl : 0);

    let status: ReconcileStatus = 'ok';
    let walletTruthSource: WalletTruthSource = 'executed_ledger';
    if (Math.abs(drift) > cfg.walletDriftToleranceSol) {
      // QA F1 (2026-04-26): drift 발견 = ledger 와 DB 의 두 source 가 모순.
      // 어느 쪽도 신뢰할 수 없으므로 'unreconciled' 가 정합. 'wallet_delta_comparator' 는
      // delta poller 가 ground truth 일 때만 (현재는 그 경로 없음 — DB 비교만 있음).
      status = 'wallet_drift';
      walletTruthSource = 'unreconciled';
    }

    records.push(buildRecord({
      buy,
      sell,
      status,
      walletTruthSource,
      realizedPnl,
      spentSol,
      receivedSol,
      nowMs,
    }));
  }

  // 4. Orphan sells — entryTxSignature 가 buy ledger 에 없음
  for (const [entryTx, sellArr] of sellByEntryTx) {
    if (buyByTx.has(entryTx)) continue;
    for (const sell of sellArr) {
      if (sell.txSignature && consumedSells.has(sell.txSignature)) continue;
      records.push(buildRecord({
        buy: null,
        sell,
        status: 'orphan_sell',
        walletTruthSource: 'unreconciled',
        nowMs,
      }));
    }
  }

  // 5. Summary
  const byStatus: Record<ReconcileStatus, number> = {
    ok: 0, duplicate_buy: 0, orphan_sell: 0, open_row_stale: 0, wallet_drift: 0,
  };
  const byLane: Record<string, number> = {};
  let kellyEligibleCount = 0;
  for (const r of records) {
    byStatus[r.reconcileStatus] += 1;
    byLane[r.laneName] = (byLane[r.laneName] ?? 0) + 1;
    if (r.kellyEligible) kellyEligibleCount += 1;
  }
  const total = records.length;
  const kellyEligibleRatio = total > 0 ? kellyEligibleCount / total : 0;
  const summary: ReconcileSummary = {
    totalRecords: total,
    byStatus,
    kellyEligibleRatio,
    byLane,
    p0GateMet: kellyEligibleRatio >= cfg.p0GateThreshold,
  };

  return { records, summary };
}

// ─── Internal builders ───

interface BuildRecordInput {
  buy: BuyLedgerRecord | null;
  sell: SellLedgerRecord | null;
  status: ReconcileStatus;
  walletTruthSource: WalletTruthSource;
  realizedPnl?: number;
  spentSol?: number;
  receivedSol?: number;
  /** QA F2: duplicate_buy 시 unique positionId 보장용 index. */
  duplicateIndex?: number;
  nowMs: number;
}

function buildRecord(input: BuildRecordInput): LaneOutcomeRecord {
  const { buy, sell, status, walletTruthSource, realizedPnl, spentSol, receivedSol, duplicateIndex, nowMs } = input;
  const ref = sell ?? buy;
  const laneName = resolveLaneName(ref?.strategy, ref?.laneName);
  const armName = buy ? resolveArmName(buy) : (sell?.armName ?? 'default');
  const basePositionId = buy?.positionId ?? sell?.positionId ?? 'unknown';
  const positionId = duplicateIndex != null
    ? `${basePositionId}#dup${duplicateIndex}`
    : basePositionId;
  // QA F6 (2026-04-26): paper outcome 은 절대 kellyEligible=true 안 됨. ADR §3 준수
  // ("Paper lanes never unlock live sizing"). paperOnly=true 면 강제 false.
  const kellyEligible =
    status === 'ok' &&
    walletTruthSource === 'executed_ledger' &&
    !(buy?.paperOnly === true);

  return {
    positionId,
    laneName,
    armName,
    tokenMint: buy?.pairAddress ?? sell?.pairAddress, // pairAddress 가 mint 와 동일한 경우 다수
    pairAddress: buy?.pairAddress ?? sell?.pairAddress,
    tokenSymbol: buy?.tokenSymbol ?? sell?.tokenSymbol,
    entryTxSignature: buy?.txSignature,
    exitTxSignature: sell?.txSignature,
    entryTimeSec: buy?.signalTimeSec,
    exitTimeSec: sell?.recordedAt ? Math.floor(parseRecordedAt(sell.recordedAt)! / 1000) : undefined,
    holdSec: sell?.holdSec,
    spentSol: spentSol ?? (buy ? estimateSpentSol(buy) : undefined),
    receivedSol: receivedSol ?? sell?.receivedSol,
    realizedPnlSol: realizedPnl,
    maxMfePct: sell?.mfePctPeak,
    t1VisitAtSec: sell?.t1VisitAtSec ?? null,
    t2VisitAtSec: sell?.t2VisitAtSec ?? null,
    t3VisitAtSec: sell?.t3VisitAtSec ?? null,
    exitReason: sell?.exitReason,
    kellyEligible,
    reconcileStatus: status,
    matchedBuyId: buy?.positionId ?? buy?.txSignature ?? null,
    matchedSellId: sell?.positionId ?? sell?.txSignature ?? null,
    walletTruthSource,
    discoverySource: buy?.discoverySource,
    paperOnly: buy?.paperOnly,
    recordedAt: new Date(nowMs).toISOString(),
  };
}

function estimateSpentSol(buy: BuyLedgerRecord): number | undefined {
  if (typeof buy.spentSol === 'number') return buy.spentSol;
  if (buy.actualEntryPrice != null && buy.actualQuantity != null) {
    return buy.actualEntryPrice * buy.actualQuantity;
  }
  return undefined;
}

function parseRecordedAt(s: string | undefined): number | null {
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}
