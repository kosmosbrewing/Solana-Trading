#!/usr/bin/env ts-node
/**
 * KOL Metrics Analyzer (2026-04-29)
 *
 * Why: kol-classify-helper.ts 가 notes 텍스트에서 lane/style 을 추정한다면, 이 script 는
 *   실제 22k 행의 kol-tx.jsonl tx 스트림에서 정량 metric (avg ticket, median hold,
 *   re-buy density, time-to-first-sell, unique mints) 을 계산하여 자동 4-class 분류한다.
 *
 *   외부 트레이더 피드백 + Phase 0B 분류 정합성 검증 용. notes 와 실측이 어긋나는
 *   KOL 을 빠르게 식별 → manual review 우선순위화.
 *
 * Mission alignment: Stage 1 Safety Pass — KOL DB 신뢰성. 분류 mismatch 가 누적되면
 *   style-aware insider_exit 가 wrong cohort 에 적용되어 cupsey/pure_ws 와 무관하게
 *   real asset 손실 가능. observability guard.
 *
 * Usage:
 *   npx ts-node scripts/kol-metrics-analyzer.ts                  # 분석만 (stdout + json)
 *   npx ts-node scripts/kol-metrics-analyzer.ts --update-wallets # wallets.json 자동 갱신
 *
 * 안전:
 *   - active KOL 만 처리 (inactive 무시)
 *   - --update-wallets 시 lane_role / addresses / tier / notes / is_active 등 모든 다른
 *     field 보존, trading_style 만 갱신 (in-place rewrite, JSON.stringify 4 indent)
 *   - sample 부족 (<10 tx) 은 'unknown' → 기존 trading_style 유지 (덮어쓰기 안 함)
 *   - jsonl 파싱 실패 라인 skip (count 만 기록)
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AutoStyle =
  | 'scalper'
  | 'momentum_confirmer'
  | 'swing_accumulator'
  | 'whale'
  | 'unknown';

export interface KolTxRecord {
  kolId: string;
  walletAddress: string;
  tier: 'S' | 'A' | 'B';
  tokenMint: string;
  action: 'buy' | 'sell';
  timestamp: number; // ms epoch
  txSignature: string;
  solAmount?: number;
  recordedAt?: string;
}

export interface KolMetric {
  kolId: string;
  txCount30d: number;
  buyCount30d: number;
  sellCount30d: number;
  avgTicketSol: number;
  medianHoldTimeMs: number;
  reBuyDensity: number;
  timeToFirstSellMs: number;
  uniqueMintsBought30d: number;
}

export interface KolAnalysisRow {
  kolId: string;
  tier: string;
  currentStyle: string; // wallets.json 의 trading_style (없으면 'unset')
  autoStyle: AutoStyle;
  diff: 'match' | 'change' | 'newly_classified' | 'sample_too_small';
  metric: KolMetric;
}

export interface AnalysisOutput {
  generatedAt: string;
  txWindowDays: number;
  parsedLines: number;
  skippedLines: number;
  activeKolCount: number;
  rows: KolAnalysisRow[];
}

// ─── Pure functions (test 가능) ───────────────────────────────────────────────

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const RE_BUY_WINDOW_MS = 60 * 1000;
const SAMPLE_FLOOR = 10;
const WHALE_TICKET_SOL = 5.0;
const SCALPER_HOLD_CUTOFF_MS = 5 * 60 * 1000; // 5분
const SWING_HOLD_CUTOFF_MS = 60 * 60 * 1000; // 1h

/**
 * Outlier-robust median: top 5% / bottom 5% 제거 후 중앙값.
 * sample size 가 너무 작으면 (n<3) trim 안 함 (정보 손실 방지).
 */
