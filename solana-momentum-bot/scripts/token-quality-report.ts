#!/usr/bin/env ts-node
/**
 * Token Quality Report (2026-05-01, Decu Quality Layer Phase B.7).
 *
 * ADR §6.3 정합. Token quality observation × paper trades × live trades × missed-alpha
 * 4 jsonl join 후 flag × cohort 매트릭스 산출.
 *
 * 입력:
 *   - data/realtime/token-quality-observations.jsonl  (Phase B.6 wiring)
 *   - data/realtime/kol-paper-trades.jsonl            (paper outcome)
 *   - data/realtime/kol-live-trades.jsonl             (live outcome, Sprint 1.B3)
 *   - data/realtime/missed-alpha.jsonl                (post-close trajectory)
 *
 * 산출 (markdown):
 *   - flag × { n / netSol / bigLossRate / 5xRate / winnerKillRate }
 *   - cohort: paper / live / shadow 분리
 *   - top winner-kill examples per flag
 *
 * 사용:
 *   npx ts-node scripts/token-quality-report.ts --window-days=7
 *   npx ts-node scripts/token-quality-report.ts --output=reports/token-quality-2026-05-01.md
 *
 * read-only — 거래 / 사이징 / 라이브 throttle 에 영향 없음.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import {
  DEFAULT_DEV_WALLET_CANDIDATE_PATH,
  getDevWalletCandidateFlags,
  getDevWalletCandidateStats,
  loadDevWalletCandidateIndex,
  lookupDevWalletCandidate,
  type DevWalletCandidateIndex,
} from '../src/observability/devWalletCandidateRegistry';

interface TokenQualityRow {
  schemaVersion?: string;
  tokenMint: string;
  observedAt: string;
  creatorAddress?: string;
  devWallet?: string;
  firstLpProvider?: string;
  riskFlags?: string[];
  operatorDevStatus?: string;
  observationContext?: {
    armName?: string;
    isLive?: boolean;
    isShadowArm?: boolean;
    positionId?: string;
  };
}

interface TradeRow {
  positionId?: string;
  tokenMint?: string;
  netSol?: number;
  netPct?: number;
  mfePctPeak?: number;
  closedAt?: string;
  isShadowArm?: boolean;
  isLive?: boolean;
  armName?: string;
}

interface ReportArgs {
  windowDays: number;
  inputDir: string;
  outputPath?: string;
  candidateFile?: string;
  threshold5xMfe: number;     // 4.0 = 400%
  bigLossThresholdPct: number; // -0.10 = -10% net
}

function parseArgs(argv: string[]): ReportArgs {
  let windowDays = 7;
  let outputPath: string | undefined;
  let inputDir = path.resolve(process.cwd(), 'data/realtime');
  let candidateFile: string | undefined = DEFAULT_DEV_WALLET_CANDIDATE_PATH;
  let threshold5xMfe = 4.0;
  let bigLossThresholdPct = -0.10;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--window-days=')) windowDays = Number(t.split('=')[1]);
    else if (t.startsWith('--output=')) outputPath = t.split('=')[1];
    else if (t.startsWith('--input-dir=')) inputDir = t.split('=')[1];
    else if (t.startsWith('--candidate-file=')) candidateFile = t.split('=')[1];
    else if (t === '--candidate-file' && argv[i + 1]) candidateFile = argv[++i];
    else if (t === '--no-candidates') candidateFile = undefined;
    else if (t.startsWith('--threshold-5x=')) threshold5xMfe = Number(t.split('=')[1]);
    else if (t.startsWith('--big-loss=')) bigLossThresholdPct = Number(t.split('=')[1]);
  }
  if (!Number.isFinite(windowDays) || windowDays <= 0) windowDays = 7;
  return { windowDays, outputPath, inputDir, candidateFile, threshold5xMfe, bigLossThresholdPct };
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  try {
    const text = await readFile(filePath, 'utf8');
    const out: T[] = [];
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      try {
        out.push(JSON.parse(raw) as T);
      } catch {
        // skip malformed
      }
    }
    return out;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

// 2026-05-01 (codex F2 fix): missed-alpha winnerKill join + paper/live/shadow cohort group-by.
//   이전 "4-jsonl join + winnerKillRate" 주석은 실제 구현과 불일치 — fix.

interface MissedAlphaRow {
  eventId?: string;
  tokenMint?: string;
  rejectCategory?: string;
  rejectReason?: string;
  rejectedAt?: string;
  extras?: {
    positionId?: string;
    elapsedSecAtClose?: number;
    exitPrice?: number;
    isLive?: boolean;
  };
  probe?: {
    offsetSec: number;
    deltaPct: number | null;
  };
  signalPrice?: number;
}

type Cohort = 'paper' | 'live' | 'shadow';

interface FlagCohortStats {
  flag: string;
  cohort: Cohort | 'overall';
  n: number;
  netSol: number;
  bigLosses: number;
  winners5x: number;
  winnerKills: number;  // missed-alpha postMfe ≥ threshold (5x 도달 후 cut)
}

function resolveCohort(ctx?: { isLive?: boolean; isShadowArm?: boolean }): Cohort {
  if (ctx?.isShadowArm) return 'shadow';
  if (ctx?.isLive) return 'live';
  return 'paper';
}

/**
 * winner-kill 산출 — missed-alpha row 의 closeSite (extras.elapsedSecAtClose 존재) 만 활용.
 * positionId 별 max postMfe 추출 → threshold (default 4.0 = 5x) 초과 시 winner-kill.
 */
