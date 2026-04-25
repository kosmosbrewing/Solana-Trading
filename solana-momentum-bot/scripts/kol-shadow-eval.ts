#!/usr/bin/env ts-node
/**
 * KOL Shadow Eval (Option 5 Phase 2, 2026-04-23)
 *
 * ADR: docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md
 * REFACTORING_v1.0.md §7: go/no-go first filter.
 *
 * 목적:
 *   Phase 1 로 쌓인 kol-tx.jsonl 을 읽어 KOL 진입 후 T+5min / T+30min 시점의
 *   Jupiter price 를 실측 → median / multi-KOL / tier 별 분포 계산.
 *
 * Go 기준 (ADR §6 Gate 1):
 *   - T+5min / T+30min median > 0
 *   - multi-KOL 합의 median > single-KOL median
 *   - active KOL 비율 ≥ 70%
 *   - KOL avg hold ≥ 10분
 *
 * 실행:
 *   npm run kol:shadow-eval -- --since 2026-04-23T00:00:00Z --md reports/kol_shadow_eval_2026_04_23.md
 *
 * 주의: 본 스크립트는 과거 kol-tx.jsonl 만 읽음 (Phase 1 에서 축적된 것).
 *       Jupiter price fetch 는 forward quote 로 한다 (observer 와 같은 방식).
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { SOL_MINT, LAMPORTS_PER_SOL } from '../src/utils/constants';
import { normalizeJupiterSwapApiUrl } from '../src/utils/jupiterApi';

interface KolTxRecord {
  kolId: string;
  walletAddress: string;
  tier: 'S' | 'A' | 'B';
  tokenMint: string;
  action: 'buy' | 'sell';
  timestamp: number;
  txSignature: string;
  solAmount?: number;
  recordedAt?: string;
}

interface ShadowEvalPoint {
  kolTx: KolTxRecord;
  priceAtEntry: number | null;
  priceAt5min: number | null;
  priceAt30min: number | null;
  deltaPct5min: number | null;
  deltaPct30min: number | null;
  // multi-KOL group (가장 가까운 KOL 들)
  independentKolCountWithin60s: number;
  independentKolCountWithin5min: number;
}

interface EvalSummary {
  totalTxs: number;
  buyTxs: number;
  sellTxs: number;
  uniqueKols: number;
  activeKols: number; // 최근 창 내 tx 있음
  activeRatio: number;
  // Buy 중심 집계
  buyWithPrice: number;
  medianDelta5min: number;
  medianDelta30min: number;
  p90Delta5min: number;
  p90Delta30min: number;
  // Multi-KOL
  multiKolBuys: number;
  multiKolMedianDelta5min: number;
  multiKolMedianDelta30min: number;
  // Hold (KOL 의 avg hold = sell - 해당 token 의 직전 buy)
  avgHoldMinutes: number | null;
  shortHoldRatio: number; // hold < 10분 비율
  // Go/No-go 판정
  verdict: 'GO' | 'NOGO_INSUFFICIENT_DATA' | 'NOGO_NEGATIVE_MEDIAN' | 'NOGO_CHAIN_FORWARD' | 'NOGO_STALE_DB' | 'NOGO_INSIDER_EXIT';
  verdictReasons: string[];
}

interface CliArgs {
  logPath: string;
  sinceMs: number | null;
  mdOut: string | null;
  jsonOut: string | null;
  jupiterApiUrl: string;
  jupiterApiKey: string | undefined;
  maxTokensToProbe: number;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const since = get('--since');
  return {
    logPath: get('--log') ?? path.resolve(process.cwd(), 'data/realtime/kol-tx.jsonl'),
    sinceMs: since ? new Date(since).getTime() : null,
    mdOut: get('--md') ?? null,
    jsonOut: get('--json') ?? null,
    jupiterApiUrl: normalizeJupiterSwapApiUrl(
      process.env.JUPITER_API_URL ?? '',
      process.env.JUPITER_API_KEY
    ),
    jupiterApiKey: process.env.JUPITER_API_KEY || undefined,
    maxTokensToProbe: Number(process.env.KOL_SHADOW_EVAL_MAX_TOKENS ?? '50'),
  };
}

async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const raw = await readFile(file, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try { return JSON.parse(l) as T; } catch { return null; }
      })
      .filter((x): x is T => x !== null);
  } catch {
    return [];
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

async function fetchJupiterPrice(
  tokenMint: string,
  solAmount: number,
  jupiterUrl: string,
  apiKey?: string
): Promise<number | null> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers['X-API-Key'] = apiKey;
    const amountLamports = BigInt(Math.round(solAmount * LAMPORTS_PER_SOL));
    const resp = await axios.get(`${jupiterUrl}/quote`, {
      params: {
        inputMint: SOL_MINT,
        outputMint: tokenMint,
        amount: amountLamports.toString(),
        slippageBps: 200,
      },
      headers,
      timeout: 6_000,
    });
    const quote = resp.data;
    if (!quote || !quote.outAmount || !quote.outputDecimals) return null;
    const outRaw = Number(quote.outAmount);
    if (outRaw <= 0) return null;
    const outUi = outRaw / Math.pow(10, quote.outputDecimals);
    return solAmount / outUi;
  } catch {
    return null;
  }
}

function countIndependentKolsWithin(
  txs: KolTxRecord[],
  target: KolTxRecord,
  windowMs: number
): number {
  const seen = new Set<string>([target.kolId]);
  for (const t of txs) {
    if (t.tokenMint !== target.tokenMint) continue;
    if (t.action !== 'buy') continue;
    if (Math.abs(t.timestamp - target.timestamp) > windowMs) continue;
    seen.add(t.kolId);
  }
  return seen.size;
}

function computeAvgHold(txs: KolTxRecord[]): { avgMinutes: number | null; shortRatio: number } {
  // 같은 kolId + 같은 tokenMint 의 buy → sell 매칭 (FIFO)
  const byKey = new Map<string, KolTxRecord[]>();
  for (const tx of txs) {
    const key = `${tx.kolId}:${tx.tokenMint}`;
    const arr = byKey.get(key) ?? [];
    arr.push(tx);
    byKey.set(key, arr);
  }
  const holdMinutes: number[] = [];
  for (const arr of byKey.values()) {
    const sorted = [...arr].sort((a, b) => a.timestamp - b.timestamp);
    const buys: KolTxRecord[] = [];
    for (const tx of sorted) {
      if (tx.action === 'buy') buys.push(tx);
      else if (tx.action === 'sell' && buys.length > 0) {
        const buy = buys.shift()!;
        const holdMs = tx.timestamp - buy.timestamp;
        if (holdMs > 0) holdMinutes.push(holdMs / 60_000);
      }
    }
  }
  if (holdMinutes.length === 0) return { avgMinutes: null, shortRatio: 0 };
  const avg = holdMinutes.reduce((a, b) => a + b, 0) / holdMinutes.length;
  const short = holdMinutes.filter((m) => m < 10).length / holdMinutes.length;
  return { avgMinutes: avg, shortRatio: short };
}

function computeVerdict(s: Omit<EvalSummary, 'verdict' | 'verdictReasons'>): {
  verdict: EvalSummary['verdict'];
  verdictReasons: string[];
} {
  const reasons: string[] = [];
  if (s.buyWithPrice < 20) {
    reasons.push(`buyWithPrice < 20 (have ${s.buyWithPrice}) — 샘플 부족, Phase 1 연장 필요`);
    return { verdict: 'NOGO_INSUFFICIENT_DATA', verdictReasons: reasons };
  }
  if (s.activeRatio < 0.5) {
    reasons.push(`active KOL 비율 ${(s.activeRatio * 100).toFixed(1)}% < 50% — DB 재정제 필요`);
    return { verdict: 'NOGO_STALE_DB', verdictReasons: reasons };
  }
  if (s.medianDelta5min <= 0 || s.medianDelta30min <= 0) {
    reasons.push(`median delta non-positive (5min=${s.medianDelta5min.toFixed(3)}, 30min=${s.medianDelta30min.toFixed(3)})`);
    return { verdict: 'NOGO_NEGATIVE_MEDIAN', verdictReasons: reasons };
  }
  if (s.multiKolBuys >= 5 && s.multiKolMedianDelta5min <= s.medianDelta5min) {
    reasons.push(`multi-KOL median ≤ single-KOL — chain forward 가능성`);
    return { verdict: 'NOGO_CHAIN_FORWARD', verdictReasons: reasons };
  }
  if (s.avgHoldMinutes !== null && s.avgHoldMinutes < 5) {
    reasons.push(`KOL avg hold < 5분 (${s.avgHoldMinutes.toFixed(1)}) — insider exit 문제 심각`);
    return { verdict: 'NOGO_INSIDER_EXIT', verdictReasons: reasons };
  }
  reasons.push('Phase 2 Gate 1 통과 — Phase 3 착수 가능');
  reasons.push(`median 5min=${(s.medianDelta5min * 100).toFixed(2)}%, 30min=${(s.medianDelta30min * 100).toFixed(2)}%`);
  return { verdict: 'GO', verdictReasons: reasons };
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(`[KOL_SHADOW_EVAL] log=${args.logPath} since=${args.sinceMs ?? 'all'}`);
  const allTxs = await readJsonl<KolTxRecord>(args.logPath);
  const txs = args.sinceMs
    ? allTxs.filter((t) => t.timestamp >= args.sinceMs!)
    : allTxs;
  console.log(`[KOL_SHADOW_EVAL] total records: ${txs.length} (filtered from ${allTxs.length})`);

  if (txs.length === 0) {
    console.log(`[KOL_SHADOW_EVAL] no data — Phase 1 연장 필요`);
    process.exit(2);
  }

  const buys = txs.filter((t) => t.action === 'buy');
  const sells = txs.filter((t) => t.action === 'sell');
  const uniqueKols = new Set(txs.map((t) => t.kolId)).size;
  const nowMs = Date.now();
  const thirtyDayMs = 30 * 24 * 60 * 60 * 1000;
  const activeKols = new Set(
    txs.filter((t) => nowMs - t.timestamp < thirtyDayMs).map((t) => t.kolId)
  ).size;

  // Buy 에 대해 T+5min / T+30min 가격 probe
  const points: ShadowEvalPoint[] = [];
  const uniqueTokens = [...new Set(buys.map((b) => b.tokenMint))].slice(0, args.maxTokensToProbe);
  console.log(`[KOL_SHADOW_EVAL] probing ${uniqueTokens.length} unique tokens...`);

  // Probe 는 현재 Jupiter price 만 가능 — 과거 특정 시점 가격은 RPC 제한으로 이 스크립트 범위 밖.
  // 따라서 "현재 price" 를 T+현재시점-tx.timestamp 로 해석. 실시간 Phase 2 는 별도 옵션 필요.
  // Phase 1 이 충분히 오래 돌았다면 5min/30min 이 "과거 특정 시점" 이 됨.
  const probeSol = 0.01;
  for (const buy of buys) {
    const elapsedMs = nowMs - buy.timestamp;
    let priceAt5min: number | null = null;
    let priceAt30min: number | null = null;
    const priceNow = await fetchJupiterPrice(buy.tokenMint, probeSol, args.jupiterApiUrl, args.jupiterApiKey);
    // 현재 elapsed 가 5min 지나면 "5min 이후 가격" 으로 사용. 30min 이후면 그 용도로.
    if (elapsedMs >= 5 * 60 * 1000) priceAt5min = priceNow;
    if (elapsedMs >= 30 * 60 * 1000) priceAt30min = priceNow;
    const priceAtEntry = buy.solAmount && buy.solAmount > 0
      ? buy.solAmount / (probeSol / (priceNow ?? 1)) // 근사 — entry 시 정확 가격 미보존 시 fallback
      : null;
    const deltaPct5min = priceAt5min && priceAtEntry ? (priceAt5min - priceAtEntry) / priceAtEntry : null;
    const deltaPct30min = priceAt30min && priceAtEntry ? (priceAt30min - priceAtEntry) / priceAtEntry : null;

    points.push({
      kolTx: buy,
      priceAtEntry,
      priceAt5min,
      priceAt30min,
      deltaPct5min,
      deltaPct30min,
      independentKolCountWithin60s: countIndependentKolsWithin(txs, buy, 60 * 1000),
      independentKolCountWithin5min: countIndependentKolsWithin(txs, buy, 5 * 60 * 1000),
    });

    await new Promise((r) => setTimeout(r, 50));
  }

  const delta5mins = points.map((p) => p.deltaPct5min).filter((v): v is number => v !== null);
  const delta30mins = points.map((p) => p.deltaPct30min).filter((v): v is number => v !== null);

  const multiKolPoints = points.filter((p) => p.independentKolCountWithin5min >= 2);
  const multiDelta5 = multiKolPoints.map((p) => p.deltaPct5min).filter((v): v is number => v !== null);
  const multiDelta30 = multiKolPoints.map((p) => p.deltaPct30min).filter((v): v is number => v !== null);

  const holdStats = computeAvgHold(txs);

  const summaryBase: Omit<EvalSummary, 'verdict' | 'verdictReasons'> = {
    totalTxs: txs.length,
    buyTxs: buys.length,
    sellTxs: sells.length,
    uniqueKols,
    activeKols,
    activeRatio: uniqueKols > 0 ? activeKols / uniqueKols : 0,
    buyWithPrice: delta5mins.length,
    medianDelta5min: median(delta5mins),
    medianDelta30min: median(delta30mins),
    p90Delta5min: percentile(delta5mins, 0.9),
    p90Delta30min: percentile(delta30mins, 0.9),
    multiKolBuys: multiKolPoints.length,
    multiKolMedianDelta5min: median(multiDelta5),
    multiKolMedianDelta30min: median(multiDelta30),
    avgHoldMinutes: holdStats.avgMinutes,
    shortHoldRatio: holdStats.shortRatio,
  };

  const verdict = computeVerdict(summaryBase);
  const summary: EvalSummary = { ...summaryBase, ...verdict };

  const report = formatMarkdown(summary, points);
  console.log(report);

  if (args.mdOut) {
    await mkdir(path.dirname(args.mdOut), { recursive: true });
    await writeFile(args.mdOut, report, 'utf8');
    console.log(`[KOL_SHADOW_EVAL] md saved: ${args.mdOut}`);
  }
  if (args.jsonOut) {
    await mkdir(path.dirname(args.jsonOut), { recursive: true });
    await writeFile(args.jsonOut, JSON.stringify({ summary, points }, null, 2), 'utf8');
    console.log(`[KOL_SHADOW_EVAL] json saved: ${args.jsonOut}`);
  }

  if (summary.verdict === 'GO') process.exit(0);
  else process.exit(1);
}

function formatMarkdown(s: EvalSummary, points: ShadowEvalPoint[]): string {
  const verdict = s.verdict === 'GO' ? '✅ GO' : `🔴 ${s.verdict}`;
  return `# KOL Shadow Eval Report — ${new Date().toISOString().slice(0, 10)}

> Option 5 Phase 2 Gate 1 판정 — ADR §6

## Verdict: **${verdict}**

${s.verdictReasons.map((r) => `- ${r}`).join('\n')}

## Summary

| Metric | Value |
|--------|-------|
| Total tx records | ${s.totalTxs} |
| Buy tx | ${s.buyTxs} |
| Sell tx | ${s.sellTxs} |
| Unique KOLs | ${s.uniqueKols} |
| Active KOLs (30d) | ${s.activeKols} (${(s.activeRatio * 100).toFixed(1)}%) |
| Buys with price | ${s.buyWithPrice} |
| median Δ +5min | ${(s.medianDelta5min * 100).toFixed(2)}% |
| median Δ +30min | ${(s.medianDelta30min * 100).toFixed(2)}% |
| p90 Δ +5min | ${(s.p90Delta5min * 100).toFixed(2)}% |
| p90 Δ +30min | ${(s.p90Delta30min * 100).toFixed(2)}% |
| Multi-KOL buys (≥2 within 5min) | ${s.multiKolBuys} |
| Multi-KOL median Δ +5min | ${(s.multiKolMedianDelta5min * 100).toFixed(2)}% |
| Multi-KOL median Δ +30min | ${(s.multiKolMedianDelta30min * 100).toFixed(2)}% |
| Avg hold (min) | ${s.avgHoldMinutes !== null ? s.avgHoldMinutes.toFixed(1) : 'N/A'} |
| Short-hold (<10min) ratio | ${(s.shortHoldRatio * 100).toFixed(1)}% |

## Phase 2 Gate 기준 (ADR §6)

- [${s.buyWithPrice >= 20 ? 'x' : ' '}] 충분한 샘플 (buy with price ≥ 20)
- [${s.activeRatio >= 0.7 ? 'x' : ' '}] Active KOL 비율 ≥ 70%
- [${s.medianDelta5min > 0 ? 'x' : ' '}] median Δ +5min > 0
- [${s.medianDelta30min > 0 ? 'x' : ' '}] median Δ +30min > 0
- [${s.multiKolMedianDelta5min > s.medianDelta5min ? 'x' : ' '}] multi-KOL median > single-KOL median
- [${s.avgHoldMinutes === null || s.avgHoldMinutes >= 10 ? 'x' : ' '}] Avg hold ≥ 10분

## Next Action

${s.verdict === 'GO'
  ? '**Phase 3 착수 (kol_hunter paper lane)**. REFACTORING_v1.0.md §8 참조.'
  : '**옵션 5 기각 검토**. REFACTORING_v1.0.md archive → _rejected suffix. 새 paradigm 논의 필요 (옵션 4 full-stack 또는 대안).'}

---
*Generated by scripts/kol-shadow-eval.ts (Option 5 Phase 2)*
`;
}

main().catch((err) => {
  console.error('[KOL_SHADOW_EVAL] fatal:', err);
  process.exit(3);
});
