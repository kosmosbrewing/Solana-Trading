/**
 * Canary Evaluation — cupsey vs pure_ws_breakout A/B (Block 4, 2026-04-18)
 *
 * Why: Block 3 구현 후 Phase 3.3 승격 판정을 위한 evaluation tool.
 * `executed-buys.jsonl` + `executed-sells.jsonl` fallback ledger 만 사용 (RPC/DB 의존 없음) —
 * wallet-reconcile 보다 빠르고, 배포 환경 env binding 문제 없음.
 *
 * FIFO pair matching:
 *   - 각 strategy 별 buy queue (blockTime 오름차순)
 *   - sell tx 가 `entryTxSignature` 로 buy 를 정확히 매칭 (executed-sells 스키마에 이미 있음)
 *   - 매칭 안 되는 sell 은 `orphan_sell` 로 별도 카운트
 *   - 매칭 안 되는 buy (아직 미청산) 은 `open_buy` 로 카운트
 *
 * 실행:
 *   npx ts-node scripts/canary-eval.ts [--ledger-dir data/realtime] [--since 2026-04-18T00:00:00Z] [--json] [--md report.md]
 *
 * 출력:
 *   - cupsey_flip_10s: trades, closed, wins (2x+/5x+/10x+), total SOL delta, max loser streak
 *   - pure_ws_breakout: 동일
 *   - A/B: cupsey 대비 pure_ws delta 비교
 *   - Promotion 판정: 50 trades + wallet delta > 0 + 5x+ count > 0 → candidate
 */
import { readFile, writeFile } from 'fs/promises';
import path from 'path';

interface LedgerBuy {
  positionId?: string;
  txSignature?: string;
  strategy?: string;
  pairAddress?: string;
  tokenSymbol?: string;
  plannedEntryPrice?: number;
  actualEntryPrice?: number;
  actualQuantity?: number;
  slippageBps?: number;
  signalTimeSec?: number;
  signalPrice?: number;
  recordedAt?: string;
  // 2026-04-25 Phase 1 P0-3: 데이터 품질 flag — 한쪽만 actualIn/Out 가용 시 true.
  partialFillDataMissing?: boolean;
}

interface LedgerSell {
  positionId?: string;
  dbTradeId?: string;
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
  slippageBps?: number;
  entryPrice?: number;
  holdSec?: number;
  recordedAt?: string;
  // 2026-04-22 P2-4 — optional (legacy ledger 에는 없음). pureWs handler 가 기록.
  mfePctPeak?: number;
  peakPrice?: number;
  troughPrice?: number;
  marketReferencePrice?: number;
  t1VisitAtSec?: number | null;
  t2VisitAtSec?: number | null;
  t3VisitAtSec?: number | null;
  closeState?: string;
  // 2026-04-25 Phase 1 P0-4 — close 시점 DB pnl vs wallet delta 비교 snapshot.
  dbPnlSol?: number;
  walletDeltaSol?: number;
  dbPnlDriftSol?: number;
  solSpentNominal?: number;
  // 2026-04-25 Phase 2 P1-3 — T1 promotion 이 quote-based 신호로 발동됐는지.
  t1ViaQuote?: boolean;
}

function isPartialReduceLedgerRow(row: LedgerSell): boolean {
  return row.isPartialReduce === true ||
    row.positionStillOpen === true ||
    row.eventType === 'rotation_flow_live_reduce';
}

interface PairedTrade {
  strategy: string;
  pairAddress?: string;
  tokenSymbol?: string;
  entryTxSignature?: string;
  exitTxSignature?: string;
  entryTimeSec?: number;
  exitTimeSec?: number;
  holdSec?: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  solSpent: number;        // nominal entry cost (entryPrice × quantity)
  solReceived: number;     // actual sell wallet delta
  netSol: number;          // solReceived - solSpent
  netPct: number;          // (exitPrice - entryPrice) / entryPrice × 100
  exitReason?: string;
  // 2026-04-26 Kelly Controller P0 — reconciled outcome 입력 시 propagate.
  kellyEligible?: boolean;
  reconcileStatus?: string;
  walletTruthSource?: string;
  // 2026-04-22 P2-4 — MFE peak + tier visit timestamps.
  // `winners5x` (netPct ≥ 400) 는 close 시 net 기준이라 "T2 visit 후 trail 반납" 을 구분 못 한다.
  // 아래 필드로 visit 기반 집계 추가 (`winners5xByVisit = t2VisitAtSec != null`).
  mfePctPeak?: number;
  t1VisitAtSec?: number | null;
  t2VisitAtSec?: number | null;
  t3VisitAtSec?: number | null;
  // 2026-04-25 Phase 1 P0-3: buy ledger 의 partial fill flag 그대로 전파.
  partialFillDataMissing?: boolean;
}

