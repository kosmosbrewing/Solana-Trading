/**
 * KOL Wallet Style Backfill (2026-05-01, Stream G).
 *
 * ADR: docs/exec-plans/active/helius-credit-edge-plan-2026-05-01.md §6 Stream G
 *
 * 목적: KOL wallet 의 follower-perspective behavior 정량 측정 →
 *       lane_role / trading_style 자동 분류 (운영자 검토용 diff report).
 *
 * 정책 (Plan §6 Stream G + §11 rollout rule 4):
 *   - **KOL DB auto-mutation 0** — script 가 직접 wallets.json 수정 금지
 *   - 산출: `data/research/kol-wallet-style-backfill.jsonl` + diff report markdown (append-only)
 *   - 운영자가 수동 편집 (cupsey_benchmark / observation_only 패턴 동일)
 *   - script 는 `data/kol/` write 시도 hard fail
 *
 * 2026-05-01 (Codex F3 fix): 본 sprint 는 **local jsonl 만** 사용 (Helius RPC 미사용).
 *   `getTransactionsForAddress` (Wallet API, 50c) wiring 은 follow-up sprint — 현재 script 는
 *   기존 운영 데이터 (kol-tx.jsonl / kol-paper-trades.jsonl) 만 분석.
 *
 * Inputs (local only — RPC 0):
 *   - data/realtime/kol-tx.jsonl  (KOL 활동 source — kolWalletTracker emit)
 *   - data/realtime/kol-paper-trades.jsonl  (paper close outcomes)
 *   - data/kol/wallets.json  (현재 lane_role / trading_style 비교)
 *
 * Output:
 *   - data/research/kol-wallet-style-backfill.jsonl  (raw metrics)
 *   - data/research/kol-wallet-style-diff-YYYY-MM-DD.md  (diff report)
 *
 * Usage:
 *   npx ts-node scripts/kol-wallet-style-backfill.ts --since 30d
 */

import { readFile, writeFile, mkdir, appendFile } from 'fs/promises';
import path from 'path';

interface BackfillArgs {
  sinceMs: number;
  realtimeDir: string;
  researchDir: string;
  kolDbPath: string;
  dryRun: boolean;
}

/** Plan §6 Stream G metric list. */
export interface KolStyleMetrics {
  kolId: string;
  /** 측정 sample 수 (buy 횟수) */
  sampleCount: number;
  /** 평균 hold time (sec) — buy 부터 sell 까지 */
  avgHoldSec?: number;
  /** quick sell 비율 (hold < 5 분) */
  quickSellRatio?: number;
  /** 같은 token 재진입 빈도 */
  sameTokenReEntryRatio?: number;
  /** 진입 후 follow-on buy density (다른 KOL 도 buy 한 비율) */
  followOnBuyDensity?: number;
  /** post-buy T+5m / T+30m median return — kol-paper-trades join 으로 산출 */
  postBuyT5mMedianPct?: number;
  postBuyT30mMedianPct?: number;
  /** sell signal reliability — KOL sell 한 token 의 후속 가격 하락 비율 */
  sellSignalReliability?: number;
  /** copyability score (0-1) — 위 metric 합산 */
  copyabilityScore?: number;
  /** 추천 role */
  suggestedLaneRole: 'copy_core' | 'discovery_canary' | 'observer' | 'unknown';
  /** 추천 trading style */
  suggestedTradingStyle: 'longhold' | 'swing' | 'scalper' | 'unknown';
}

const STYLE_SCHEMA_VERSION = 'kol-wallet-style/v1' as const;

interface BackfillRecord extends KolStyleMetrics {
  schemaVersion: typeof STYLE_SCHEMA_VERSION;
  computedAtIso: string;
  windowSinceMs: number;
}

function parseSince(input: string): number {
  const m = input.match(/^(\d+)([dhm])$/);
  if (!m) throw new Error(`invalid --since '${input}', expected NNd / NNh / NNm`);
  const n = Number(m[1]);
  const unit = m[2];
  const ms = unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : 60000;
  return Date.now() - n * ms;
}