function buildPositionWinnerKillMap(
  missedAlpha: MissedAlphaRow[],
  threshold5xMfe: number,
): Set<string> {
  const winnerKillPos = new Set<string>();
  // positionId → max postMfe (relative to exitPrice)
  const maxPostMfeByPos = new Map<string, number>();
  for (const row of missedAlpha) {
    const ctx = row.extras;
    if (!ctx || typeof ctx.elapsedSecAtClose !== 'number') continue;  // close-site only
    if (!ctx.positionId) continue;
    const exitPrice = typeof ctx.exitPrice === 'number' ? ctx.exitPrice : 0;
    const signalPrice = row.signalPrice ?? 0;
    const delta = row.probe?.deltaPct;
    if (delta == null || exitPrice <= 0 || signalPrice <= 0) continue;
    const observedPrice = signalPrice * (1 + delta);
    const postMfe = (observedPrice - exitPrice) / exitPrice;
    const prev = maxPostMfeByPos.get(ctx.positionId) ?? -Infinity;
    if (postMfe > prev) maxPostMfeByPos.set(ctx.positionId, postMfe);
  }
  for (const [posId, maxMfe] of maxPostMfeByPos) {
    if (maxMfe >= threshold5xMfe) winnerKillPos.add(posId);
  }
  return winnerKillPos;
}

