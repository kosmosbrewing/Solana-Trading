#!/usr/bin/env ts-node
/**
 * DSR + CSCV statistical validator for KOL paper trade outcomes.
 *
 * Why this exists:
 * - 우리가 paper sweep 으로 산출하는 SR / WR / netSol 은 multiple-testing /
 *   selection bias 위에 올라가 있음. parameterVersion 이 늘어날수록 "best 한
 *   arm 의 SR" 은 자연스럽게 부풀려진다.
 * - Bailey & López de Prado (2014) "Deflated Sharpe Ratio" 는 N 개 trial
 *   가운데 하나를 cherry-pick 했을 때의 SR 분포를 closed-form 으로 deflate
 *   하는 가장 가벼운 절차. 같은 논문 라인에서 PBO (Probability of Backtest
 *   Overfitting) 를 CSCV (Combinatorial Symmetric Cross-Validation) 로 푼다.
 *
 * 이 스크립트는 read-only — `data/realtime/kol-paper-trades.jsonl` 만 읽고
 * stdout markdown 만 뱉는다. 거래 / 사이징 / 라이브 throttle 에 영향 없음.
 *
 * 참고: Bailey, López de Prado (2014) "The Deflated Sharpe Ratio";
 *       López de Prado (2018) "Advances in Financial Machine Learning" Ch. 11.
 */
import { readFile } from 'fs/promises';
import path from 'path';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface PaperTradeRecord {
  positionId: string;
  tokenMint?: string;
  parameterVersion?: string;
  armName?: string;
  netSol?: number;
  netPct?: number;
  mfePctPeak?: number;
  maePct?: number;
  holdSec?: number;
  exitReason?: string;
  closedAt?: string;
  isShadowKol?: boolean;
  isShadowArm?: boolean;
}

export interface SharpeMoments {
  /** Sample size (T) used to compute the Sharpe ratio. */
  count: number;
  /** Mean of returns. */
  mean: number;
  /** Sample stdev (n-1 normalization). */
  stdev: number;
  /** Sample skewness γ3. */
  skewness: number;
  /** Sample kurtosis γ4 (NOT excess; matches Bailey/López de Prado convention). */
  kurtosis: number;
  /** Annualized=false here; we report per-trade SR (returns are per-trade). */
  sharpeRatio: number;
}

export interface DeflatedSharpeResult {
  moments: SharpeMoments;
  /** N_trials used for the deflation; defaults to unique parameterVersion count. */
  nTrials: number;
  /** Stdev of trials' SR (γ_SR). 0 if N=1 — falls back to a small floor. */
  trialsSrStd: number;
  /** Expected max SR under the null (E[max{SR_i}]). */
  sr0: number;
  /** Standard deviation of the SR estimator (Mertens / IID-asymptotic). */
  sigmaSr: number;
  /**
   * Probability that the true SR is greater than 0 after deflation.
   * = Φ((SR - SR0) / σ(SR)). Pass criterion: ≥ 0.95.
   */
  dsrProbability: number;
  /** SR - SR0 (raw deflation gap). Positive ⇒ candidate beats expected max. */
  rawDsr: number;
}

export interface CSCVOptions {
  /** Number of sub-blocks S (must be even). Defaults to 16. */
  blocks?: number;
  /** Random seed for deterministic block order in tests. */
  random?: () => number;
}

export interface CSCVResult {
  blocks: number;
  partitions: number;
  /** Probability that the in-sample best arm ranks below median OOS. */
  pbo: number;
  /** Number of partitions where in-sample best arm beat OOS median. */
  oosBeatsMedian: number;
  /** Mean OOS rank fraction of the in-sample best arm (0=worst, 1=best). */
  meanOosRankFraction: number;
}

export interface ArmReport {
  armKey: string;
  trades: number;
  netSol: number;
  winRate: number;
  dsr?: DeflatedSharpeResult;
  cscv?: CSCVResult;
}

// ────────────────────────────────────────────────────────────────────────────
// Pure math
// ────────────────────────────────────────────────────────────────────────────

const SQRT_2 = Math.sqrt(2);

/** erf approximation (Abramowitz & Stegun 7.1.26, max error ~1.5e-7). */
function erf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : -1;
  const sign = x >= 0 ? 1 : -1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF Φ(x) = ½·(1 + erf(x/√2)). */
export function standardNormalCdf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  return 0.5 * (1 + erf(x / SQRT_2));
}