export function trimmedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length < 3) {
    return sorted[Math.floor(sorted.length / 2)];
  }
  const lo = Math.floor(sorted.length * 0.05);
  const hi = Math.ceil(sorted.length * 0.95); // exclusive
  const trimmed = sorted.slice(lo, hi);
  if (trimmed.length === 0) return sorted[Math.floor(sorted.length / 2)];
  const mid = Math.floor(trimmed.length / 2);
  return trimmed.length % 2 === 0
    ? (trimmed[mid - 1] + trimmed[mid]) / 2
    : trimmed[mid];
}

/**
 * KOL 별 metric 계산. tx 는 timestamp asc 정렬되어 있다고 가정 안 함 (내부 정렬).
 * 30일 window 는 가장 최근 tx timestamp 기준 (live cutoff 가 아님 — historical replay 시 정합).
 */
export function computeKolMetric(kolId: string, txs: KolTxRecord[]): KolMetric {
  const empty: KolMetric = {
    kolId,
    txCount30d: 0,
    buyCount30d: 0,
    sellCount30d: 0,
    avgTicketSol: 0,
    medianHoldTimeMs: 0,
    reBuyDensity: 0,
    timeToFirstSellMs: 0,
    uniqueMintsBought30d: 0,
  };
  if (txs.length === 0) return empty;

  const sorted = [...txs].sort((a, b) => a.timestamp - b.timestamp);
  const cutoff = sorted[sorted.length - 1].timestamp - THIRTY_DAYS_MS;
  const recent = sorted.filter((t) => t.timestamp >= cutoff);
  if (recent.length === 0) return empty;

  const buys = recent.filter((t) => t.action === 'buy');
  const sells = recent.filter((t) => t.action === 'sell');

  const tickets = buys
    .map((t) => t.solAmount ?? 0)
    .filter((v) => Number.isFinite(v) && v > 0);
  const avgTicketSol =
    tickets.length > 0 ? tickets.reduce((a, b) => a + b, 0) / tickets.length : 0;

  // mint 별 buy → 첫 sell 매칭. 같은 mint 의 첫 buy timestamp → 같은 mint 의 첫 sell timestamp.
  const firstBuyByMint = new Map<string, number>();
  const firstSellByMint = new Map<string, number>();
  for (const tx of recent) {
    if (tx.action === 'buy' && !firstBuyByMint.has(tx.tokenMint)) {
      firstBuyByMint.set(tx.tokenMint, tx.timestamp);
    }
    if (tx.action === 'sell' && !firstSellByMint.has(tx.tokenMint)) {
      firstSellByMint.set(tx.tokenMint, tx.timestamp);
    }
  }
  const holdDurations: number[] = [];
  const timeToSells: number[] = [];
  for (const [mint, buyTs] of firstBuyByMint.entries()) {
    const sellTs = firstSellByMint.get(mint);
    if (sellTs != null && sellTs >= buyTs) {
      holdDurations.push(sellTs - buyTs);
      timeToSells.push(sellTs - buyTs);
    }
  }
  const medianHoldTimeMs = trimmedMedian(holdDurations);
  const timeToFirstSellMs = trimmedMedian(timeToSells);

  // re-buy density: mint 별 첫 buy 후 60s 이내 추가 buy 횟수 평균.
  const buysByMint = new Map<string, KolTxRecord[]>();
  for (const tx of buys) {
    const arr = buysByMint.get(tx.tokenMint) ?? [];
    arr.push(tx);
    buysByMint.set(tx.tokenMint, arr);
  }
  let totalReBuys = 0;
  let mintsWithBuy = 0;
  for (const arr of buysByMint.values()) {
    if (arr.length === 0) continue;
    mintsWithBuy++;
    const first = arr[0].timestamp;
    const reBuys = arr.filter((t, i) => i > 0 && t.timestamp - first <= RE_BUY_WINDOW_MS).length;
    totalReBuys += reBuys;
  }
  const reBuyDensity = mintsWithBuy > 0 ? totalReBuys / mintsWithBuy : 0;

  const uniqueMintsBought30d = new Set(buys.map((t) => t.tokenMint)).size;

  return {
    kolId,
    txCount30d: recent.length,
    buyCount30d: buys.length,
    sellCount30d: sells.length,
    avgTicketSol,
    medianHoldTimeMs,
    reBuyDensity,
    timeToFirstSellMs,
    uniqueMintsBought30d,
  };
}

