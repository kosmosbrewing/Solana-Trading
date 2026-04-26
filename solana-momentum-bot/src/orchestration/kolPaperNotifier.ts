/**
 * KOL paper notifier (2026-04-26).
 *
 * Operator visibility for KOL paper trading without notification spam:
 *
 *  L1 — Hourly digest (KOL_HOURLY_DIGEST_ENABLED, default true)
 *       last hour 의 discoveries / entries by arm / closes / netSol / top peak movers /
 *       open snapshot. 이벤트가 0건인 시간대는 알림 skip.
 *
 *  L2 — Real-time anomaly (KOL_ANOMALY_MFE_THRESHOLD, default 5.0 = 500%)
 *       paper_close 이벤트의 peak MFE 가 임계 이상이면 즉시 sendInfo. 희귀한 이벤트만 →
 *       알림 spam 없음.
 *
 * Why combined module: 둘 다 동일한 kolHunterEvents 를 구독하므로 accumulator state 를
 * 한 곳에서 유지하는 게 단순.
 */
import type { Notifier } from '../notifier';
import { config } from '../utils/config';
import { createModuleLogger } from '../utils/logger';
import { kolHunterEvents } from './kolSignalHandler';
import type { PaperPosition, CloseReason } from './kolSignalHandler';
import type { KolTx } from '../kol/types';

const log = createModuleLogger('KolPaperNotifier');

// ─── Accumulator state ──────────────────────────────────────────────────────

interface ArmCounters {
  discoveries: number;       // discovery emit (handleKolSwap 진입)
  entries: number;           // paper_entry emit
  closes: number;
  netSolSum: number;
  winnersByVisit: { t1: number; t2: number; t3: number };
  winners5xByVisit: number;  // closed with t2VisitAtSec set (5x= post-T2 visit floor)
}

interface PeakMover {
  tokenMint: string;
  armName: string;
  positionId: string;
  mfePctPeak: number;
  netPct: number;
  holdSec: number;
  closedAtMs: number;
}

const ARMS = ['kol_hunter_v1', 'kol_hunter_smart_v3', 'kol_hunter_swing_v2'] as const;
type ArmName = typeof ARMS[number] | 'unknown';

function emptyArmCounters(): ArmCounters {
  return {
    discoveries: 0,
    entries: 0,
    closes: 0,
    netSolSum: 0,
    winnersByVisit: { t1: 0, t2: 0, t3: 0 },
    winners5xByVisit: 0,
  };
}

interface DigestState {
  windowStartedMs: number;
  totalDiscoveries: number;
  perArm: Record<ArmName, ArmCounters>;
  topMovers: PeakMover[];  // closed peak movers in this hour
}

function emptyDigest(): DigestState {
  const perArm = {} as Record<ArmName, ArmCounters>;
  for (const arm of [...ARMS, 'unknown' as ArmName]) {
    perArm[arm] = emptyArmCounters();
  }
  return {
    windowStartedMs: Date.now(),
    totalDiscoveries: 0,
    perArm,
    topMovers: [],
  };
}

let digest: DigestState = emptyDigest();
let initialized = false;
let notifierRef: Notifier | null = null;

// ─── Event handlers ─────────────────────────────────────────────────────────

function onDiscovery(tx: KolTx): void {
  digest.totalDiscoveries++;
  // arm-별 discovery 카운팅은 entry 시점이 더 정확 — discovery 자체는 arm 결정 전.
  void tx;
}

function onPaperEntry(pos: PaperPosition): void {
  const arm = (ARMS as readonly string[]).includes(pos.armName) ? (pos.armName as ArmName) : 'unknown';
  digest.perArm[arm].entries++;
  digest.perArm[arm].discoveries++;  // entry 가 곧 discovery 의 subset (arm 별 분포)
}

function onPaperClose(payload: {
  pos: PaperPosition;
  reason: CloseReason;
  exitPrice: number;
  netSol: number;
  netPct: number;
  mfePctPeak: number;
  holdSec: number;
}): void {
  const { pos, reason, netSol, netPct, mfePctPeak, holdSec } = payload;
  const arm = (ARMS as readonly string[]).includes(pos.armName) ? (pos.armName as ArmName) : 'unknown';
  const counters = digest.perArm[arm];
  counters.closes++;
  counters.netSolSum += netSol;
  if (pos.t1VisitAtSec) counters.winnersByVisit.t1++;
  if (pos.t2VisitAtSec) {
    counters.winnersByVisit.t2++;
    counters.winners5xByVisit++;  // T2 = 5x MFE — visit-based winner 정의
  }
  if (pos.t3VisitAtSec) counters.winnersByVisit.t3++;

  // top mover 후보 — peak MFE 기준 정렬
  digest.topMovers.push({
    tokenMint: pos.tokenMint,
    armName: pos.armName,
    positionId: pos.positionId,
    mfePctPeak,
    netPct,
    holdSec,
    closedAtMs: Date.now(),
  });

  // L2 anomaly — peak MFE 가 임계 (default 5.0 = 500%) 이상이면 즉시 알림
  if (mfePctPeak >= config.kolAnomalyMfeThreshold && notifierRef) {
    const message =
      `🔥 [KOL_5X_WINNER] ${pos.armName} / ${pos.tokenMint.slice(0, 12)}\n` +
      `  MFE peak: +${(mfePctPeak * 100).toFixed(0)}%\n` +
      `  net (closed): ${netPct >= 0 ? '+' : ''}${(netPct * 100).toFixed(2)}% ` +
      `(reason: ${reason})\n` +
      `  hold: ${Math.round(holdSec / 60)}min · entry: ${pos.kolEntryReason} · ` +
      `conviction: ${pos.kolConvictionLevel}\n` +
      `  parameterVersion: ${pos.parameterVersion}`;
    notifierRef.sendInfo(message, 'kol_anomaly').catch((err) => {
      log.warn(`L2 anomaly send failed: ${err}`);
    });
  }
}