/** Inverse standard normal CDF (Beasley-Springer/Moro). Used for E[max] under null. */
export function inverseStandardNormalCdf(p: number): number {
  if (!(p > 0 && p < 1)) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    return Number.NaN;
  }
  // Beasley-Springer / Moro approximation
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number;
  let r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > pHigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Compute first-four-moment Sharpe-related statistics. */
export function computeSharpeMoments(returns: number[]): SharpeMoments {
  const count = returns.length;
  if (count < 2) {
    return { count, mean: count === 1 ? returns[0] : 0, stdev: 0, skewness: 0, kurtosis: 3, sharpeRatio: 0 };
  }
  const mean = returns.reduce((a, b) => a + b, 0) / count;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const r of returns) {
    const d = r - mean;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  // Sample variance with (n-1); higher moments use 1/n raw central moments
  // (matches Bailey/López de Prado eq.1; small-sample bias correction is
  // dominated by SR uncertainty for our T~50-500 regime).
  const variance = m2 / (count - 1);
  const stdev = Math.sqrt(variance);
  if (!(stdev > 0)) {
    // Degenerate: all returns equal → SR undefined; treat as 0 (no edge).
    return { count, mean, stdev: 0, skewness: 0, kurtosis: 3, sharpeRatio: 0 };
  }
  const cm2 = m2 / count;
  const cm3 = m3 / count;
  const cm4 = m4 / count;
  const skewness = cm3 / Math.pow(cm2, 1.5);
  // γ4 (non-excess) — Bailey/LdP σ(SR) formula uses raw kurtosis
  const kurtosis = cm4 / (cm2 * cm2);
  const sharpeRatio = mean / stdev;
  return { count, mean, stdev, skewness, kurtosis, sharpeRatio };
}

/**
 * Mertens (2002) IID asymptotic σ(SR):
 *   σ(SR) = sqrt( (1 - γ3·SR + (γ4 - 1)/4 · SR²) / (T - 1) )
 * Falls back to sqrt(1/(T-1)) if the inside goes non-positive (heavy tails).
 */
export function sigmaSharpe(moments: SharpeMoments): number {
  const { count: T, sharpeRatio: sr, skewness: g3, kurtosis: g4 } = moments;
  if (T < 2) return Number.POSITIVE_INFINITY;
  const inside = 1 - g3 * sr + ((g4 - 1) / 4) * sr * sr;
  const safe = inside > 0 ? inside : 1; // fail-soft on degenerate higher moments
  return Math.sqrt(safe / (T - 1));
}

/**
 * E[max{SR_i: i=1..N}] under the null (SR=0) using Bailey/LdP eq. 7:
 *   E[max] ≈ γ_SR · ((1 - γ_E)·Φ⁻¹(1 - 1/N) + γ_E·Φ⁻¹(1 - 1/(N·e)))
 * where γ_E = Euler–Mascheroni 0.5772156649.
 * γ_SR is the cross-sectional stdev of trials' SR; if N=1 we return 0.
 */
export function expectedMaxSr(nTrials: number, trialsSrStd: number): number {
  if (nTrials <= 1) return 0;
  const gammaE = 0.5772156649015328606;
  const phiInvA = inverseStandardNormalCdf(1 - 1 / nTrials);
  const phiInvB = inverseStandardNormalCdf(1 - 1 / (nTrials * Math.E));
  return trialsSrStd * ((1 - gammaE) * phiInvA + gammaE * phiInvB);
}

/**
 * Compute Deflated Sharpe Ratio for a candidate strategy's returns.
 *
 * - `trialsSr` — population of SR values from the multiple-testing universe.
 *   If unknown, pass [candidate's SR]; γ_SR will collapse to a small floor
 *   (1/sqrt(T)) so that DSR reduces to a single-trial test.
 */
export function computeDSR(
  returns: number[],
  trialsSr: number[],
  nTrialsOverride?: number
): DeflatedSharpeResult {
  const moments = computeSharpeMoments(returns);
  const sigmaSr = sigmaSharpe(moments);
  const nTrials = Math.max(1, nTrialsOverride ?? trialsSr.length);

  let trialsSrStd: number;
  if (trialsSr.length >= 2) {
    const tMean = trialsSr.reduce((a, b) => a + b, 0) / trialsSr.length;
    const variance =
      trialsSr.reduce((acc, x) => acc + (x - tMean) * (x - tMean), 0) /
      (trialsSr.length - 1);
    trialsSrStd = Math.sqrt(variance);
  } else {
    // Unknown trial dispersion — use a conservative floor: σ(SR) of the candidate.
    trialsSrStd = sigmaSr;
  }
  if (!(trialsSrStd > 0)) trialsSrStd = sigmaSr;

  const sr0 = expectedMaxSr(nTrials, trialsSrStd);
  const rawDsr = moments.sharpeRatio - sr0;
  const z = sigmaSr > 0 ? rawDsr / sigmaSr : 0;
  const dsrProbability = standardNormalCdf(z);

  return { moments, nTrials, trialsSrStd, sr0, sigmaSr, dsrProbability, rawDsr };
}