interface StrategyReport {
  strategy: string;
  closedTrades: number;
  openBuys: number;
  orphanSells: number;
  totalNetSol: number;
  medianNetPct: number;
  meanNetPct: number;
  winners2x: number;
  winners5x: number;
  winners10x: number;
  // 2026-04-22 P2-4: MFE visit 기반 집계. net 기준 winners 와 별도 — T2/T3 방문했으나 trail 로
  // 반납한 case 를 구분해서 "기술적으로 5x+ 는 맞췄지만 반납" 을 측정 가능.
  winners5xByVisit: number;
  winners10xByVisit: number;
  losers: number;
  maxConsecutiveLosers: number;
  medianHoldSec: number | null;
  topWinnersByNetSol: Array<{ symbol?: string; netSol: number; netPct: number; exitReason?: string }>;
  topLosersByNetSol: Array<{ symbol?: string; netSol: number; netPct: number; exitReason?: string }>;
  // Block 4 QA fix — wallet truth metrics (chronological equity curve)
  walletLogGrowth: number;          // ln(cumWallet(end) / cumWallet(start)) — zero if start<=0
  maxDrawdownPct: number;           // peak-to-trough %
  maxDrawdownSol: number;           // peak-to-trough SOL
  recoveryTradeCount: number | null; // drawdown trough 이후 peak 회복까지 trade 수 (null = not recovered)
  equityCurveSol: number[];         // cumulative net SOL (chronological trade order)
  // 2026-04-25 Phase 1 P0-3: 데이터 품질 분리 집계.
  // partial fill data missing trades (actualIn/Out 한쪽 null → planned 강제) 는 entry price 가
  // 실측이 아니라 ratio 왜곡 가능성이 있다. 정상 표본과 별도로 카운트해 expectancy 해석 시 분리.
  partialFillDataMissingTrades: number;
}

interface CliArgs {
  ledgerDir: string;
  since?: Date;
  json?: string;
  md?: string;
  walletStartSol: number;
  /**
   * QA 2026-04-26: --reconciled 시 lane-outcomes-reconciled.jsonl 의 kellyEligible=true 만 사용.
   * INCIDENT.md 2026-04-26 entry 의 P0 종료 조건 (canary-eval 가 reconciled outcome 만 사용) 충족.
   * default false — 기존 raw ledger 동작 보존 (legacy run 호환).
   */
  reconciled: boolean;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const sinceRaw = get('--since');
  const startSolRaw = get('--start-sol');
  return {
    ledgerDir: get('--ledger-dir') ?? path.resolve(process.cwd(), 'data/realtime'),
    since: sinceRaw ? new Date(sinceRaw) : undefined,
    json: get('--json'),
    md: get('--md'),
    walletStartSol: startSolRaw ? Number(startSolRaw) : 1.0,
    reconciled: argv.includes('--reconciled'),
  };
}

