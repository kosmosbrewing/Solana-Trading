/**
 * KOL daily eval summary (L3, 2026-04-26).
 *
 * Reads `${realtimeDataDir}/kol-paper-trades.jsonl` for last 24h, groups by armName
 * (kol_hunter_v1 / smart_v3 / swing_v2), and produces an A/B comparison message
 * sent via `notifier.sendInfo(msg, 'kol_daily')`.
 *
 * 호출 지점: src/orchestration/reporting.ts 의 sendDailySummaryReport 끝부분에서
 * paperMetrics / regimeFilter sendInfo 같이 sequential 로 호출. 24h 거래 0건이면 skip.
 */
import { readFile } from 'fs/promises';
import path from 'path';
import type { Notifier } from '../notifier';
import { config } from '../utils/config';
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('KolDailySummary');

interface PaperLedgerRecord {
  positionId: string;
  tokenMint: string;
  netSol: number;
  netPct: number;
  mfePctPeak: number;
  holdSec: number;
  exitReason: string;
  t1VisitAtSec: number | null;
  t2VisitAtSec: number | null;
  t3VisitAtSec: number | null;
  armName: string;
  parameterVersion: string;
  isShadowArm: boolean;
  closedAt: string;  // ISO timestamp
}

interface ArmStats {
  entries: number;
  netSolSum: number;
  winners5xByVisit: number;       // t2VisitAtSec set
  winners10xByVisit: number;      // t3VisitAtSec set
  totalHoldSec: number;
  t2Visits: number;
  bestNetPct: number;
  bestPeakPct: number;
}

function emptyStats(): ArmStats {
  return {
    entries: 0,
    netSolSum: 0,
    winners5xByVisit: 0,
    winners10xByVisit: 0,
    totalHoldSec: 0,
    t2Visits: 0,
    bestNetPct: -Infinity,
    bestPeakPct: -Infinity,
  };
}

async function loadLast24hRecords(): Promise<PaperLedgerRecord[]> {
  const ledgerPath = path.join(config.realtimeDataDir, 'kol-paper-trades.jsonl');
  let raw: string;
  try {
    raw = await readFile(ledgerPath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const cutoffMs = Date.now() - 24 * 3600 * 1000;
  const records: PaperLedgerRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as PaperLedgerRecord;
      if (new Date(rec.closedAt).getTime() >= cutoffMs) records.push(rec);
    } catch {
      // skip malformed line
    }
  }
  return records;
}

function buildSummary(records: PaperLedgerRecord[]): string | null {
  if (records.length === 0) return null;

  const byArm = new Map<string, ArmStats>();
  for (const r of records) {
    const arm = r.armName || 'kol_hunter_v1';
    if (!byArm.has(arm)) byArm.set(arm, emptyStats());
    const s = byArm.get(arm)!;
    s.entries++;
    s.netSolSum += r.netSol;
    s.totalHoldSec += r.holdSec;
    if (r.t2VisitAtSec) {
      s.winners5xByVisit++;
      s.t2Visits++;
    }
    if (r.t3VisitAtSec) s.winners10xByVisit++;
    if (r.netPct > s.bestNetPct) s.bestNetPct = r.netPct;
    if (r.mfePctPeak > s.bestPeakPct) s.bestPeakPct = r.mfePctPeak;
  }

  const lines: string[] = [];
  lines.push(`[KOL DAILY ${new Date().toISOString().slice(0, 10)}]`);
  lines.push(`  total: ${records.length} closed (last 24h)`);
  lines.push('');
  lines.push('  arm                     entries  netSol     win5x  win10x  avgHold  bestNet  bestPeak');
  lines.push('  ──────────────────────  ───────  ─────────  ─────  ──────  ───────  ───────  ────────');

  // 정렬: netSolSum desc → 최고 성과 arm 위로
  const sortedArms = [...byArm.entries()].sort((a, b) => b[1].netSolSum - a[1].netSolSum);
  for (const [arm, s] of sortedArms) {
    const armPad = arm.padEnd(22);
    const entriesPad = String(s.entries).padStart(7);
    const netSign = s.netSolSum >= 0 ? '+' : '';
    const netPad = `${netSign}${s.netSolSum.toFixed(4)}`.padStart(9);
    const w5xPad = String(s.winners5xByVisit).padStart(5);
    const w10xPad = String(s.winners10xByVisit).padStart(6);
    const avgHoldMin = s.entries > 0 ? Math.round(s.totalHoldSec / s.entries / 60) : 0;
    const avgHoldPad = `${avgHoldMin}min`.padStart(7);
    const bestNetSign = s.bestNetPct >= 0 ? '+' : '';
    const bestNetPad = isFinite(s.bestNetPct)
      ? `${bestNetSign}${(s.bestNetPct * 100).toFixed(0)}%`.padStart(7)
      : '   n/a';
    const bestPeakPad = isFinite(s.bestPeakPct)
      ? `+${(s.bestPeakPct * 100).toFixed(0)}%`.padStart(8)
      : '    n/a';
    lines.push(`  ${armPad}  ${entriesPad}  ${netPad}  ${w5xPad}  ${w10xPad}  ${avgHoldPad}  ${bestNetPad}  ${bestPeakPad}`);
  }

  // 결정 hint — 가장 net 좋은 arm vs 두번째 비교
  if (sortedArms.length >= 2) {
    const [topArm, topStats] = sortedArms[0];
    const [, secondStats] = sortedArms[1];
    const lead = topStats.netSolSum - secondStats.netSolSum;
    if (Math.abs(lead) > 0.001) {
      const armShort = topArm.replace('kol_hunter_', '');
      lines.push('');
      lines.push(`  → ${armShort} lead: +${lead.toFixed(4)} SOL vs runner-up`);
    }
  }

  return lines.join('\n');
}

export async function sendKolDailySummary(notifier: Notifier): Promise<void> {
  try {
    const records = await loadLast24hRecords();
    const message = buildSummary(records);
    if (!message) {
      log.debug('KOL daily summary skipped — no records in last 24h');
      return;
    }
    await notifier.sendInfo(message, 'kol_daily');
  } catch (err) {
    log.warn(`KOL daily summary failed: ${err}`);
  }
}