// ────────────────────────────────────────────────────────────────────────────
// CSCV (Combinatorial Symmetric Cross-Validation)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build M (matrix of arm × time blocks of returns), then compute PBO.
 *
 * - `armReturns`: each row = one parameterVersion's per-trade returns,
 *   already aligned to a common time index (we approximate by truncating
 *   to the shortest arm; for paper data this is acceptable because trades
 *   are independent draws — the time alignment is positional, not temporal).
 * - `blocks` (S) must be even; default 16. C(S, S/2) partitions are evaluated.
 *
 * PBO = Pr(best in-sample arm ranks ≤ median OOS).
 */
export function computeCSCV(
  armReturns: number[][],
  options: CSCVOptions = {}
): CSCVResult {
  const blocks = options.blocks ?? 16;
  if (blocks % 2 !== 0) throw new Error('CSCV blocks must be even');
  const A = armReturns.length;
  if (A < 2) {
    return { blocks, partitions: 0, pbo: 0, oosBeatsMedian: 0, meanOosRankFraction: 1 };
  }

  // Truncate to shortest arm length and require enough samples per block.
  const T = Math.min(...armReturns.map((r) => r.length));
  if (T < blocks * 2) {
    return { blocks, partitions: 0, pbo: 0, oosBeatsMedian: 0, meanOosRankFraction: 1 };
  }
  const blockSize = Math.floor(T / blocks);

  // M[arm][block] = mean return of the arm in that block.
  const M: number[][] = armReturns.map((r) => {
    const blockMeans: number[] = [];
    for (let b = 0; b < blocks; b++) {
      let sum = 0;
      for (let i = 0; i < blockSize; i++) sum += r[b * blockSize + i];
      blockMeans.push(sum / blockSize);
    }
    return blockMeans;
  });

  // Enumerate C(S, S/2) train index sets (S=16 → 12,870 partitions; tractable).
  const allIdx = Array.from({ length: blocks }, (_, i) => i);
  const trainSets = combinations(allIdx, blocks / 2);

  let oosBeatsMedian = 0;
  const oosRankFractions: number[] = [];
  let evaluated = 0;
  for (const train of trainSets) {
    const trainSet = new Set(train);
    const test = allIdx.filter((i) => !trainSet.has(i));

    // Mean over train blocks per arm
    const trainMean: number[] = M.map((blocks) => {
      let s = 0;
      for (const i of train) s += blocks[i];
      return s / train.length;
    });
    // Mean over test blocks per arm
    const testMean: number[] = M.map((blocks) => {
      let s = 0;
      for (const i of test) s += blocks[i];
      return s / test.length;
    });

    // In-sample best arm
    let bestIdx = 0;
    for (let a = 1; a < A; a++) if (trainMean[a] > trainMean[bestIdx]) bestIdx = a;
    // OOS rank of bestIdx (fraction of arms it beats)
    const target = testMean[bestIdx];
    const rank = testMean.filter((v) => v < target).length;
    const fraction = rank / (A - 1);
    oosRankFractions.push(fraction);
    const oosMedian = median(testMean);
    if (target > oosMedian) oosBeatsMedian++;
    evaluated++;
  }

  const pbo = evaluated > 0 ? 1 - oosBeatsMedian / evaluated : 0;
  const meanOosRankFraction =
    oosRankFractions.length > 0
      ? oosRankFractions.reduce((a, b) => a + b, 0) / oosRankFractions.length
      : 0;
  return { blocks, partitions: evaluated, pbo, oosBeatsMedian, meanOosRankFraction };
}