export function buildFlagMatrix(
  observations: TokenQualityRow[],
  trades: TradeRow[],
  missedAlpha: MissedAlphaRow[],
  args: ReportArgs,
  candidateIndex?: DevWalletCandidateIndex,
): FlagCohortStats[] {
  // observation 의 positionId / tokenMint 로 trade row join
  const tradeByPos = new Map<string, TradeRow>();
  const tradesByMint = new Map<string, TradeRow[]>();
  for (const t of trades) {
    if (t.positionId) tradeByPos.set(t.positionId, t);
    if (t.tokenMint) {
      const arr = tradesByMint.get(t.tokenMint) ?? [];
      arr.push(t);
      tradesByMint.set(t.tokenMint, arr);
    }
  }

  // codex F2: missed-alpha winnerKill set
  const winnerKillPos = buildPositionWinnerKillMap(missedAlpha, args.threshold5xMfe);

  // 2026-05-01 (codex F2): flag × cohort 2-tuple key 로 group-by.
  const byKey = new Map<string, FlagCohortStats>();
  function ensure(flag: string, cohort: Cohort | 'overall'): FlagCohortStats {
    const key = `${flag}|${cohort}`;
    let stat = byKey.get(key);
    if (!stat) {
      stat = { flag, cohort, n: 0, netSol: 0, bigLosses: 0, winners5x: 0, winnerKills: 0 };
      byKey.set(key, stat);
    }
    return stat;
  }

  for (const obs of observations) {
    const flags = [...(obs.riskFlags ?? [])];
    if (obs.operatorDevStatus && obs.operatorDevStatus !== 'unknown') {
      flags.push(`DEV_${obs.operatorDevStatus.toUpperCase()}`);
    }
    if (candidateIndex) {
      const matchedCandidate =
        lookupDevWalletCandidate(obs.devWallet, candidateIndex) ??
        lookupDevWalletCandidate(obs.creatorAddress, candidateIndex) ??
        lookupDevWalletCandidate(obs.firstLpProvider, candidateIndex);
      if (matchedCandidate) flags.push(...getDevWalletCandidateFlags(matchedCandidate));
    }
    if (flags.length === 0) flags.push('NO_FLAGS');

    const ctx = obs.observationContext;
    const cohort = resolveCohort(ctx);

    // matched trade — positionId 우선, 없으면 tokenMint 의 첫 trade
    let matched: TradeRow | undefined;
    if (ctx?.positionId) matched = tradeByPos.get(ctx.positionId);
    if (!matched) {
      const candidates = tradesByMint.get(obs.tokenMint);
      if (candidates && candidates.length > 0) matched = candidates[0];
    }

    const isWinnerKill = ctx?.positionId ? winnerKillPos.has(ctx.positionId) : false;

    for (const flag of flags) {
      // 각 cohort + overall 양쪽 누적
      for (const target of [cohort, 'overall' as const]) {
        const stat = ensure(flag, target);
        stat.n += 1;
        if (matched) {
          stat.netSol += matched.netSol ?? 0;
          if ((matched.netPct ?? 0) <= args.bigLossThresholdPct) stat.bigLosses += 1;
          if ((matched.mfePctPeak ?? 0) >= args.threshold5xMfe) stat.winners5x += 1;
        }
        if (isWinnerKill) stat.winnerKills += 1;
      }
    }
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.flag !== b.flag) return a.flag.localeCompare(b.flag);
    // overall → paper → live → shadow 순
    const order: Record<string, number> = { overall: 0, paper: 1, live: 2, shadow: 3 };
    return (order[a.cohort] ?? 99) - (order[b.cohort] ?? 99);
  });
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function renderReport(
  args: ReportArgs,
  stats: FlagCohortStats[],
  totals: {
    obs: number;
    trades: number;
    missedAlpha: number;
    winnerKillEvents: number;
    candidateFile?: string;
    candidateCount: number;
    candidateAddressCount: number;
    candidateDuplicateCount: number;
  },
): string {
  const lines: string[] = [];
  lines.push(`# Token Quality Report (${new Date().toISOString()})`);
  lines.push('');
  lines.push(`- Window: last ${args.windowDays} days`);
  lines.push(`- 5x threshold (mfePeak / postMfe): +${pct(args.threshold5xMfe)}`);
  lines.push(`- big loss threshold (netPct): ${pct(args.bigLossThresholdPct)}`);
  lines.push(`- observations: ${totals.obs}`);
  lines.push(`- trades joined: ${totals.trades}`);
  lines.push(`- missed-alpha rows joined: ${totals.missedAlpha}`);
  lines.push(`- positions flagged as winner-kill: ${totals.winnerKillEvents}`);
  lines.push(`- dev-wallet candidates: ${totals.candidateCount} candidates / ${totals.candidateAddressCount} addresses`);
  if (totals.candidateFile) lines.push(`- candidate file: ${totals.candidateFile}`);
  if (totals.candidateDuplicateCount > 0) {
    lines.push(`- candidate duplicate addresses: ${totals.candidateDuplicateCount} (quality issue)`);
  }
  lines.push('');
  lines.push('## Flag × cohort 매트릭스');
  lines.push('');
  lines.push('| Flag | Cohort | n | netSol | bigLossRate | 5xRate | winnerKillRate | 권고 |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---|');
  for (const s of stats) {
    const bigLossRate = s.n > 0 ? s.bigLosses / s.n : 0;
    const fivexRate = s.n > 0 ? s.winners5x / s.n : 0;
    const winnerKillRate = s.n > 0 ? s.winnerKills / s.n : 0;
    const recommendation = recommend(s.flag, bigLossRate, fivexRate, s.n);
    lines.push(
      `| ${s.flag} | ${s.cohort} | ${s.n} | ${s.netSol.toFixed(4)} | ` +
      `${pct(bigLossRate)} | ${pct(fivexRate)} | ${pct(winnerKillRate)} | ${recommendation} |`,
    );
  }
  lines.push('');
  lines.push('Phase B (observe-only) — paper reject / live hard gate 진입 전 추가 검증 필요.');
  lines.push('Dev-wallet candidate flags are paper-only labels; they are not allowlist or entry triggers.');
  lines.push('');
  lines.push('### Cohort 정의');
  lines.push('- `paper` — isLive=false, isShadowArm=false');
  lines.push('- `live` — isLive=true');
  lines.push('- `shadow` — isShadowArm=true (paper-only A/B)');
  lines.push('- `overall` — 위 3개 합산');
  return lines.join('\n');
}

