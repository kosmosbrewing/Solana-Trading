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

  // 2026-05-01 모바일 wrap fix: 단일 row 가 텔레그램 모바일 폭 (~50 char) 초과 → 줄바꿈 발생.
  //   해결: arm 별 2-line block 으로 재배치. line1 = 핵심 (arm/n/net/win5x), line2 = 부가 (hold/best).
  //   source 명시 (paper-only) — live ledger 는 별도 파일이라 운영자 혼동 방지.
  const lines: string[] = [];
  lines.push(`[KOL DAILY ${new Date().toISOString().slice(0, 10)}] (paper-only)`);
  lines.push(`total: ${records.length} closed · 24h · live ledger 별도`);
  lines.push('');

  // 정렬: netSolSum desc → 최고 성과 arm 위로
  const sortedArms = [...byArm.entries()].sort((a, b) => b[1].netSolSum - a[1].netSolSum);
  for (const [arm, s] of sortedArms) {
    const armShort = arm.replace('kol_hunter_', '');
    const netSign = s.netSolSum >= 0 ? '+' : '';
    const netStr = `${netSign}${s.netSolSum.toFixed(4)} SOL`;
    const avgHoldMin = s.entries > 0 ? Math.round(s.totalHoldSec / s.entries / 60) : 0;
    const bestNetSign = s.bestNetPct >= 0 ? '+' : '';
    const bestNet = isFinite(s.bestNetPct) ? `${bestNetSign}${(s.bestNetPct * 100).toFixed(0)}%` : 'n/a';
    const bestPeak = isFinite(s.bestPeakPct) ? `+${(s.bestPeakPct * 100).toFixed(0)}%` : 'n/a';
    // win10x 가 0 이면 생략 (대부분 0 이라 noise)
    const winSegment = s.winners10xByVisit > 0
      ? `5x:${s.winners5xByVisit} 10x:${s.winners10xByVisit}`
      : `5x:${s.winners5xByVisit}`;

    // line1: 핵심 — arm / n / net / 5x
    lines.push(`▸ ${armShort}  n=${s.entries}  ${netStr}  ${winSegment}`);
    // line2: 부가 — avg hold / best net / best peak
    lines.push(`  hold=${avgHoldMin}min  best_net=${bestNet}  best_peak=${bestPeak}`);
  }

  // 결정 hint — 가장 net 좋은 arm vs 두번째 비교
  if (sortedArms.length >= 2) {
    const [topArm, topStats] = sortedArms[0];
    const [, secondStats] = sortedArms[1];
    const lead = topStats.netSolSum - secondStats.netSolSum;
    if (Math.abs(lead) > 0.001) {
      const armShort = topArm.replace('kol_hunter_', '');
      lines.push('');
      lines.push(`→ ${armShort} lead: +${lead.toFixed(4)} SOL vs runner-up`);
    }
  }

  return lines.join('\n');
}

export async function sendKolDailySummary(notifier: Notifier): Promise<void> {
  try {
    const records = await loadLast24hRecords();
    const message = buildSummary(records);
    if (!message) {
      // 2026-04-26 P0 audit fix #4: 0 records 는 silent skip 이 아니라 명시적 alert.
      // 사명 검증 데이터가 비어있는 채로 시간이 흐르는 것을 막기 위함 — tracker /
      // priceFeed 가 dead 인지 운영자가 즉시 인지해야 한다.
      const date = new Date().toISOString().slice(0, 10);
      const alert =
        `⚠ [KOL DAILY ${date}] no paper trades closed in last 24h\n` +
        `  가능한 원인:\n` +
        `  - KOL tracker subscriptions lost (Solana RPC churn)\n` +
        `  - paperPriceFeed Jupiter 429 / network down\n` +
        `  - KOL 활동 자체가 0 (구독 KOL 모두 휴면)\n` +
        `  점검: pm2 logs | grep -E "KOL_TRACKER|PAPER_PRICE"`;
      await notifier.sendInfo(alert, 'kol_daily');
      return;
    }
    await notifier.sendInfo(message, 'kol_daily');
  } catch (err) {
    log.warn(`KOL daily summary failed: ${err}`);
  }
}