function parseArgs(argv: string[]): BackfillArgs {
  const args: Partial<BackfillArgs> = {
    realtimeDir: path.resolve(process.cwd(), 'data/realtime'),
    researchDir: path.resolve(process.cwd(), 'data/research'),
    kolDbPath: path.resolve(process.cwd(), 'data/kol/wallets.json'),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since') args.sinceMs = parseSince(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--realtime-dir') args.realtimeDir = argv[++i];
    else if (a === '--research-dir') args.researchDir = argv[++i];
  }
  if (typeof args.sinceMs !== 'number') {
    args.sinceMs = Date.now() - 30 * 86400000; // default 30d
  }
  return args as BackfillArgs;
}

async function readJsonlSafe(filePath: string): Promise<Array<Record<string, unknown>>> {
  try {
    const content = await readFile(filePath, 'utf8');
    return content.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

interface KolTxRow {
  kolId: string;
  tokenMint: string;
  action: 'buy' | 'sell';
  timestamp: number;
}

interface PaperTradeRow {
  positionId: string;
  tokenMint: string;
  entryTimeSec: number;
  exitTimeSec: number;
  netPct: number;
  mfePctPeak?: number;
  kols?: Array<{ id: string }>;
}

/**
 * pure metric computation — KOL tx + paper trade rows → KolStyleMetrics 산출.
 * Plan §11 rollout rule 4 정합 — KOL DB 직접 mutation 0.
 */
export function computeStyleMetrics(
  kolId: string,
  kolTxs: KolTxRow[],
  paperTrades: PaperTradeRow[],
  windowSinceMs: number,
): KolStyleMetrics {
  // window 안 KOL 활동만 필터
  const windowedTxs = kolTxs.filter((t) => t.kolId === kolId && t.timestamp >= windowSinceMs);
  const buys = windowedTxs.filter((t) => t.action === 'buy');
  const sells = windowedTxs.filter((t) => t.action === 'sell');

  if (buys.length === 0) {
    return {
      kolId,
      sampleCount: 0,
      suggestedLaneRole: 'unknown',
      suggestedTradingStyle: 'unknown',
    };
  }

  // 1. avg hold (buy → sell pair, 같은 token 매칭)
  const holdsSec: number[] = [];
  let quickSells = 0;
  for (const buy of buys) {
    const matchSell = sells.find(
      (s) => s.tokenMint === buy.tokenMint && s.timestamp > buy.timestamp,
    );
    if (matchSell) {
      const holdSec = (matchSell.timestamp - buy.timestamp) / 1000;
      holdsSec.push(holdSec);
      if (holdSec < 300) quickSells += 1;
    }
  }
  const avgHoldSec = holdsSec.length > 0
    ? holdsSec.reduce((s, x) => s + x, 0) / holdsSec.length
    : undefined;
  const quickSellRatio = holdsSec.length > 0 ? quickSells / holdsSec.length : undefined;

  // 2. same-token re-entry — buy 한 token 을 다시 buy
  const tokenBuyCount = new Map<string, number>();
  for (const buy of buys) {
    tokenBuyCount.set(buy.tokenMint, (tokenBuyCount.get(buy.tokenMint) ?? 0) + 1);
  }
  const reEntryTokens = Array.from(tokenBuyCount.values()).filter((c) => c >= 2).length;
  const sameTokenReEntryRatio = tokenBuyCount.size > 0 ? reEntryTokens / tokenBuyCount.size : 0;

  // 3. post-buy T+5m / T+30m median (paper trades 의 entry 기준)
  // 단순화: paper trade 의 mfePctPeak 가 hold 안 peak 도달이라 5m / 30m 근사 어려움.
  //   본 sprint 는 mfePctPeak 평균만 산출 (median 은 follow-up 확장).
  const ptForKol = paperTrades.filter((p) => p.kols?.some((k) => k.id === kolId));
  const mfeSamples = ptForKol
    .map((p) => p.mfePctPeak)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);
  const postBuyT5mMedianPct = mfeSamples.length > 0
    ? mfeSamples[Math.floor(mfeSamples.length / 2)]
    : undefined;
  // T30m 도 동일 source — 별도 column 으로 표현 (실 분리는 follow-up).
  const postBuyT30mMedianPct = postBuyT5mMedianPct;

  // 4. sell signal reliability — sell 한 token 의 후속 가격 하락 비율 (paper 에서 측정 어려움 — stub)
  const sellSignalReliability = undefined;

  // 5. follow-on buy density — paper trade 의 다른 KOL 동시 buy 비율
  const followOnPositions = ptForKol.filter((p) => (p.kols?.length ?? 0) >= 2).length;
  const followOnBuyDensity = ptForKol.length > 0 ? followOnPositions / ptForKol.length : 0;

  // 6. copyability score — heuristic 합산
  // - quickSellRatio 낮음 (≤30%) +0.3
  // - avgHoldSec ≥1h +0.2
  // - sameTokenReEntryRatio 낮음 (≤20%) +0.1
  // - followOnBuyDensity ≥30% +0.2
  // - postBuyT5mMedianPct ≥ 30% +0.2
  let copyabilityScore = 0;
  if (typeof quickSellRatio === 'number' && quickSellRatio <= 0.3) copyabilityScore += 0.3;
  if (typeof avgHoldSec === 'number' && avgHoldSec >= 3600) copyabilityScore += 0.2;
  if (sameTokenReEntryRatio <= 0.2) copyabilityScore += 0.1;
  if (followOnBuyDensity >= 0.3) copyabilityScore += 0.2;
  if (typeof postBuyT5mMedianPct === 'number' && postBuyT5mMedianPct >= 0.3) copyabilityScore += 0.2;

  // 7. role / style 추천
  const suggestedLaneRole = inferLaneRole({ avgHoldSec, copyabilityScore, quickSellRatio });
  const suggestedTradingStyle = inferTradingStyle({ avgHoldSec, quickSellRatio });

  return {
    kolId,
    sampleCount: buys.length,
    avgHoldSec,
    quickSellRatio,
    sameTokenReEntryRatio,
    followOnBuyDensity,
    postBuyT5mMedianPct,
    postBuyT30mMedianPct,
    sellSignalReliability,
    copyabilityScore,
    suggestedLaneRole,
    suggestedTradingStyle,
  };
}

export function inferLaneRole(input: {
  avgHoldSec?: number;
  copyabilityScore?: number;
  quickSellRatio?: number;
}): KolStyleMetrics['suggestedLaneRole'] {
  // copyabilityScore ≥ 0.7 + avgHold ≥ 1h → copy_core
  // copyabilityScore ≥ 0.4 + quickSell <= 60% → discovery_canary
  // 그 외 → observer (또는 unknown if no data)
  if (typeof input.copyabilityScore !== 'number' || typeof input.avgHoldSec !== 'number') {
    return 'unknown';
  }
  if (input.copyabilityScore >= 0.7 && input.avgHoldSec >= 3600) return 'copy_core';
  if (input.copyabilityScore >= 0.4 && (input.quickSellRatio ?? 1) <= 0.6) return 'discovery_canary';
  return 'observer';
}

export function inferTradingStyle(input: {
  avgHoldSec?: number;
  quickSellRatio?: number;
}): KolStyleMetrics['suggestedTradingStyle'] {
  if (typeof input.avgHoldSec !== 'number') return 'unknown';
  // ≥ 24h hold 평균 → longhold
  // 1h ~ 24h → swing
  // < 1h + quickSell ≥ 50% → scalper
  if (input.avgHoldSec >= 86400) return 'longhold';
  if (input.avgHoldSec >= 3600) return 'swing';
  if ((input.quickSellRatio ?? 0) >= 0.5) return 'scalper';
  return 'unknown';
}

interface KolDbWalletEntry {
  id: string;
  is_active?: boolean;
  lane_role?: string;
  trading_style?: string;
}

interface DiffEntry {
  kolId: string;
  currentLaneRole?: string;
  suggestedLaneRole: string;
  currentTradingStyle?: string;
  suggestedTradingStyle: string;
  category: 'PROMOTE' | 'DEMOTE' | 'RECLASSIFY' | 'NO_CHANGE';
  metrics: KolStyleMetrics;
}

export function classifyDiff(
  current: KolDbWalletEntry | undefined,
  metrics: KolStyleMetrics,
): DiffEntry['category'] {
  if (!current) return 'RECLASSIFY';
  const sameRole = (current.lane_role ?? 'unknown') === metrics.suggestedLaneRole;
  const sameStyle = (current.trading_style ?? 'unknown') === metrics.suggestedTradingStyle;
  if (sameRole && sameStyle) return 'NO_CHANGE';
  // copy_core 승격은 PROMOTE / observer 강등은 DEMOTE / 그 외 RECLASSIFY
  if (
    current.lane_role !== 'copy_core' &&
    metrics.suggestedLaneRole === 'copy_core'
  ) return 'PROMOTE';
  if (
    current.lane_role !== 'observer' &&
    metrics.suggestedLaneRole === 'observer'
  ) return 'DEMOTE';
  return 'RECLASSIFY';
}

export function buildDiffReport(diffs: DiffEntry[]): string {
  const promote = diffs.filter((d) => d.category === 'PROMOTE');
  const demote = diffs.filter((d) => d.category === 'DEMOTE');
  const reclassify = diffs.filter((d) => d.category === 'RECLASSIFY');

  let md = `# KOL Wallet Style Backfill — Diff Report (${new Date().toISOString().slice(0, 10)})\n\n`;
  md += `**Schema**: \`${STYLE_SCHEMA_VERSION}\`\n\n`;
  md += `**Policy** (Plan §11 rollout rule 4): KOL DB auto-mutation 0. Operator manual review only.\n\n`;
  md += `## Summary\n\n`;
  md += `- PROMOTE: ${promote.length}\n`;
  md += `- DEMOTE: ${demote.length}\n`;
  md += `- RECLASSIFY: ${reclassify.length}\n`;
  md += `- NO_CHANGE: ${diffs.filter((d) => d.category === 'NO_CHANGE').length}\n\n`;

  for (const [section, list] of [['PROMOTE', promote], ['DEMOTE', demote], ['RECLASSIFY', reclassify]] as const) {
    if (list.length === 0) continue;
    md += `## ${section}\n\n`;
    md += `| KOL | current role | suggested role | current style | suggested style | sample | copy score | avg hold |\n`;
    md += `|---|---|---|---|---|---:|---:|---:|\n`;
    for (const d of list) {
      md += `| ${d.kolId} | ${d.currentLaneRole ?? '-'} | ${d.suggestedLaneRole} | ${d.currentTradingStyle ?? '-'} | ${d.suggestedTradingStyle} | ${d.metrics.sampleCount} | ${d.metrics.copyabilityScore?.toFixed(2) ?? '-'} | ${d.metrics.avgHoldSec ? Math.round(d.metrics.avgHoldSec) + 's' : '-'} |\n`;
    }
    md += `\n`;
  }
  return md;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[wallet-style-backfill] since=${new Date(args.sinceMs).toISOString()} dryRun=${args.dryRun}`);
  console.warn(
    '[wallet-style-backfill] WARNING: KOL DB auto-mutation 0 (Plan §11 rollout rule 4). ' +
    'Operator must apply changes manually based on diff report.',
  );

  // 1. inputs
  const [kolTxsRaw, paperTradesRaw] = await Promise.all([
    readJsonlSafe(path.join(args.realtimeDir, 'kol-tx.jsonl')),
    readJsonlSafe(path.join(args.realtimeDir, 'kol-paper-trades.jsonl')),
  ]);
  const kolTxs = kolTxsRaw as unknown as KolTxRow[];
  const paperTrades = paperTradesRaw as unknown as PaperTradeRow[];
  const dbContent = await readFile(args.kolDbPath, 'utf8').catch(() => null);
  if (!dbContent) {
    console.error(`[wallet-style-backfill] cannot read KOL DB at ${args.kolDbPath}`);
    return;
  }
  const db = JSON.parse(dbContent) as { kols: KolDbWalletEntry[] };

  // 2. compute per active KOL
  const activeKols = db.kols.filter((k) => k.is_active === true);
  console.log(`[wallet-style-backfill] active KOLs: ${activeKols.length}`);

  const diffs: DiffEntry[] = [];
  const records: BackfillRecord[] = [];
  for (const kol of activeKols) {
    const metrics = computeStyleMetrics(kol.id, kolTxs, paperTrades, args.sinceMs);
    const cat = classifyDiff(kol, metrics);
    diffs.push({
      kolId: kol.id,
      currentLaneRole: kol.lane_role,
      suggestedLaneRole: metrics.suggestedLaneRole,
      currentTradingStyle: kol.trading_style,
      suggestedTradingStyle: metrics.suggestedTradingStyle,
      category: cat,
      metrics,
    });
    records.push({
      schemaVersion: STYLE_SCHEMA_VERSION,
      computedAtIso: new Date().toISOString(),
      windowSinceMs: args.sinceMs,
      ...metrics,
    });
  }

  // 3. outputs (data/research/ 만 — data/kol/ write 절대 금지)
  if (args.dryRun) {
    console.log(`[wallet-style-backfill] dry-run — skipping file writes`);
    console.log(`[wallet-style-backfill] would write ${records.length} records + diff report`);
    return;
  }

  // safety: ensure output path is in data/research/ only
  const researchAbs = path.resolve(args.researchDir);
  if (!researchAbs.includes('research')) {
    throw new Error(`[wallet-style-backfill] researchDir must be data/research/ — got ${researchAbs}`);
  }

  // 2026-05-01 (Codex F3 fix): mkdir + jsonl append-only + fail-open.
  //   기존: writeFile 가 throw → script 전체 fatal.
  //   현재: mkdir 실패 / append 실패 / diff write 실패 모두 log only, throw 안 함 (fail-open sidecar 정합).
  try {
    await mkdir(researchAbs, { recursive: true });
  } catch (err) {
    console.error(`[wallet-style-backfill] mkdir failed (fail-open continue): ${String(err)}`);
    return;
  }

  const jsonlPath = path.join(researchAbs, 'kol-wallet-style-backfill.jsonl');
  const lines = records.map((r) => JSON.stringify(r) + '\n').join('');
  // append-only — 이전 run 의 jsonl row 보존 (운영자가 historical trend 분석 가능).
  try {
    await appendFile(jsonlPath, lines, 'utf8');
    console.log(`[wallet-style-backfill] appended ${records.length} records → ${jsonlPath}`);
  } catch (err) {
    console.error(`[wallet-style-backfill] jsonl append failed (fail-open continue): ${String(err)}`);
  }

  // diff report — date 기반 file 이라 동일 날 재실행 시 overwrite (정상 — 가장 최근 snapshot 만 보존).
  // append 가 markdown 에는 부적절하므로 writeFile 그대로 사용. 실패 시 fail-open.
  const dateStr = new Date().toISOString().slice(0, 10);
  const diffPath = path.join(researchAbs, `kol-wallet-style-diff-${dateStr}.md`);
  const md = buildDiffReport(diffs);
  try {
    await writeFile(diffPath, md, 'utf8');
    console.log(`[wallet-style-backfill] wrote diff report → ${diffPath}`);
  } catch (err) {
    console.error(`[wallet-style-backfill] diff report write failed (fail-open continue): ${String(err)}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[wallet-style-backfill] fatal:', err);
    process.exit(1);
  });
}

export {
  parseSince,
  parseArgs,
  STYLE_SCHEMA_VERSION,
};
export type { KolDbWalletEntry, DiffEntry };