// ─── L1 hourly digest ────────────────────────────────────────────────────────

function buildHourlyDigestMessage(): string | null {
  const totalEntries = Object.values(digest.perArm).reduce((s, a) => s + a.entries, 0);
  const totalCloses = Object.values(digest.perArm).reduce((s, a) => s + a.closes, 0);
  if (digest.totalDiscoveries === 0 && totalEntries === 0 && totalCloses === 0) {
    return null;  // 이벤트 0 — 알림 skip
  }

  const startedAt = new Date(digest.windowStartedMs);
  const endedAt = new Date();
  const startKst = new Date(startedAt.getTime() + 9 * 3600 * 1000).toISOString().slice(11, 16);
  const endKst = new Date(endedAt.getTime() + 9 * 3600 * 1000).toISOString().slice(11, 16);

  const lines: string[] = [];
  lines.push(`[KOL HOURLY ${startKst}-${endKst} KST]`);
  lines.push(`  discoveries: ${digest.totalDiscoveries}`);

  const armSummary = ARMS.map((arm) => {
    const c = digest.perArm[arm];
    const armShort = arm.replace('kol_hunter_', '');
    return `${armShort}: ${c.entries}e/${c.closes}c (net ${c.netSolSum >= 0 ? '+' : ''}${c.netSolSum.toFixed(4)} SOL)`;
  }).join(', ');
  lines.push(`  arms: ${armSummary}`);

  // Top movers (peak MFE 기준 desc)
  const top = [...digest.topMovers]
    .sort((a, b) => b.mfePctPeak - a.mfePctPeak)
    .slice(0, config.kolDigestTopMoverCount);
  if (top.length > 0) {
    lines.push(`  top peak movers (${top.length}):`);
    for (const m of top) {
      const mint = m.tokenMint.slice(0, 8);
      const armShort = m.armName.replace('kol_hunter_', '');
      const sign = m.netPct >= 0 ? '+' : '';
      lines.push(
        `    ${mint} (${armShort}): peak +${(m.mfePctPeak * 100).toFixed(0)}% → ` +
        `net ${sign}${(m.netPct * 100).toFixed(2)}% · ${Math.round(m.holdSec / 60)}min`
      );
    }
  }

  // Visit-based winners (cumulative this hour)
  const visitTotals = Object.values(digest.perArm).reduce(
    (acc, c) => ({
      t1: acc.t1 + c.winnersByVisit.t1,
      t2: acc.t2 + c.winnersByVisit.t2,
      t3: acc.t3 + c.winnersByVisit.t3,
    }),
    { t1: 0, t2: 0, t3: 0 }
  );
  if (visitTotals.t1 + visitTotals.t2 + visitTotals.t3 > 0) {
    lines.push(`  visit winners: t1=${visitTotals.t1} t2=${visitTotals.t2} t3=${visitTotals.t3}`);
  }

  return lines.join('\n');
}

/** scheduler 가 1h 마다 호출. accumulator reset 후 다음 윈도우 시작. */
export async function flushKolHourlyDigest(notifier: Notifier): Promise<void> {
  if (!config.kolHourlyDigestEnabled) return;
  const message = buildHourlyDigestMessage();
  if (!message) {
    digest = emptyDigest();
    return;
  }
  try {
    await notifier.sendInfo(message, 'kol_hourly_digest');
  } catch (err) {
    log.warn(`hourly digest send failed: ${err}`);
  }
  digest = emptyDigest();
}

// ─── Init / shutdown ────────────────────────────────────────────────────────

export function initKolPaperNotifier(notifier: Notifier): void {
  if (initialized) return;
  notifierRef = notifier;
  kolHunterEvents.on('discovery', onDiscovery);
  kolHunterEvents.on('paper_entry', onPaperEntry);
  kolHunterEvents.on('paper_close', onPaperClose);
  initialized = true;
  log.info(
    `KOL paper notifier initialized — hourly=${config.kolHourlyDigestEnabled} ` +
    `anomalyMfe=${config.kolAnomalyMfeThreshold}x daily=${config.kolDailySummaryEnabled}`
  );
}

export function stopKolPaperNotifier(): void {
  if (!initialized) return;
  kolHunterEvents.off('discovery', onDiscovery);
  kolHunterEvents.off('paper_entry', onPaperEntry);
  kolHunterEvents.off('paper_close', onPaperClose);
  initialized = false;
  notifierRef = null;
  digest = emptyDigest();
}

/** Test helper — accumulator state inspection */
export function __getDigestStateForTests(): Readonly<DigestState> {
  return digest;
}

export function __resetDigestForTests(): void {
  digest = emptyDigest();
}