/**
 * 자동 4-class 분류. 우선순위:
 *   1. sample 부족 (<10) → unknown
 *   2. avg ticket ≥ 5 SOL → whale
 *   3. median hold < 5분 → scalper
 *   4. median hold > 1h → swing_accumulator
 *   5. else → momentum_confirmer
 */
export function classifyStyle(m: KolMetric): AutoStyle {
  if (m.txCount30d < SAMPLE_FLOOR) return 'unknown';
  if (m.avgTicketSol >= WHALE_TICKET_SOL) return 'whale';
  if (m.medianHoldTimeMs > 0 && m.medianHoldTimeMs < SCALPER_HOLD_CUTOFF_MS) return 'scalper';
  if (m.medianHoldTimeMs > SWING_HOLD_CUTOFF_MS) return 'swing_accumulator';
  return 'momentum_confirmer';
}

/**
 * diff bucket 결정. wallets.json 갱신 정책 입력.
 *   - sample_too_small: auto=unknown — 갱신 skip
 *   - newly_classified: 기존 trading_style 미설정 + auto != unknown
 *   - match: 기존 == auto
 *   - change: 기존 != auto (운영자 review 필요)
 */
export function diffStyle(
  current: string | undefined,
  auto: AutoStyle,
): KolAnalysisRow['diff'] {
  if (auto === 'unknown') return 'sample_too_small';
  if (!current || current === 'unknown' || current === 'unset') return 'newly_classified';
  if (current === auto) return 'match';
  return 'change';
}

// ─── I/O orchestration (script-level) ────────────────────────────────────────

interface KolWalletRaw {
  id: string;
  addresses: string[];
  tier: string;
  is_active: boolean;
  trading_style?: string;
  [key: string]: unknown;
}

interface KolDbRaw {
  version?: string | number;
  last_updated?: string;
  kols: KolWalletRaw[];
  [key: string]: unknown;
}

/**
 * jsonl 파싱 — 실패 라인은 skip + count.
 * 22k 행을 통째 읽기 — 메모리 ~수십 MB OK.
 */
async function parseKolTxJsonl(filePath: string): Promise<{
  records: KolTxRecord[];
  parsed: number;
  skipped: number;
}> {
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.split('\n');
  const records: KolTxRecord[] = [];
  let skipped = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (
        typeof obj.kolId === 'string' &&
        typeof obj.tokenMint === 'string' &&
        (obj.action === 'buy' || obj.action === 'sell') &&
        typeof obj.timestamp === 'number'
      ) {
        records.push(obj as KolTxRecord);
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }
  return { records, parsed: records.length, skipped };
}

function groupByKol(records: KolTxRecord[]): Map<string, KolTxRecord[]> {
  const map = new Map<string, KolTxRecord[]>();
  for (const r of records) {
    const arr = map.get(r.kolId) ?? [];
    arr.push(r);
    map.set(r.kolId, arr);
  }
  return map;
}

function formatTable(rows: KolAnalysisRow[]): string {
  const header =
    '| kolId | tier | current | auto | diff | n | buy | sell | avg_ticket | hold_med | re_buy | unique_mints |';
  const sep =
    '|-------|------|---------|------|------|---|-----|------|------------|----------|--------|--------------|';
  const body = rows.map((r) => {
    const m = r.metric;
    const holdMin = (m.medianHoldTimeMs / 60000).toFixed(1);
    return `| ${r.kolId} | ${r.tier} | ${r.currentStyle} | ${r.autoStyle} | ${r.diff} | ${m.txCount30d} | ${m.buyCount30d} | ${m.sellCount30d} | ${m.avgTicketSol.toFixed(3)} | ${holdMin}m | ${m.reBuyDensity.toFixed(2)} | ${m.uniqueMintsBought30d} |`;
  });
  return [header, sep, ...body].join('\n');
}

