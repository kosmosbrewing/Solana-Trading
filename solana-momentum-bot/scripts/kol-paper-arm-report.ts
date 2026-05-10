#!/usr/bin/env ts-node
/**
 * KOL Paper Arm Report
 *
 * Reads `kol-paper-trades.jsonl` directly. This is intentionally separate from
 * Lane Edge Controller P1, because P1 is wallet-truth/live-reconciled and must
 * not treat paper-only outcomes as Kelly-eligible.
 */
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

interface CliArgs {
  inputFile: string;
  mdOut?: string;
  jsonOut?: string;
  sinceMs?: number;
}

interface PaperTradeRecord {
  positionId: string;
  tokenMint: string;
  armName?: string;
  profileArm?: string;
  parameterVersion?: string;
  kolEntryReason?: string;
  kolConvictionLevel?: string;
  isShadowArm?: boolean;
  /**
   * 2026-04-28 (Option B): inactive (shadow) KOL paper trade marker.
   * 별도 ledger (`kol-shadow-paper-trades.jsonl`) 로 분리되지만, 향후 merge 시 또는
   * 운영자가 명시적으로 shadow 파일을 --in 으로 전달했을 때 active 분포에 섞이지 않게
   * defensive filter 적용 (main 의 line 186 참조).
   */
  isShadowKol?: boolean;
  parentPositionId?: string | null;
  netSol?: number;
  netPct?: number;
  mfePctPeak?: number;
  // 2026-05-01 (Sprint Y1 wire): token-only / wallet-based 분리 측정.
  //   사명 §3 5x judgement 은 mfePctPeakTokenOnly 사용 (paper/live 통일).
  //   legacy 데이터 (mfePctPeak 만 있는 경우) 는 mfePctPeak fallback.
  mfePctPeakTokenOnly?: number;
  mfePctPeakWalletBased?: number;
  entryPriceTokenOnly?: number;
  entryPriceWalletDelta?: number;
  ataRentSol?: number;
  swapInputSol?: number;
  // 2026-05-01 (Sprint Z — Codex 권고): netPct/maePct/exitPrice/netSol token-only.
  //   stop 정책 평가 (winner-kill / hard_cut 보수성 / big-loss 분포) 시 wallet-delta 만 보면 inflation.
  //   token-only 측정으로 정책 학습 정확도 회복 — wallet floor 보호는 그대로 wallet-delta.
  exitPriceTokenOnly?: number;
  maePctTokenOnly?: number;
  netPctTokenOnly?: number;
  netSolTokenOnly?: number;
  maePct?: number;
  holdSec?: number;
  exitReason?: string;
  t1VisitAtSec?: number | null;
  t2VisitAtSec?: number | null;
  t3VisitAtSec?: number | null;
  closedAt?: string;
}