function recommend(flag: string, bigLossRate: number, fivexRate: number, n: number): string {
  if (n < 30) return 'observe (n<30)';
  if (fivexRate > 0) return 'observe — 5x winner 포함, hard reject 금지';
  if (bigLossRate > 0.5) return 'paper reject 후보';
  if (bigLossRate > 0.3) return 'observe — bigLoss 약간 높음';
  return 'observe';
}

export async function runTokenQualityReport(args: ReportArgs): Promise<string> {
  const cutoffMs = Date.now() - args.windowDays * 86_400_000;
  const obsPath = path.join(args.inputDir, 'token-quality-observations.jsonl');
  const paperPath = path.join(args.inputDir, 'kol-paper-trades.jsonl');
  const livePath = path.join(args.inputDir, 'kol-live-trades.jsonl');
  const missedAlphaPath = path.join(args.inputDir, 'missed-alpha.jsonl');
  // 2026-05-01 (codex F2): 4-jsonl join — missed-alpha 도 입력에 포함.
  const [obsRaw, paper, live, missedAlphaRaw] = await Promise.all([
    readJsonl<TokenQualityRow>(obsPath),
    readJsonl<TradeRow>(paperPath),
    readJsonl<TradeRow>(livePath),
    readJsonl<MissedAlphaRow>(missedAlphaPath),
  ]);
  const candidateIndex = args.candidateFile
    ? await loadDevWalletCandidateIndex(args.candidateFile)
    : undefined;
  const candidateStats = candidateIndex
    ? getDevWalletCandidateStats(candidateIndex)
    : { totalCandidates: 0, addressCount: 0, duplicateAddressCount: 0 };
  const obs = obsRaw.filter((o) => {
    const t = Date.parse(o.observedAt);
    return Number.isFinite(t) ? t >= cutoffMs : true;
  });
  const trades = [...paper, ...live].filter((t) => {
    if (!t.closedAt) return true;
    const ts = Date.parse(t.closedAt);
    return Number.isFinite(ts) ? ts >= cutoffMs : true;
  });
  const missedAlpha = missedAlphaRaw.filter((row) => {
    if (!row.rejectedAt) return true;
    const ts = Date.parse(row.rejectedAt);
    return Number.isFinite(ts) ? ts >= cutoffMs : true;
  });
  const winnerKillSet = buildPositionWinnerKillMap(missedAlpha, args.threshold5xMfe);
  const stats = buildFlagMatrix(obs, trades, missedAlpha, args, candidateIndex);
  return renderReport(args, stats, {
    obs: obs.length,
    trades: trades.length,
    missedAlpha: missedAlpha.length,
    winnerKillEvents: winnerKillSet.size,
    candidateFile: args.candidateFile,
    candidateCount: candidateStats.totalCandidates,
    candidateAddressCount: candidateStats.addressCount,
    candidateDuplicateCount: candidateStats.duplicateAddressCount,
  });
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  runTokenQualityReport(args).then(async (md) => {
    if (args.outputPath) {
      await mkdir(path.dirname(args.outputPath), { recursive: true });
      await writeFile(args.outputPath, md, 'utf8');
      process.stdout.write(`written: ${args.outputPath}\n`);
    } else {
      process.stdout.write(md + '\n');
    }
  }).catch((err) => {
    process.stderr.write(`[token-quality-report] error: ${err}\n`);
    process.exit(1);
  });
}