export function buildAnalysis(
  txRecords: KolTxRecord[],
  activeKols: KolWalletRaw[],
): KolAnalysisRow[] {
  const grouped = groupByKol(txRecords);
  const rows: KolAnalysisRow[] = [];
  for (const wallet of activeKols) {
    const txs = grouped.get(wallet.id) ?? [];
    const metric = computeKolMetric(wallet.id, txs);
    const auto = classifyStyle(metric);
    const current = wallet.trading_style ?? 'unset';
    rows.push({
      kolId: wallet.id,
      tier: wallet.tier,
      currentStyle: current,
      autoStyle: auto,
      diff: diffStyle(wallet.trading_style, auto),
      metric,
    });
  }
  // diff 우선 정렬: change > newly_classified > match > sample_too_small
  const order: Record<KolAnalysisRow['diff'], number> = {
    change: 0,
    newly_classified: 1,
    match: 2,
    sample_too_small: 3,
  };
  rows.sort((a, b) => order[a.diff] - order[b.diff] || a.kolId.localeCompare(b.kolId));
  return rows;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const updateWallets = args.includes('--update-wallets');

  const root = process.cwd();
  const txPath = path.resolve(root, 'data/realtime/kol-tx.jsonl');
  const walletsPath = path.resolve(root, 'data/kol/wallets.json');
  const outDir = path.resolve(root, 'data/kol');
  const outPath = path.join(outDir, 'style-analysis.json');

  const [{ records, parsed, skipped }, walletsRaw] = await Promise.all([
    parseKolTxJsonl(txPath),
    readFile(walletsPath, 'utf8'),
  ]);
  const db = JSON.parse(walletsRaw) as KolDbRaw;
  const activeKols = db.kols.filter((k) => k.is_active);

  const rows = buildAnalysis(records, activeKols);

  const output: AnalysisOutput = {
    generatedAt: new Date().toISOString(),
    txWindowDays: 30,
    parsedLines: parsed,
    skippedLines: skipped,
    activeKolCount: activeKols.length,
    rows,
  };

  // stdout
  console.log(`# KOL Metrics Analysis (${output.generatedAt})`);
  console.log(`parsed_lines=${parsed}, skipped_lines=${skipped}, active_kols=${activeKols.length}`);
  console.log('');
  console.log(formatTable(rows));
  console.log('');

  // diff 요약
  const summary = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.diff] = (acc[r.diff] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`## Diff summary`);
  for (const k of ['change', 'newly_classified', 'match', 'sample_too_small'] as const) {
    console.log(`- ${k}: ${summary[k] ?? 0}`);
  }
  console.log('');

  // 파일 저장
  await mkdir(outDir, { recursive: true });
  await writeFile(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`written: ${outPath}`);

  if (updateWallets) {
    let updated = 0;
    for (const wallet of db.kols) {
      if (!wallet.is_active) continue;
      const row = rows.find((r) => r.kolId === wallet.id);
      if (!row) continue;
      // sample_too_small 은 갱신 skip — 기존 운영자 분류 보존
      if (row.diff === 'sample_too_small') continue;
      // 변화 없으면 skip
      if (row.diff === 'match') continue;
      wallet.trading_style = row.autoStyle;
      updated++;
    }
    await writeFile(walletsPath, JSON.stringify(db, null, 2) + '\n', 'utf8');
    console.log(`updated wallets: ${updated} (rewrote ${walletsPath})`);
  } else {
    console.log(`(dry-run; pass --update-wallets to mutate wallets.json)`);
  }
}

// 직접 실행 시에만 main 호출 (test 에서 import 할 때 부작용 없음)
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