function combinations<T>(arr: T[], k: number): T[][] {
  const out: T[][] = [];
  const n = arr.length;
  if (k > n) return out;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    out.push(idx.map((i) => arr[i]));
    let i = k - 1;
    while (i >= 0 && idx[i] === i + n - k) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return out;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ────────────────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────────────────

interface CliArgs {
  inputFile: string;
  byArm: boolean;
  windowDays: number;
  compare?: [string, string];
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    inputFile: path.resolve(process.cwd(), 'data/realtime/kol-paper-trades.jsonl'),
    byArm: false,
    windowDays: 30,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--in') {
      args.inputFile = argv[++i];
    } else if (token === '--by-arm') {
      args.byArm = true;
    } else if (token.startsWith('--window-days=')) {
      args.windowDays = Math.max(1, Number(token.split('=')[1]));
    } else if (token === '--window-days') {
      args.windowDays = Math.max(1, Number(argv[++i]));
    } else if (token === '--compare') {
      const a = argv[++i];
      const b = argv[++i];
      if (!a || !b) throw new Error('--compare requires two parameterVersion ids');
      args.compare = [a, b];
    }
  }
  return args;
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
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function returnsOf(rows: PaperTradeRecord[]): number[] {
  // Use netPct if present (already cost-deducted in paper engine); fall back to netSol/0.01
  // (per-trade SOL ticket is 0.01 → percentage equivalent of SOL pnl). We reject NaN.
  const out: number[] = [];
  for (const r of rows) {
    const v = typeof r.netPct === 'number' ? r.netPct : (typeof r.netSol === 'number' ? r.netSol / 0.01 : NaN);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

function buildArmGroups(
  rows: PaperTradeRecord[]
): Map<string, PaperTradeRecord[]> {
  const m = new Map<string, PaperTradeRecord[]>();
  for (const r of rows) {
    const key = r.parameterVersion ?? r.armName ?? 'unknown';
    const arr = m.get(key) ?? [];
    arr.push(r);
    m.set(key, arr);
  }
  return m;
}

function fmt(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return 'n/a';
  return n.toFixed(digits);
}

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
  return `${(n * 100).toFixed(2)}%`;
}

function describeDsr(d: DeflatedSharpeResult): string {
  const verdict = d.dsrProbability >= 0.95 ? 'PASS' : 'FAIL';
  return [
    `T=${d.moments.count}`,
    `SR=${fmt(d.moments.sharpeRatio)}`,
    `γ3=${fmt(d.moments.skewness)}`,
    `γ4=${fmt(d.moments.kurtosis)}`,
    `σ(SR)=${fmt(d.sigmaSr)}`,
    `N=${d.nTrials}`,
    `SR0=${fmt(d.sr0)}`,
    `rawDSR=${fmt(d.rawDsr)}`,
    `Prob>0=${fmtPct(d.dsrProbability)}`,
    verdict,
  ].join(' / ');
}

function renderReport(args: CliArgs, all: PaperTradeRecord[], reports: ArmReport[]): string {
  const lines: string[] = [];
  lines.push(`# DSR + CSCV Validator — ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(`Input: \`${path.relative(process.cwd(), args.inputFile)}\``);
  lines.push(`Window: last ${args.windowDays} days`);
  lines.push(`Active rows after filter: ${all.length}`);
  lines.push('');
  lines.push('Pass criterion: DSR Prob > 0 ≥ 95%, PBO < 0.5.');
  lines.push('');

  if (reports.length === 0) {
    lines.push('> No data after filter.');
    return lines.join('\n');
  }

  lines.push('## Arm summary');
  lines.push('');
  lines.push('| Arm | Trades | Net SOL | Win Rate | DSR Prob | Verdict |');
  lines.push('|-----|--------|---------|----------|----------|---------|');
  for (const r of reports) {
    const dsrProb = r.dsr ? fmtPct(r.dsr.dsrProbability) : 'n/a';
    const verdict = r.dsr ? (r.dsr.dsrProbability >= 0.95 ? 'PASS' : 'FAIL') : 'INSUFFICIENT';
    lines.push(`| ${r.armKey} | ${r.trades} | ${r.netSol.toFixed(6)} | ${fmtPct(r.winRate)} | ${dsrProb} | ${verdict} |`);
  }
  lines.push('');
  lines.push('## Detail');
  lines.push('');
  for (const r of reports) {
    lines.push(`### ${r.armKey}`);
    if (r.dsr) lines.push(`- DSR: ${describeDsr(r.dsr)}`);
    if (r.cscv) {
      const verdict = r.cscv.pbo < 0.5 ? 'PASS' : 'FAIL';
      lines.push(
        `- CSCV: blocks=${r.cscv.blocks} partitions=${r.cscv.partitions} ` +
        `PBO=${fmt(r.cscv.pbo, 3)} oosBeatMedian=${r.cscv.oosBeatsMedian} ` +
        `meanOosRankFrac=${fmt(r.cscv.meanOosRankFraction, 3)} ${verdict}`
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const loaded = await readJsonl<PaperTradeRecord>(args.inputFile);
  const cutoffMs = Date.now() - args.windowDays * 86_400_000;
  const filtered = loaded.filter((r) => {
    if (r.isShadowKol) return false;
    if (!r.closedAt) return true;
    const t = Date.parse(r.closedAt);
    return Number.isFinite(t) ? t >= cutoffMs : true;
  });

  const groups = buildArmGroups(filtered);

  if (args.compare) {
    const [a, b] = args.compare;
    const ra = returnsOf(groups.get(a) ?? []);
    const rb = returnsOf(groups.get(b) ?? []);
    const trialsSr = [
      computeSharpeMoments(ra).sharpeRatio,
      computeSharpeMoments(rb).sharpeRatio,
    ];
    const dsrA = computeDSR(ra, trialsSr, 2);
    const dsrB = computeDSR(rb, trialsSr, 2);
    const reportA: ArmReport = {
      armKey: a,
      trades: ra.length,
      netSol: (groups.get(a) ?? []).reduce((s, r) => s + (r.netSol ?? 0), 0),
      winRate: ra.length ? ra.filter((x) => x > 0).length / ra.length : 0,
      dsr: dsrA,
    };
    const reportB: ArmReport = {
      armKey: b,
      trades: rb.length,
      netSol: (groups.get(b) ?? []).reduce((s, r) => s + (r.netSol ?? 0), 0),
      winRate: rb.length ? rb.filter((x) => x > 0).length / rb.length : 0,
      dsr: dsrB,
    };
    process.stdout.write(renderReport(args, filtered, [reportA, reportB]) + '\n');
    return;
  }

  // Per-arm analyses (always need this to get cross-sectional SR distribution).
  const armEntries = [...groups.entries()].map(([key, rs]) => ({
    key,
    rs,
    returns: returnsOf(rs),
  }));
  // Filter empty arms but keep the trial count from the unfiltered set
  // (if a parameterVersion appeared but had no usable returns, it still counts
  // as a tested hypothesis from the multiple-testing perspective).
  const trialsSr = armEntries
    .map((e) => computeSharpeMoments(e.returns).sharpeRatio)
    .filter((v) => Number.isFinite(v));
  const nTrials = Math.max(1, armEntries.length);

  const reports: ArmReport[] = [];

  if (args.byArm) {
    for (const e of armEntries) {
      if (e.returns.length < 5) {
        reports.push({
          armKey: e.key,
          trades: e.returns.length,
          netSol: e.rs.reduce((s, r) => s + (r.netSol ?? 0), 0),
          winRate: e.returns.length ? e.returns.filter((x) => x > 0).length / e.returns.length : 0,
        });
        continue;
      }
      const dsr = computeDSR(e.returns, trialsSr, nTrials);
      reports.push({
        armKey: e.key,
        trades: e.returns.length,
        netSol: e.rs.reduce((s, r) => s + (r.netSol ?? 0), 0),
        winRate: e.returns.filter((x) => x > 0).length / e.returns.length,
        dsr,
      });
    }
    // CSCV across all arms (need at least 2 arms with sufficient samples)
    const eligible = armEntries.filter((e) => e.returns.length >= 32);
    if (eligible.length >= 2) {
      const cscv = computeCSCV(eligible.map((e) => e.returns));
      reports.unshift({
        armKey: '__overall_cscv__',
        trades: eligible.reduce((s, e) => s + e.returns.length, 0),
        netSol: 0,
        winRate: 0,
        cscv,
      });
    }
  } else {
    // Single pooled report
    const allReturns = armEntries.flatMap((e) => e.returns);
    if (allReturns.length >= 5) {
      const dsr = computeDSR(allReturns, trialsSr, nTrials);
      reports.push({
        armKey: '__pooled__',
        trades: allReturns.length,
        netSol: filtered.reduce((s, r) => s + (r.netSol ?? 0), 0),
        winRate: allReturns.filter((x) => x > 0).length / allReturns.length,
        dsr,
      });
    } else {
      reports.push({
        armKey: '__pooled__',
        trades: allReturns.length,
        netSol: filtered.reduce((s, r) => s + (r.netSol ?? 0), 0),
        winRate: allReturns.length ? allReturns.filter((x) => x > 0).length / allReturns.length : 0,
      });
    }
  }

  process.stdout.write(renderReport(args, filtered, reports) + '\n');
}

// Only run main when invoked directly (not when imported by tests).
if (require.main === module) {
  void main().catch((err) => {
    console.error(`[dsr-validator] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