async function readJsonlMaybe<T>(file: string): Promise<T[]> {
  try {
    const text = await readFile(file, 'utf8');
    return text
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as T;
        } catch {
          return null;
        }
      })
      .filter((x): x is T => x !== null);
  } catch {
    return [];
  }
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function maxStreak(items: PairedTrade[], predicate: (t: PairedTrade) => boolean): number {
  // chronological order (entryTimeSec asc) for streak calc
  const ordered = [...items].sort((a, b) => (a.entryTimeSec ?? 0) - (b.entryTimeSec ?? 0));
  let best = 0;
  let cur = 0;
  for (const t of ordered) {
    if (predicate(t)) {
      cur++;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}

function within(since: Date | undefined, recordedAt?: string): boolean {
  if (!since) return true;
  if (!recordedAt) return true;
  return new Date(recordedAt).getTime() >= since.getTime();
}

function pairTrades(buys: LedgerBuy[], sells: LedgerSell[], since: Date | undefined): {
  paired: PairedTrade[];
  openBuys: number;
  orphanSells: number;
  byStrategy: Map<string, { paired: PairedTrade[]; openBuys: number; orphanSells: number }>;
} {
  // strategy 별 buy map: entryTxSignature → LedgerBuy
  const buyByStrategyAndTx: Map<string, Map<string, LedgerBuy>> = new Map();
  for (const b of buys) {
    if (!within(since, b.recordedAt)) continue;
    if (!b.strategy || !b.txSignature) continue;
    let strategyMap = buyByStrategyAndTx.get(b.strategy);
    if (!strategyMap) {
      strategyMap = new Map();
      buyByStrategyAndTx.set(b.strategy, strategyMap);
    }
    strategyMap.set(b.txSignature, b);
  }

  const paired: PairedTrade[] = [];
  let orphanSells = 0;
  const consumedBuys = new Set<string>(); // `${strategy}:${txSignature}`

  for (const s of sells) {
    if (isPartialReduceLedgerRow(s)) continue;
    if (!within(since, s.recordedAt)) continue;
    if (!s.strategy || !s.entryTxSignature) {
      orphanSells++;
      continue;
    }
    const strategyMap = buyByStrategyAndTx.get(s.strategy);
    const matchedBuy = strategyMap?.get(s.entryTxSignature);
    if (!matchedBuy) {
      orphanSells++;
      continue;
    }
    consumedBuys.add(`${s.strategy}:${s.entryTxSignature}`);

    const entryPrice = matchedBuy.actualEntryPrice ?? s.entryPrice ?? 0;
    const exitPrice = s.actualExitPrice ?? 0;
    const quantity = matchedBuy.actualQuantity ?? 0;
    const solSpent = entryPrice * quantity;
    const solReceived = s.receivedSol ?? 0;
    const netSol = solReceived - solSpent;
    const netPct = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;
    const entryTimeSec = matchedBuy.signalTimeSec
      ?? (matchedBuy.recordedAt ? Math.floor(new Date(matchedBuy.recordedAt).getTime() / 1000) : undefined);
    const exitTimeSec = s.recordedAt ? Math.floor(new Date(s.recordedAt).getTime() / 1000) : undefined;

    paired.push({
      strategy: s.strategy,
      pairAddress: s.pairAddress ?? matchedBuy.pairAddress,
      tokenSymbol: s.tokenSymbol ?? matchedBuy.tokenSymbol,
      entryTxSignature: s.entryTxSignature,
      exitTxSignature: s.txSignature,
      entryTimeSec,
      exitTimeSec,
      holdSec: s.holdSec,
      entryPrice,
      exitPrice,
      quantity,
      solSpent,
      solReceived,
      netSol,
      netPct,
      exitReason: s.exitReason,
      // 2026-04-22 P2-4 — legacy sell ledger 는 필드 없음 → undefined/null fallback
      mfePctPeak: typeof s.mfePctPeak === 'number' ? s.mfePctPeak : undefined,
      t1VisitAtSec: s.t1VisitAtSec ?? null,
      t2VisitAtSec: s.t2VisitAtSec ?? null,
      t3VisitAtSec: s.t3VisitAtSec ?? null,
      // Phase 1 P0-3: buy 측 flag 를 paired record 까지 전파.
      partialFillDataMissing: matchedBuy.partialFillDataMissing === true,
    });
  }

  // openBuys = 모든 buy 중 consumed 안 된 것
  let openBuys = 0;
  const byStrategy: Map<string, { paired: PairedTrade[]; openBuys: number; orphanSells: number }> = new Map();
  for (const [strategy, strategyBuys] of buyByStrategyAndTx) {
    const stratPaired = paired.filter((p) => p.strategy === strategy);
    let stratOpenBuys = 0;
    for (const tx of strategyBuys.keys()) {
      if (!consumedBuys.has(`${strategy}:${tx}`)) stratOpenBuys++;
    }
    openBuys += stratOpenBuys;
    byStrategy.set(strategy, {
      paired: stratPaired,
      openBuys: stratOpenBuys,
      orphanSells: 0, // 아래서 채움
    });
  }

  // orphanSells strategy-별 분배는 합산 만 유지 (분배는 drift 가 크므로 생략)
  return { paired, openBuys, orphanSells, byStrategy };
}

/**
 * Build wallet-truth metrics from chronological trades.
 * Block 4 QA fix — ledger-proxy net SOL 외에 wallet log growth, drawdown, 회복 trade 수 계산.
 *
 * @param walletStartSol — canary 시작 wallet balance (simulated starting point; ledger proxy 로만 평가해도 맞지만,
 *   log growth 는 nominal 1.0 SOL 기준으로 normalizes 하는 관례. 필요 시 CLI --start-sol 로 override).
 */
function computeWalletMetrics(
  chronoTrades: PairedTrade[],
  walletStartSol: number
): {
  walletLogGrowth: number;
  maxDrawdownSol: number;
  maxDrawdownPct: number;
  recoveryTradeCount: number | null;
  equityCurveSol: number[];
} {
  const equityCurve: number[] = [];
  let cum = 0;
  let peak = 0;
  let peakIdx = 0;
  let troughAfterPeak = 0;
  let troughIdx = 0;
  let maxDd = 0;
  let maxDdSol = 0;
  let ddPeakIdx = 0;
  let ddTroughIdx = 0;
  for (let i = 0; i < chronoTrades.length; i++) {
    cum += chronoTrades[i].netSol;
    equityCurve.push(cum);
    if (cum > peak) {
      peak = cum;
      peakIdx = i;
      troughAfterPeak = cum;
      troughIdx = i;
    }
    if (cum < troughAfterPeak) {
      troughAfterPeak = cum;
      troughIdx = i;
      const dd = peak - cum;
      if (dd > maxDdSol) {
        maxDdSol = dd;
        ddPeakIdx = peakIdx;
        ddTroughIdx = troughIdx;
      }
    }
  }
  // drawdown % — peak 기준 (wallet 기준으로는 (walletStart + peak) vs (walletStart + trough))
  const peakWallet = walletStartSol + (equityCurve[ddPeakIdx] ?? 0);
  const maxDdPct = peakWallet > 0 ? (maxDdSol / peakWallet) * 100 : 0;

  // 회복 trade 수: drawdown trough 이후 peak (= equityCurve[ddPeakIdx]) 회복까지 trade 수
  let recoveryCount: number | null = null;
  if (maxDdSol > 0) {
    const targetPeak = equityCurve[ddPeakIdx] ?? 0;
    for (let i = ddTroughIdx + 1; i < equityCurve.length; i++) {
      if (equityCurve[i] >= targetPeak) {
        recoveryCount = i - ddTroughIdx;
        break;
      }
    }
  }

  const endWallet = walletStartSol + cum;
  const walletLogGrowth = walletStartSol > 0 && endWallet > 0
    ? Math.log(endWallet / walletStartSol)
    : 0;

  return {
    walletLogGrowth,
    maxDrawdownSol: maxDdSol,
    maxDrawdownPct: maxDdPct,
    recoveryTradeCount: recoveryCount,
    equityCurveSol: equityCurve,
  };
}

function buildReport(
  strategy: string,
  trades: PairedTrade[],
  openBuys: number,
  orphanSells: number,
  walletStartSol = 1.0
): StrategyReport {
  const closed = trades.length;
  const netSols = trades.map((t) => t.netSol);
  const netPcts = trades.map((t) => t.netPct);
  const holdSecs = trades.map((t) => t.holdSec).filter((x): x is number => x != null);

  const winners2x = trades.filter((t) => t.netPct >= 100).length;
  const winners5x = trades.filter((t) => t.netPct >= 400).length;
  const winners10x = trades.filter((t) => t.netPct >= 900).length;
  // 2026-04-22 P2-4: visit 기반 — "실제 T2/T3 도달했는가" 측정. net 기반과 별개.
  const winners5xByVisit = trades.filter((t) => t.t2VisitAtSec != null).length;
  const winners10xByVisit = trades.filter((t) => t.t3VisitAtSec != null).length;
  const losers = trades.filter((t) => t.netSol < 0).length;
  const maxLoserStreak = maxStreak(trades, (t) => t.netSol < 0);
  // Phase 1 P0-3: 데이터 품질 의심 trade 카운트.
  const partialFillDataMissingTrades = trades.filter((t) => t.partialFillDataMissing).length;

  const chronoTrades = [...trades].sort((a, b) => (a.entryTimeSec ?? 0) - (b.entryTimeSec ?? 0));
  const walletMetrics = computeWalletMetrics(chronoTrades, walletStartSol);

  const sortedByNet = [...trades].sort((a, b) => b.netSol - a.netSol);
  const topWinners = sortedByNet.slice(0, 3).filter((t) => t.netSol > 0).map((t) => ({
    symbol: t.tokenSymbol,
    netSol: t.netSol,
    netPct: t.netPct,
    exitReason: t.exitReason,
  }));
  const topLosers = sortedByNet.slice(-3).reverse().filter((t) => t.netSol < 0).map((t) => ({
    symbol: t.tokenSymbol,
    netSol: t.netSol,
    netPct: t.netPct,
    exitReason: t.exitReason,
  }));

  return {
    strategy,
    closedTrades: closed,
    openBuys,
    orphanSells,
    totalNetSol: netSols.reduce((a, b) => a + b, 0),
    medianNetPct: median(netPcts),
    meanNetPct: mean(netPcts),
    winners2x,
    winners5x,
    winners10x,
    winners5xByVisit,
    winners10xByVisit,
    losers,
    maxConsecutiveLosers: maxLoserStreak,
    medianHoldSec: holdSecs.length ? median(holdSecs) : null,
    topWinnersByNetSol: topWinners,
    topLosersByNetSol: topLosers,
    walletLogGrowth: walletMetrics.walletLogGrowth,
    maxDrawdownPct: walletMetrics.maxDrawdownPct,
    maxDrawdownSol: walletMetrics.maxDrawdownSol,
    recoveryTradeCount: walletMetrics.recoveryTradeCount,
    equityCurveSol: walletMetrics.equityCurveSol,
    partialFillDataMissingTrades,
  };
}

function formatPromotionVerdict(
  benchmark: StrategyReport,
  candidate: StrategyReport
): { verdict: 'PROMOTE' | 'CONTINUE' | 'DEMOTE'; reasons: string[] } {
  const reasons: string[] = [];
  const candidateHas50 = candidate.closedTrades >= 50;
  const candidateDeltaPositive = candidate.totalNetSol > 0;
  const candidateBeatsBenchmark = candidate.totalNetSol > benchmark.totalNetSol;
  const candidateHasBigWinner = candidate.winners5x > 0;
  const candidateNotExploding = candidate.maxConsecutiveLosers < 10;

  if (!candidateHas50) {
    reasons.push(`candidate closed=${candidate.closedTrades} < 50 — continue canary`);
    return { verdict: 'CONTINUE', reasons };
  }
  if (!candidateDeltaPositive) {
    reasons.push(`candidate totalNetSol=${candidate.totalNetSol.toFixed(4)} <= 0 — demote`);
    return { verdict: 'DEMOTE', reasons };
  }
  if (!candidateNotExploding) {
    reasons.push(`candidate maxConsecutiveLosers=${candidate.maxConsecutiveLosers} >= 10 — demote`);
    return { verdict: 'DEMOTE', reasons };
  }
  if (candidateBeatsBenchmark) {
    reasons.push(`candidate beats benchmark: ${candidate.totalNetSol.toFixed(4)} > ${benchmark.totalNetSol.toFixed(4)}`);
  } else {
    reasons.push(`candidate below benchmark (${candidate.totalNetSol.toFixed(4)} vs ${benchmark.totalNetSol.toFixed(4)}) but positive`);
  }
  if (candidateHasBigWinner) {
    reasons.push(`candidate has ${candidate.winners5x} × 5x winner — convexity evidence`);
  } else {
    reasons.push('candidate has zero 5x winner — convexity unproven');
  }
  const verdict = candidateBeatsBenchmark && candidateHasBigWinner ? 'PROMOTE' : 'CONTINUE';
  return { verdict, reasons };
}

function toMarkdown(benchmark: StrategyReport, candidate: StrategyReport, args: CliArgs, verdict: ReturnType<typeof formatPromotionVerdict>): string {
  const formatReport = (r: StrategyReport): string => [
    `### ${r.strategy}`,
    '',
    `| 항목 | 값 |`,
    `|---|---:|`,
    `| closed trades | ${r.closedTrades} |`,
    `| open buys (미청산) | ${r.openBuys} |`,
    `| orphan sells | ${r.orphanSells} |`,
    `| total net SOL | ${r.totalNetSol.toFixed(6)} |`,
    `| wallet log growth | ${r.walletLogGrowth.toFixed(4)} |`,
    `| max drawdown % | ${r.maxDrawdownPct.toFixed(2)}% |`,
    `| max drawdown SOL | ${r.maxDrawdownSol.toFixed(6)} |`,
    `| recovery trades | ${r.recoveryTradeCount ?? 'not recovered'} |`,
    `| median net % | ${r.medianNetPct.toFixed(2)}% |`,
    `| mean net % | ${r.meanNetPct.toFixed(2)}% |`,
    `| winners 2x+ | ${r.winners2x} |`,
    `| winners 5x+ (net) | ${r.winners5x} |`,
    `| winners 10x+ (net) | ${r.winners10x} |`,
    `| winners 5x+ (visit) | ${r.winners5xByVisit} |`,
    `| winners 10x+ (visit) | ${r.winners10xByVisit} |`,
    `| losers | ${r.losers} |`,
    `| max consecutive losers | ${r.maxConsecutiveLosers} |`,
    `| median hold sec | ${r.medianHoldSec ?? 'N/A'} |`,
    '',
    r.topWinnersByNetSol.length
      ? '**Top winners**:\n' + r.topWinnersByNetSol.map((w) => `- ${w.symbol ?? '?'} — +${w.netSol.toFixed(6)} SOL (+${w.netPct.toFixed(1)}%) ${w.exitReason ?? ''}`).join('\n') + '\n'
      : '_no winners_\n',
    r.topLosersByNetSol.length
      ? '**Top losers**:\n' + r.topLosersByNetSol.map((l) => `- ${l.symbol ?? '?'} — ${l.netSol.toFixed(6)} SOL (${l.netPct.toFixed(1)}%) ${l.exitReason ?? ''}`).join('\n') + '\n'
      : '_no losers_\n',
  ].join('\n');

  const header = [
    '# Canary Evaluation Report',
    '',
    `- generated: ${new Date().toISOString()}`,
    `- ledger dir: \`${args.ledgerDir}\``,
    `- since: ${args.since ? args.since.toISOString() : 'all time'}`,
    '',
    '## Benchmark vs Candidate',
    '',
  ].join('\n');

  const verdictBlock = [
    '## Promotion Verdict',
    '',
    `**${verdict.verdict}**`,
    '',
    verdict.reasons.map((r) => `- ${r}`).join('\n'),
    '',
    '### Reference',
    '- PROMOTE: candidate ≥ 50 trades, wallet delta positive, beats benchmark, has 5x+ winner, loser streak < 10',
    '- CONTINUE: candidate < 50 trades OR partial criteria (e.g. positive but no 5x winner)',
    '- DEMOTE: candidate ≤ 0 wallet delta OR loser streak ≥ 10',
  ].join('\n');

  return [header, formatReport(benchmark), formatReport(candidate), verdictBlock].join('\n\n');
}

async function main(): Promise<void> {
  const args = parseArgs();

  const buys = await readJsonlMaybe<LedgerBuy>(path.join(args.ledgerDir, 'executed-buys.jsonl'));
  const sellsAll = await readJsonlMaybe<LedgerSell>(path.join(args.ledgerDir, 'executed-sells.jsonl'));

  console.log(`[canary-eval] loaded ${buys.length} buys + ${sellsAll.length} sells from ${args.ledgerDir}`);
  if (args.since) console.log(`[canary-eval] filter since ${args.since.toISOString()}`);

  // QA 2026-04-26: --reconciled 모드 — lane-outcomes-reconciled.jsonl 의 kellyEligible=true 만 사용.
  // INCIDENT.md 2026-04-26 P0 종료 조건 충족.
  let sells = sellsAll;
  if (args.reconciled) {
    const reconciledPath = path.join(args.ledgerDir, 'lane-outcomes-reconciled.jsonl');
    const reconciled = await readJsonlMaybe<{ exitTxSignature?: string; kellyEligible: boolean }>(reconciledPath);
    if (reconciled.length === 0) {
      console.error(`[canary-eval] --reconciled 옵션 사용했으나 ${reconciledPath} 가 없음. \`npm run lane:reconcile -- --overwrite\` 먼저 실행.`);
      process.exit(2);
    }
    const eligibleExitTx = new Set<string>();
    for (const r of reconciled) {
      if (r.kellyEligible && r.exitTxSignature) eligibleExitTx.add(r.exitTxSignature);
    }
    const before = sellsAll.length;
    sells = sellsAll.filter((s) => s.txSignature && eligibleExitTx.has(s.txSignature));
    console.log(`[canary-eval] --reconciled: ${before} → ${sells.length} sells (kelly-eligible only)`);
  }

  const { byStrategy, orphanSells: totalOrphanSells } = pairTrades(buys, sells, args.since);

  // 배분 (현재는 total orphan 만 표시) — 분배는 drift 가 크므로 strategy 별 orphan 추정 X
  for (const [, entry] of byStrategy) entry.orphanSells = 0;

  const cupseyEntry = byStrategy.get('cupsey_flip_10s') ?? { paired: [], openBuys: 0, orphanSells: 0 };
  const candidateEntry = byStrategy.get('pure_ws_breakout') ?? { paired: [], openBuys: 0, orphanSells: 0 };

  const benchmark = buildReport('cupsey_flip_10s', cupseyEntry.paired, cupseyEntry.openBuys, cupseyEntry.orphanSells, args.walletStartSol);
  const candidate = buildReport('pure_ws_breakout', candidateEntry.paired, candidateEntry.openBuys, candidateEntry.orphanSells, args.walletStartSol);
  const verdict = formatPromotionVerdict(benchmark, candidate);

  console.log('');
  console.log(
    `[cupsey_flip_10s] closed=${benchmark.closedTrades} net=${benchmark.totalNetSol.toFixed(4)} SOL ` +
    `logGrowth=${benchmark.walletLogGrowth.toFixed(4)} maxDD=${benchmark.maxDrawdownPct.toFixed(2)}% ` +
    `recoveryTrades=${benchmark.recoveryTradeCount ?? 'N/A'} 5x+=${benchmark.winners5x} 10x+=${benchmark.winners10x}`
  );
  console.log(
    `[pure_ws_breakout] closed=${candidate.closedTrades} net=${candidate.totalNetSol.toFixed(4)} SOL ` +
    `logGrowth=${candidate.walletLogGrowth.toFixed(4)} maxDD=${candidate.maxDrawdownPct.toFixed(2)}% ` +
    `recoveryTrades=${candidate.recoveryTradeCount ?? 'N/A'} 5x+=${candidate.winners5x} 10x+=${candidate.winners10x}`
  );
  console.log('');
  console.log(`Promotion verdict: ${verdict.verdict}`);
  for (const r of verdict.reasons) console.log(`  - ${r}`);
  console.log('');
  console.log(`orphan sells: ${totalOrphanSells}`);

  if (args.json) {
    await writeFile(args.json, JSON.stringify({ benchmark, candidate, verdict, generatedAt: new Date().toISOString() }, null, 2));
    console.log(`wrote JSON → ${args.json}`);
  }
  if (args.md) {
    await writeFile(args.md, toMarkdown(benchmark, candidate, args, verdict));
    console.log(`wrote Markdown → ${args.md}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// export for tests
export {
  readJsonlMaybe,
  pairTrades,
  buildReport,
  formatPromotionVerdict,
  type LedgerBuy,
  type LedgerSell,
  type PairedTrade,
  type StrategyReport,
};