interface ArmSummary {
  armName: string;
  parameterVersions: string[];
  trades: number;
  shadowTrades: number;
  netSol: number;
  avgNetPct: number;
  winRate: number;
  t1Visits: number;
  t2Visits: number;
  t3Visits: number;
  avgMfePct: number;
  p90MfePct: number;
  avgMaePct: number;
  medianHoldSec: number;
  exitReasons: Record<string, number>;
  // 2026-05-01 (Sprint Y1): 사명 §3 5x judgement — token-only entry 기반.
  fivexCountTokenOnly: number;        // mfePctPeakTokenOnly >= 4.0 (사명 §3 정합)
  fivexCountWalletBased: number;      // mfePctPeakWalletBased >= 4.0 (Real Asset Guard view)
  // ATA rent inflation 영향 monitor — 두 값 차이가 ATA rent 의 5x peak 측정 영향
  fivexInflationGap: number;          // tokenOnly - walletBased (양수면 wallet-based 가 winner missed)
  // 2026-05-01 (Sprint Z — Codex 권고): stop 정책 평가용 token-only metric.
  //   wallet-delta cum_net 은 ATA rent 분 손실 인플레이션 → 정책 보수화 위험.
  //   token-only cum_net + big-loss rate 가 실제 token 가격 변동 기반 stop 평가 정확.
  netSolTokenOnly: number;            // sum (rent 제외)
  netSolWalletBased: number;          // sum (현재 netSol 과 동일, 명시화)
  bigLossRateTokenOnly: number;       // netPctTokenOnly ≤ -20% 비율
  bigLossRateWalletBased: number;     // netPct ≤ -20% 비율 (현재)
  avgNetPctTokenOnly: number;         // mean(netPctTokenOnly)
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const since = get('--since');
  const today = new Date().toISOString().slice(0, 10);
  return {
    inputFile: get('--in') ?? path.resolve(process.cwd(), 'data/realtime/kol-paper-trades.jsonl'),
    mdOut: get('--md') ?? path.resolve(process.cwd(), `reports/kol-paper-arms-${today}.md`),
    jsonOut: get('--json') ?? path.resolve(process.cwd(), `reports/kol-paper-arms-${today}.json`),
    sinceMs: since ? new Date(since).getTime() : undefined,
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

function armNameOf(row: PaperTradeRecord): string {
  const arm = row.profileArm ?? row.armName ?? row.parameterVersion ?? 'unknown';
  if (!row.kolEntryReason) return arm;
  return `${arm}/${row.kolEntryReason}/${row.kolConvictionLevel ?? 'UNKNOWN'}`;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function mean(xs: number[]): number {
  return xs.length > 0 ? sum(xs) / xs.length : 0;
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[idx];
}

function summarizeArm(armName: string, rows: PaperTradeRecord[]): ArmSummary {
  const pnls = rows.map((r) => r.netSol).filter((v): v is number => typeof v === 'number');
  const decisive = pnls.filter((p) => p !== 0);
  const exitReasons: Record<string, number> = {};
  for (const r of rows) {
    const reason = r.exitReason ?? 'unknown';
    exitReasons[reason] = (exitReasons[reason] ?? 0) + 1;
  }
  // 2026-05-01 (Sprint Y1): 사명 §3 5x judgement.
  //   tokenOnly 우선 (paper/live 통일), legacy row 는 mfePctPeak fallback.
  const FIVEX_THRESHOLD = 4.0;  // mfe peak ≥ +400% = 5x
  const fivexTokenOnly = rows.filter((r) => {
    const v = r.mfePctPeakTokenOnly ?? r.mfePctPeak ?? 0;
    return v >= FIVEX_THRESHOLD;
  }).length;
  const fivexWalletBased = rows.filter((r) => {
    const v = r.mfePctPeakWalletBased ?? r.mfePctPeak ?? 0;
    return v >= FIVEX_THRESHOLD;
  }).length;
  // 2026-05-01 (Sprint Z): Token-only metric — stop 정책 평가 정확도 회복.
  //   legacy row (netPctTokenOnly 미기록) 는 netPct fallback. paper 는 두 값 동일.
  const BIG_LOSS_THRESHOLD = -0.20;
  const tokenNetPcts = rows.map((r) => r.netPctTokenOnly ?? r.netPct ?? 0);
  const walletNetPcts = rows.map((r) => r.netPct ?? 0);
  const tokenNetSols = rows.map((r) => r.netSolTokenOnly ?? r.netSol ?? 0);
  const bigLossTokenOnlyN = tokenNetPcts.filter((p) => p <= BIG_LOSS_THRESHOLD).length;
  const bigLossWalletBasedN = walletNetPcts.filter((p) => p <= BIG_LOSS_THRESHOLD).length;
  return {
    armName,
    parameterVersions: [...new Set(rows.map((r) => r.parameterVersion).filter((v): v is string => !!v))].sort(),
    trades: rows.length,
    shadowTrades: rows.filter((r) => r.isShadowArm).length,
    netSol: sum(pnls),
    avgNetPct: mean(rows.map((r) => r.netPct ?? 0)),
    winRate: decisive.length > 0 ? decisive.filter((p) => p > 0).length / decisive.length : 0,
    t1Visits: rows.filter((r) => r.t1VisitAtSec != null).length,
    t2Visits: rows.filter((r) => r.t2VisitAtSec != null).length,
    t3Visits: rows.filter((r) => r.t3VisitAtSec != null).length,
    avgMfePct: mean(rows.map((r) => r.mfePctPeak ?? 0)),
    p90MfePct: quantile(rows.map((r) => r.mfePctPeak ?? 0), 0.9),
    avgMaePct: mean(rows.map((r) => r.maePct ?? 0)),
    medianHoldSec: quantile(rows.map((r) => r.holdSec ?? 0), 0.5),
    exitReasons,
    fivexCountTokenOnly: fivexTokenOnly,
    fivexCountWalletBased: fivexWalletBased,
    fivexInflationGap: fivexTokenOnly - fivexWalletBased,
    netSolTokenOnly: sum(tokenNetSols),
    netSolWalletBased: sum(pnls),
    bigLossRateTokenOnly: rows.length > 0 ? bigLossTokenOnlyN / rows.length : 0,
    bigLossRateWalletBased: rows.length > 0 ? bigLossWalletBasedN / rows.length : 0,
    avgNetPctTokenOnly: mean(tokenNetPcts),
  };
}

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

function sol(v: number): string {
  return v.toFixed(6);
}

function formatMarkdown(rows: PaperTradeRecord[], summaries: ArmSummary[]): string {
  const lines: string[] = [];
  lines.push(`# KOL Paper Arm Report - ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push('> Paper-only arm comparison. This does not unlock Kelly, sizing, or live throttle.');
  lines.push('');
  lines.push(`- Total paper closes: ${rows.length}`);
  lines.push(`- Arms: ${summaries.length}`);
  lines.push('');
  lines.push('| Arm | Trades | Shadow | Net SOL | Win Rate | Avg Net | T1 | T2 | T3 | Avg MFE | P90 MFE | Avg MAE | Median Hold | 5x Token | 5x Wallet |');
  lines.push('|-----|--------|--------|---------|----------|---------|----|----|----|---------|---------|---------|-------------|----------|-----------|');
  for (const s of summaries) {
    // 2026-05-01 (Sprint Y1): 5x token-only / wallet-based 분리 표시.
    //   gap > 0 = wallet-based 가 ATA rent inflation 으로 winner missed.
    const gapMark = s.fivexInflationGap > 0 ? ` ⚠+${s.fivexInflationGap}` : '';
    lines.push(
      `| ${s.armName} | ${s.trades} | ${s.shadowTrades} | ${sol(s.netSol)} | ${pct(s.winRate)} | ` +
      `${pct(s.avgNetPct)} | ${s.t1Visits} | ${s.t2Visits} | ${s.t3Visits} | ${pct(s.avgMfePct)} | ` +
      `${pct(s.p90MfePct)} | ${pct(s.avgMaePct)} | ${s.medianHoldSec.toFixed(0)}s | ` +
      `${s.fivexCountTokenOnly}${gapMark} | ${s.fivexCountWalletBased} |`
    );
  }
  lines.push('');
  lines.push('> 5x judgement: mfe peak ≥ +400% (사명 §3 정합). Token = entryPriceTokenOnly 기반 (paper/live 통일). Wallet = entryPriceWalletDelta (ATA rent 포함). Gap 양수 = ATA rent inflation 으로 winner missed (Sprint X 측정 fix 효과).');
  lines.push('');

  // 2026-05-01 (Sprint Z — Codex 권고): Token-only vs Wallet-based 손익 분리 — stop 정책 평가용.
  // wallet-delta 만 보면 ATA rent inflation 으로 정책이 보수적으로 보임. token-only 가 실 token 가격 변동.
  lines.push('## Stop Policy Evaluation (Sprint Z — Codex 권고)');
  lines.push('');
  lines.push('> wallet-delta 손익 = wallet floor 보호 정합. token-only 손익 = ATA rent 분 차감 안 함, 실 token 가격 변동 = stop 정책 (hard_cut / sentinel / quick_reject) 보수성 평가용.');
  lines.push('> Big-loss rate gap (wallet > token) = ATA rent 로 인해 정책이 inflated big-loss 학습 위험 (운영자 manual rent 회수 후 재산 변동은 token 기준).');
  lines.push('');
  lines.push('| Arm | Net SOL Wallet | Net SOL Token | Big-loss Wallet | Big-loss Token | Big-loss Gap | Avg Net% Wallet | Avg Net% Token |');
  lines.push('|-----|----------------|---------------|-----------------|----------------|--------------|-----------------|----------------|');
  for (const s of summaries) {
    const blGap = s.bigLossRateWalletBased - s.bigLossRateTokenOnly;
    const blGapMark = blGap > 0.01 ? ` ⚠+${pct(blGap)}` : '';
    lines.push(
      `| ${s.armName} | ${sol(s.netSolWalletBased)} | ${sol(s.netSolTokenOnly)} | ` +
      `${pct(s.bigLossRateWalletBased)} | ${pct(s.bigLossRateTokenOnly)} | ${blGap >= 0 ? '+' : ''}${pct(blGap)}${blGapMark} | ` +
      `${pct(s.avgNetPct)} | ${pct(s.avgNetPctTokenOnly)} |`
    );
  }
  lines.push('');
  lines.push('## Exit Reasons');
  lines.push('');
  for (const s of summaries) {
    const reasons = Object.entries(s.exitReasons)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${reason}=${n}`)
      .join(', ');
    lines.push(`- ${s.armName}: ${reasons || 'n/a'}`);
  }
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs();
  const loaded = await readJsonl<PaperTradeRecord>(args.inputFile);
  // 2026-04-28: defensive filter — inputFile 에 shadow KOL paper trade 가 섞여 있으면 제외.
  // 정상 운영에서는 active ledger (`kol-paper-trades.jsonl`) 만 읽지만, 향후 merge 또는
  // 운영자 실수로 shadow 파일이 같이 와도 active arm 통계 무결성 유지.
  const activeOnly = loaded.filter((r) => !r.isShadowKol);
  const rows = args.sinceMs
    ? activeOnly.filter((r) => r.closedAt && new Date(r.closedAt).getTime() >= args.sinceMs!)
    : activeOnly;
  const groups = new Map<string, PaperTradeRecord[]>();
  for (const row of rows) {
    const key = armNameOf(row);
    const arr = groups.get(key) ?? [];
    arr.push(row);
    groups.set(key, arr);
  }
  const summaries = [...groups.entries()]
    .map(([armName, armRows]) => summarizeArm(armName, armRows))
    .sort((a, b) => b.netSol - a.netSol || a.armName.localeCompare(b.armName));

  if (args.mdOut) {
    await mkdir(path.dirname(args.mdOut), { recursive: true });
    await writeFile(args.mdOut, formatMarkdown(rows, summaries), 'utf8');
  }
  if (args.jsonOut) {
    await mkdir(path.dirname(args.jsonOut), { recursive: true });
    await writeFile(args.jsonOut, JSON.stringify({ generatedAt: new Date().toISOString(), rows: rows.length, summaries }, null, 2), 'utf8');
  }

  console.log(`[kol-paper-arm-report] rows=${rows.length} arms=${summaries.length}`);
  for (const s of summaries) {
    console.log(`[${s.armName}] n=${s.trades} shadow=${s.shadowTrades} net=${sol(s.netSol)}SOL T2=${s.t2Visits}`);
  }
}

void main().catch((err) => {
  console.error(`[kol-paper-arm-report] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
