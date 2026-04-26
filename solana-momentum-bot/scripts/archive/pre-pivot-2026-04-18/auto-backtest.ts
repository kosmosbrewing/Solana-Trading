/**
 * Auto-Backtest — 운영 파이프라인 재현, 파라미터 프로필 비교 지원
 *
 * 실행:
 *   ./scripts/auto-backtest.sh             스캔 + 백테스트 (balanced)
 *   ./scripts/auto-backtest.sh sweep       스캔 + 3개 프로필 비교
 *   ./scripts/auto-backtest.sh <ADDR>      특정 풀 테스트
 *   ./scripts/auto-backtest.sh drill <ADDR> 캐시된 CSV 드릴다운
 */
import * as fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { GeckoTerminalClient, GeckoPool } from '../src/ingester/geckoTerminalClient';
import {
  BacktestEngine,
  BacktestReporter,
  BacktestResult,
  CsvLoader,
  BacktestConfig,
} from '../src/backtest';
import { Notifier } from '../src/notifier/notifier';
import {
  assessMeasuredEdgeStage,
  BacktestStageAssessment,
} from '../src/reporting/measurement';
import { Candle, CandleInterval } from '../src/utils/types';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

// ─── 파라미터 프로필 (운영 config.ts 기준) ───

interface Profile {
  name: string;
  tag: string;  // 짧은 약어
  config: Partial<BacktestConfig>;
}

const PROFILES: Record<string, Profile> = {
  conservative: {
    name: 'Conservative',
    tag: 'CON',
    config: {
      maxRiskPerTrade: 0.005,    // 0.5%
      maxDailyLoss: 0.03,       // 3%
      maxDrawdownPct: 0.20,     // 20%
      minBreakoutScore: 65,     // A등급만
      minBuyRatio: 0,
    },
  },
  balanced: {
    name: 'Balanced (PROD)',
    tag: 'BAL',
    config: {
      maxRiskPerTrade: 0.01,    // 1%  ← 운영 동일
      maxDailyLoss: 0.05,       // 5%
      maxDrawdownPct: 0.30,     // 30%
      minBreakoutScore: 50,     // B등급 이상
      minBuyRatio: 0,
    },
  },
  aggressive: {
    name: 'Aggressive',
    tag: 'AGG',
    config: {
      maxRiskPerTrade: 0.02,    // 2%
      maxDailyLoss: 0.08,       // 8%
      maxDrawdownPct: 0.40,     // 40%
      minBreakoutScore: 40,     // 낮은 문턱
      minBuyRatio: 0,
    },
  },
};

// ─── 운영 동일 기본값 ───

const PROD_DEFAULTS: Partial<BacktestConfig> = {
  recoveryPct: 0.85,
  maxConsecutiveLosses: 3,
  cooldownMinutes: 30,
  minPoolLiquidity: 50_000,
  minTokenAgeHours: 24,
  maxHolderConcentration: 0.80,
  volumeSpikeParams: {},
  fibPullbackParams: {},
};

const DEFAULT_INTERVAL: CandleInterval = '5m';
const DEFAULT_INTERVAL_SEC = 300;
const DEFAULT_DAYS = 7;
const MAX_CANDLES_PER_CALL = 1000;
const CHUNK_SPAN_SEC = (MAX_CANDLES_PER_CALL - 1) * DEFAULT_INTERVAL_SEC;

// ─── Types ───

interface PoolMeta {
  address: string;
  symbol: string;
  name: string;
  tvlUsd: number;
  volume24hUsd: number;
  ageHours: number;
}

interface PoolBacktestResult {
  pool: PoolMeta;
  combined: BacktestResult;
  assessment: BacktestStageAssessment;
}

interface ProfileResult {
  profile: Profile;
  results: PoolBacktestResult[];
  aggregate: {
    totalTrades: number;
    avgPF: number;
    avgWR: number;
    avgExpectancyR: number;
    totalPnlPct: number;
    maxDD: number;
    positivePoolRatio: number;
    edgeScore: number;
    stageScore: number;
    stageDecision: string;
    edgeGateStatus: string;
    edgeGateReasons: string[];
  };
}

// ─── Main ───

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { printHelp(); process.exit(0); }

  const sweep = args.includes('--sweep');
  const profileName = getArg(args, '--profile') || 'balanced';
  const top = numArg(args, '--top', 10);
  const manualPool = getArg(args, '--pool');
  const poolFile = getArg(args, '--pool-file');
  const csvDir = getArg(args, '--csv-dir') || path.resolve(__dirname, '../data');
  const resultsDir = getArg(args, '--results-dir') || path.resolve(__dirname, '../results');
  const minTvl = numArg(args, '--min-tvl', 50_000);
  const minVol = numArg(args, '--min-vol', 10_000);
  const minAge = numArg(args, '--min-age', 24);
  const days = numArg(args, '--days', DEFAULT_DAYS);
  const balance = numArg(args, '--balance', 1);
  const noNotify = args.includes('--no-notify');

  const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID || '';
  const telegramEnabled = !!(botToken && chatId) && !noNotify;

  if (!fs.existsSync(csvDir)) fs.mkdirSync(csvDir, { recursive: true });

  // ─── 1. OHLCV 수집 (1회, 캐싱) ───

  const mode = sweep ? 'SWEEP' : profileName.toUpperCase();
  banner(`AUTO-BACKTEST [${mode}] | ${new Date().toISOString().slice(0, 16)} | ${balance} SOL`);

  const poolDataList = await collectOHLCV(
    manualPool, poolFile, csvDir, minTvl, minVol, minAge, days
  );

  if (poolDataList.length === 0) {
    log('DONE', 'No pools with sufficient data.');
    process.exit(0);
  }

  // ─── 2. 프로필별 백테스트 실행 ───

  const profilesToRun = sweep
    ? Object.values(PROFILES)
    : [PROFILES[profileName] || PROFILES.balanced];

  const profileResults: ProfileResult[] = [];

  for (const profile of profilesToRun) {
    log('RUN', `Profile: ${profile.name}`);
    const results = await runProfile(profile, poolDataList, csvDir, balance);
    const aggregate = computeAggregate(results);
    profileResults.push({ profile, results, aggregate });
  }

  // ─── 3. 결과 출력 ───

  if (sweep) {
    printSweepComparison(profileResults, poolDataList.length, balance);
    // 각 프로필 top 3 표시
    for (const pr of profileResults) {
      const sorted = [...pr.results].sort((a, b) => comparePF(b.combined.profitFactor, a.combined.profitFactor));
      printProfileRanking(pr.profile, sorted.slice(0, 3));
    }
  } else {
    const pr = profileResults[0];
    const sorted = [...pr.results].sort((a, b) => comparePF(b.combined.profitFactor, a.combined.profitFactor));
    printProfileRanking(pr.profile, sorted.slice(0, top));

    // 상위 3개 상세
    const reporter = new BacktestReporter();
    for (let i = 0; i < Math.min(3, sorted.length); i++) {
      console.log(`\n  === #${i + 1} ${sorted[i].pool.symbol} Detail ===`);
      reporter.printSummary(sorted[i].combined);
    }
  }

  const summaryPath = saveRunSummary({
    mode,
    sweep,
    profileName,
    top,
    manualPool,
    poolFile,
    csvDir,
    resultsDir,
    minTvl,
    minVol,
    minAge,
    days,
    balance,
    totalPools: poolDataList.length,
    profileResults,
  });
  log('SAVE', `Summary JSON: ${summaryPath}`);

  // ─── 4. 텔레그램 ───

  if (telegramEnabled && profileResults.some(pr => pr.results.length > 0)) {
    const notifier = new Notifier(botToken, chatId);
    if (sweep) {
      await sendSweepTelegram(notifier, profileResults, poolDataList.length);
    } else {
      const sorted = [...profileResults[0].results].sort((a, b) => comparePF(b.combined.profitFactor, a.combined.profitFactor));
      await sendTelegram(notifier, profileResults[0].profile, sorted.slice(0, top), poolDataList.length);
    }
  }

  // ─── 5. 드릴다운 안내 ───

  const allResults = profileResults.flatMap(pr => pr.results);
  if (allResults.length > 0) {
    const best = allResults.sort((a, b) => comparePF(b.combined.profitFactor, a.combined.profitFactor))[0];
    console.log(`\n  Drill-down:`);
    console.log(`  npx ts-node scripts/backtest.ts ${best.pool.address} --source csv --csv-dir ${csvDir} --min-buy-ratio 0 --trades --equity`);
  }

  log('DONE', 'Complete');
}

// ─── OHLCV 수집 (1회, 재사용) ───

async function collectOHLCV(
  manualPool: string | undefined,
  poolFile: string | undefined,
  csvDir: string,
  minTvl: number,
  minVol: number,
  minAge: number,
  days: number
): Promise<PoolMeta[]> {
  const gecko = new GeckoTerminalClient();
  let pools: GeckoPool[];

  if (manualPool) {
    log('POOL', `Manual: ${manualPool}`);
    pools = [await resolvePool(gecko, manualPool, minTvl, minVol, minAge)];
  } else if (poolFile) {
    const filePath = path.resolve(poolFile);
    log('POOL', `Pool file: ${filePath}`);
    pools = await loadPoolsFromFile(gecko, filePath, minTvl, minVol, minAge);
  } else {
    log('SCAN', 'GeckoTerminal Solana trending...');
    pools = await gecko.getTrendingPools();
    log('SCAN', `${pools.length} trending pools`);
  }

  // Universe 필터
  const filtered = manualPool ? pools : pools.filter(p => {
    if (p.tvlUsd < minTvl || p.volume24hUsd < minVol) return false;
    if (p.poolCreatedAt) {
      const ms = new Date(p.poolCreatedAt).getTime();
      if (Number.isNaN(ms) || (Date.now() - ms) / 3_600_000 < minAge) return false;
    }
    return true;
  });

  log('FILTER', `${filtered.length}/${pools.length} passed (TVL>=$${fmt$(minTvl)} Vol>=$${fmt$(minVol)} Age>=${minAge}h)`);

  // OHLCV 수집 + CSV 캐싱
  const collected: PoolMeta[] = [];

  for (let i = 0; i < filtered.length; i++) {
    const pool = filtered[i];
    const sym = pool.baseTokenSymbol || pool.name;
    const tag = `[${i + 1}/${filtered.length}] ${sym}`;
    const csvPath = path.join(csvDir, `${pool.address}_300.csv`);

    try {
      process.stdout.write(`  ${tag} `);
      const candles = await fetchCandlesForDays(gecko, pool.address, days);

      if (candles.length < 30) {
        console.log(`skip (${candles.length} bars)`);
        continue;
      }

      saveCsv(csvPath, candles);

      const ageHours = pool.poolCreatedAt
        ? (Date.now() - new Date(pool.poolCreatedAt).getTime()) / 3_600_000
        : 24;

      collected.push({
        address: pool.address,
        symbol: pool.baseTokenSymbol || pool.name,
        name: pool.name,
        tvlUsd: pool.tvlUsd,
        volume24hUsd: pool.volume24hUsd,
        ageHours,
      });

      console.log(`${candles.length} bars cached`);
    } catch (err) {
      console.log(`FAIL: ${err instanceof Error ? err.message : err}`);
    }
  }

  log('DATA', `${collected.length} pools ready for backtest`);
  return collected;
}

// ─── 프로필 실행 ───

async function runProfile(
  profile: Profile,
  pools: PoolMeta[],
  csvDir: string,
  balance: number
): Promise<PoolBacktestResult[]> {
  const results: PoolBacktestResult[] = [];
  const loader = new CsvLoader(csvDir);

  for (const pool of pools) {
    try {
      const candles = await loader.load(pool.address, 300);
      if (candles.length < 30) continue;

      const engineConfig: Partial<BacktestConfig> = {
        ...PROD_DEFAULTS,
        ...profile.config,
        initialBalance: balance,
        gatePoolInfo: {
          tvl: pool.tvlUsd,
          dailyVolume: pool.volume24hUsd,
          tokenAgeHours: pool.ageHours,
          top10HolderPct: 0.80,
          lpBurned: null,
          ownershipRenounced: null,
        },
      };

      const engine = new BacktestEngine(engineConfig);
      const { combined } = engine.runCombined(candles, pool.address);

      if (combined.totalTrades > 0) {
        results.push({
          pool,
          combined,
          assessment: assessMeasuredEdgeStage({
            netPnlPct: combined.netPnlPct,
            expectancyR: calcExpectancyR(combined),
            profitFactor: combined.profitFactor,
            sharpeRatio: combined.sharpeRatio,
            maxDrawdownPct: combined.maxDrawdownPct,
            totalTrades: combined.totalTrades,
          }),
        });
      }
    } catch {
      // CSV 로드 실패 등 — 무시
    }
  }

  return results;
}

// ─── 집계 ───

function computeAggregate(results: PoolBacktestResult[]) {
  if (results.length === 0) {
    return {
      totalTrades: 0,
      avgPF: 0,
      avgWR: 0,
      avgExpectancyR: 0,
      totalPnlPct: 0,
      maxDD: 0,
      positivePoolRatio: 0,
      edgeScore: 0,
      stageScore: 0,
      stageDecision: 'reject',
      edgeGateStatus: 'fail',
      edgeGateReasons: ['no_results'],
    };
  }

  const totalTrades = results.reduce((s, r) => s + r.combined.totalTrades, 0);
  const pfs = results.map(r => r.combined.profitFactor).filter(p => p !== Infinity && p > 0);
  const avgPF = pfs.length > 0 ? pfs.reduce((s, p) => s + p, 0) / pfs.length : 0;
  const avgWR = results.reduce((s, r) => s + r.combined.winRate, 0) / results.length;
  const avgExpectancyR = results.reduce((s, r) => s + calcExpectancyR(r.combined), 0) / results.length;
  const totalPnlPct = results.reduce((s, r) => s + r.combined.netPnlPct, 0) / results.length;
  const maxDD = Math.max(...results.map(r => r.combined.maxDrawdownPct));
  const positivePoolRatio = results.filter(r => r.combined.netPnlPct > 0).length / results.length;
  const assessment = assessMeasuredEdgeStage({
    netPnlPct: totalPnlPct,
    expectancyR: avgExpectancyR,
    profitFactor: avgPF,
    sharpeRatio: results.reduce((s, r) => s + r.combined.sharpeRatio, 0) / results.length,
    maxDrawdownPct: maxDD,
    totalTrades,
    positiveTokenRatio: positivePoolRatio,
  });

  return {
    totalTrades,
    avgPF,
    avgWR,
    avgExpectancyR,
    totalPnlPct,
    maxDD,
    positivePoolRatio,
    edgeScore: assessment.edgeScore,
    stageScore: assessment.stageScore,
    stageDecision: assessment.decision,
    edgeGateStatus: assessment.gateStatus,
    edgeGateReasons: assessment.gateReasons,
  };
}

// ─── 출력 ───

function printSweepComparison(profileResults: ProfileResult[], totalPools: number, balance: number): void {
  const hr = '═'.repeat(78);
  console.log(`\n${hr}`);
  console.log(`  PARAMETER SWEEP COMPARISON | ${totalPools} pools | ${balance} SOL`);
  console.log(hr);

  console.log(
    '  ' + pad('Profile', 20) + pad('Pools', 7) + pad('Trades', 8) +
    pad('Avg PF', 8) + pad('Avg ExpR', 10) + pad('Avg PnL%', 10) + pad('Edge', 7) + pad('Decision', 13)
  );
  console.log('  ' + '─'.repeat(86));

  for (const pr of profileResults) {
    const a = pr.aggregate;
    const pnl = (a.totalPnlPct * 100).toFixed(2);
    console.log(
      '  ' +
      pad(pr.profile.name, 20) +
      pad(String(pr.results.length), 7) +
      pad(String(a.totalTrades), 8) +
      pad(a.avgPF.toFixed(2), 8) +
      pad(a.avgExpectancyR.toFixed(2), 10) +
      pad((Number(pnl) >= 0 ? '+' : '') + pnl + '%', 10) +
      pad(a.edgeScore.toFixed(1), 7) +
      pad(a.stageDecision, 13)
    );
  }

  console.log(hr);

  // 최적 프로필 추천
  const best = profileResults
    .filter(pr => pr.aggregate.totalTrades > 0)
    .sort((a, b) => {
      if (b.aggregate.edgeScore !== a.aggregate.edgeScore) {
        return b.aggregate.edgeScore - a.aggregate.edgeScore;
      }
      return b.aggregate.avgPF - a.aggregate.avgPF;
    })[0];
  if (best) {
    console.log(`  Best Stage: ${best.profile.name} (edge ${best.aggregate.edgeScore.toFixed(1)}, ${best.aggregate.stageDecision})`);
  }
}

function printProfileRanking(profile: Profile, results: PoolBacktestResult[]): void {
  const hr = '─'.repeat(78);
  console.log(`\n${hr}`);
  console.log(`  ${profile.name} — Top ${results.length}`);
  console.log(hr);

  if (results.length === 0) {
    console.log('  No trades.');
    return;
  }

  console.log(
    '  ' + pad('#', 4) + pad('Symbol', 10) + pad('Pool', 12) +
    pad('PF', 7) + pad('WR', 6) + pad('Trades', 8) +
    pad('PnL%', 8) + pad('ExpR', 7) + pad('Edge', 7) + pad('Decision', 13) + pad('TVL', 10) + 'Age'
  );
  console.log('  ' + '─'.repeat(96));

  for (let i = 0; i < results.length; i++) {
    const { pool, combined: r } = results[i];
    const pnlPct = (r.netPnlPct * 100).toFixed(1);
    console.log(
      '  ' +
      pad(`#${i + 1}`, 4) +
      pad(pool.symbol.slice(0, 9), 10) +
      pad(pool.address.slice(0, 10) + '..', 12) +
      pad(formatPF(r.profitFactor), 7) +
      pad((r.winRate * 100).toFixed(0) + '%', 6) +
      pad(String(r.totalTrades), 8) +
      pad((Number(pnlPct) >= 0 ? '+' : '') + pnlPct, 8) +
      pad(calcExpectancyR(r).toFixed(2), 7) +
      pad(results[i].assessment.edgeScore.toFixed(1), 7) +
      pad(results[i].assessment.decision, 13) +
      pad('$' + fmt$(pool.tvlUsd), 10) +
      Math.round(pool.ageHours) + 'h'
    );
  }
}

// ─── 텔레그램 ───

async function sendSweepTelegram(
  notifier: Notifier,
  profileResults: ProfileResult[],
  totalPools: number
): Promise<void> {
  const lines = [
    `<b>Auto-Backtest Profile Comparison</b>`,
    `${new Date().toISOString().slice(0, 10)} | 검사한 풀 ${totalPools}개`,
    `기준: PF 1.30+ 양호 / 1.00+ 보통 / 1.00 미만 주의`,
    `기준: MDD 10% 이하 안정적 / 20% 이하 보통 / 그 이상 변동성 큼`,
    '',
  ];

  for (const pr of profileResults) {
    const a = pr.aggregate;
    const pnl = formatSignedPct(a.totalPnlPct);
    const effective = getEffectiveProfileConfig(pr.profile);
    lines.push(
      `<b>${escapeHtml(pr.profile.name)}</b> [${pr.profile.tag}]`,
      `- 진입 기준: Score ${effective.minBreakoutScore}+ | 리스크 ${formatPercent(effective.maxRiskPerTrade)} | 허용 MDD ${formatPercent(effective.maxDrawdownPct)}`,
      `- 거래 발생 풀: ${pr.results.length}개 | 총 거래: ${a.totalTrades}회`,
      `- 수익성(PF): ${a.avgPF.toFixed(2)} (${describeProfitFactor(a.avgPF)})`,
      `- 기대값(ExpR): ${a.avgExpectancyR.toFixed(2)} | Edge ${a.edgeScore.toFixed(1)} (${a.stageDecision})`,
      `- 승률: ${(a.avgWR * 100).toFixed(0)}%`,
      `- 누적 손익: ${pnl}`,
      `- 최대 낙폭(MDD): ${formatPercent(a.maxDD)} (${describeDrawdown(a.maxDD)})`,
      '',
    );
  }

  await notifier.sendTradeAlert(lines.join('\n'));
  log('TG', 'Sweep report sent');
}

async function sendTelegram(
  notifier: Notifier,
  profile: Profile,
  results: PoolBacktestResult[],
  totalPools: number
): Promise<void> {
  const effective = getEffectiveProfileConfig(profile);
  const lines = [
    `<b>Auto-Backtest Result</b> [${profile.tag}]`,
    `${new Date().toISOString().slice(0, 10)} | 검사한 풀 ${totalPools}개 | 거래 발생 ${results.length}개`,
    `프로필: ${escapeHtml(profile.name)}`,
    `진입 기준: Score ${effective.minBreakoutScore}+ | 1회 리스크 ${formatPercent(effective.maxRiskPerTrade)} | 허용 MDD ${formatPercent(effective.maxDrawdownPct)}`,
    `해석: PF 높을수록 좋고, MDD 낮을수록 안정적`,
    '',
  ];

  for (let i = 0; i < results.length; i++) {
    const { pool, combined: r } = results[i];
    const pnlPct = formatSignedPct(r.netPnlPct);
    lines.push(
      `<b>#${i + 1} ${escapeHtml(pool.symbol)}</b> <code>${pool.address.slice(0, 6)}..${pool.address.slice(-2)}</code>`,
      `- 총평: ${describeOverallResult(r.profitFactor, r.netPnlPct, r.maxDrawdownPct)} | Edge ${results[i].assessment.edgeScore.toFixed(1)} (${results[i].assessment.decision})`,
      `- 누적 손익: ${pnlPct}`,
      `- 승률: ${(r.winRate * 100).toFixed(0)}% | 거래 수: ${r.totalTrades}회 | ExpR ${calcExpectancyR(r).toFixed(2)}`,
      `- 수익성(PF): ${formatPF(r.profitFactor)} (${describeProfitFactor(r.profitFactor)})`,
      `- 최대 낙폭(MDD): ${formatPercent(r.maxDrawdownPct)} (${describeDrawdown(r.maxDrawdownPct)})`,
      `- 참고: TVL $${fmt$(pool.tvlUsd)} | 풀 나이 ${Math.round(pool.ageHours)}h`,
      '',
    );
  }

  await notifier.sendTradeAlert(lines.join('\n'));
  log('TG', 'Report sent');
}

export interface AutoBacktestSummaryInput {
  mode: string;
  sweep: boolean;
  profileName: string;
  top: number;
  manualPool?: string;
  poolFile?: string;
  csvDir: string;
  resultsDir: string;
  minTvl: number;
  minVol: number;
  minAge: number;
  days: number;
  balance: number;
  totalPools: number;
  profileResults: ProfileResult[];
}

export function buildAutoBacktestSummary(input: AutoBacktestSummaryInput) {
  return {
    generatedAt: new Date().toISOString(),
    mode: input.mode,
    sweep: input.sweep,
    requestedProfile: input.profileName,
    requestedTop: input.top,
    input: {
      manualPool: input.manualPool ?? null,
      poolFile: input.poolFile ?? null,
      csvDir: input.csvDir,
      minTvl: input.minTvl,
      minVol: input.minVol,
      minAge: input.minAge,
      days: input.days,
      balance: input.balance,
      totalPools: input.totalPools,
    },
    profiles: input.profileResults.map(pr => ({
      profile: {
        name: pr.profile.name,
        tag: pr.profile.tag,
        config: getEffectiveProfileConfig(pr.profile),
      },
      aggregate: pr.aggregate,
      results: [...pr.results]
        .sort((a, b) => comparePF(b.combined.profitFactor, a.combined.profitFactor))
        .map(result => ({
          pool: result.pool,
          metrics: {
            totalTrades: result.combined.totalTrades,
            winRate: result.combined.winRate,
            netPnlPct: result.combined.netPnlPct,
            profitFactor: result.combined.profitFactor,
            maxDrawdownPct: result.combined.maxDrawdownPct,
            sharpeRatio: result.combined.sharpeRatio,
            expectancyR: calcExpectancyR(result.combined),
          },
          assessment: {
            edgeScore: result.assessment.edgeScore,
            stageScore: result.assessment.stageScore,
            stageDecision: result.assessment.decision,
            edgeGateStatus: result.assessment.gateStatus,
            edgeGateReasons: result.assessment.gateReasons,
            edgeScoreBreakdown: result.assessment.breakdown,
          },
        })),
    })),
  };
}

export function saveRunSummary(input: AutoBacktestSummaryInput): string {
  if (!fs.existsSync(input.resultsDir)) fs.mkdirSync(input.resultsDir, { recursive: true });

  const summary = buildAutoBacktestSummary(input);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `auto-backtest-${input.sweep ? 'sweep' : input.profileName}-${timestamp}.json`;
  const outPath = path.join(input.resultsDir, filename);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf-8');
  return outPath;
}

// ─── CSV ───

function saveCsv(filepath: string, candles: Candle[]): void {
  const header = 'timestamp,open,high,low,close,volume,trade_count,buy_volume,sell_volume';
  const rows = candles.map(c => [
    Math.floor(c.timestamp.getTime() / 1000),
    c.open,
    c.high,
    c.low,
    c.close,
    c.volume,
    c.tradeCount,
    c.buyVolume,
    c.sellVolume,
  ].join(','));
  fs.writeFileSync(filepath, [header, ...rows].join('\n'), 'utf-8');
}

// ─── Helpers ───

function getEffectiveProfileConfig(profile: Profile): Partial<BacktestConfig> {
  return { ...PROD_DEFAULTS, ...profile.config };
}

function formatPercent(value?: number): string {
  if (value == null) return 'N/A';
  return `${(value * 100).toFixed(1)}%`;
}

function formatSignedPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}

function describeProfitFactor(value: number): string {
  if (!Number.isFinite(value)) return '매우 강함';
  if (value >= 1.3) return '양호';
  if (value >= 1.0) return '보통';
  return '주의';
}

function describeDrawdown(value: number): string {
  if (value <= 0.10) return '안정적';
  if (value <= 0.20) return '보통';
  return '변동성 큼';
}

function describeOverallResult(profitFactor: number, pnlPct: number, maxDrawdownPct: number): string {
  if (profitFactor >= 1.3 && pnlPct > 0 && maxDrawdownPct <= 0.15) {
    return '수익성과 안정성이 모두 양호';
  }
  if (profitFactor >= 1.0 && pnlPct >= 0 && maxDrawdownPct <= 0.25) {
    return '실사용 검토 가능';
  }
  if (pnlPct < 0 || profitFactor < 1.0) {
    return '현재 기준으로는 비추천';
  }
  return '추가 확인 필요';
}

function calcExpectancyR(result: BacktestResult): number {
  if (result.trades.length === 0) return 0;

  const rMultiples = result.trades
    .map(trade => {
      const plannedRisk = Math.abs(trade.entryPrice - trade.stopLoss) * trade.quantity;
      if (!Number.isFinite(plannedRisk) || plannedRisk <= 0) return Number.NaN;
      return trade.pnlSol / plannedRisk;
    })
    .filter(value => Number.isFinite(value));

  if (rMultiples.length === 0) return 0;
  return rMultiples.reduce((sum, value) => sum + value, 0) / rMultiples.length;
}

async function fetchCandlesForDays(
  gecko: GeckoTerminalClient,
  poolAddress: string,
  days: number
): Promise<Candle[]> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - days * 24 * 3600;
  return fetchCandlesForRange(gecko, poolAddress, from, now);
}

async function fetchCandlesForRange(
  gecko: GeckoTerminalClient,
  poolAddress: string,
  from: number,
  to: number
): Promise<Candle[]> {
  const merged = new Map<number, Candle>();
  let cursor = from;

  while (cursor <= to) {
    const chunkTo = Math.min(cursor + CHUNK_SPAN_SEC, to);
    const candles = await gecko.getOHLCV(poolAddress, DEFAULT_INTERVAL, cursor, chunkTo);

    for (const candle of candles) {
      merged.set(candle.timestamp.getTime(), candle);
    }

    if (chunkTo >= to) break;
    cursor = chunkTo + DEFAULT_INTERVAL_SEC;
  }

  return [...merged.values()].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

async function loadPoolsFromFile(
  gecko: GeckoTerminalClient,
  filePath: string,
  minTvl: number,
  minVol: number,
  minAge: number
): Promise<GeckoPool[]> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Pool file not found: ${filePath}`);
  }

  const addresses = fs.readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .map(line => line.split('#')[0].trim())
    .filter(Boolean)
    .map(line => line.split(/[,\s]+/)[0])
    .filter(Boolean);

  const pools: GeckoPool[] = [];

  for (const address of addresses) {
    pools.push(await resolvePool(gecko, address, minTvl, minVol, minAge));
  }

  return pools;
}

async function resolvePool(
  gecko: GeckoTerminalClient,
  address: string,
  minTvl: number,
  minVol: number,
  minAge: number
): Promise<GeckoPool> {
  try {
    const pool = await gecko.getPoolInfo(address);
    if (pool) return pool;
  } catch (error) {
    log('POOL', `Fallback meta for ${address}: ${error instanceof Error ? error.message : error}`);
  }

  return manualPoolEntry(address, minTvl, minVol, minAge);
}

function manualPoolEntry(address: string, minTvl: number, minVol: number, minAge: number): GeckoPool {
  return {
    address, name: address.slice(0, 8),
    baseTokenSymbol: '', baseTokenAddress: address,
    quoteTokenSymbol: 'SOL', quoteTokenAddress: '',
    tvlUsd: minTvl, volume24hUsd: minVol,
    poolCreatedAt: new Date(Date.now() - minAge * 3600 * 1000 - 1).toISOString(),
    buys24h: 0, sells24h: 0,
  };
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function numArg(args: string[], flag: string, fallback: number): number {
  const raw = getArg(args, flag);
  if (raw === undefined) return fallback;
  const num = Number(raw);
  if (Number.isNaN(num)) { console.error(`Invalid number for ${flag}: "${raw}"`); process.exit(1); }
  return num;
}

function formatPF(pf: number): string { return pf === Infinity ? 'INF' : pf.toFixed(2); }
function comparePF(a: number, b: number): number {
  return (a === Infinity ? 99999 : a) - (b === Infinity ? 99999 : b);
}
function fmt$(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'k';
  return n.toFixed(0);
}
function pad(s: string, len: number): string { return s.padEnd(len); }
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function log(tag: string, msg: string): void { console.log(`  [${tag}] ${msg}`); }
function banner(text: string): void {
  const hr = '═'.repeat(78);
  console.log(`\n${hr}\n  ${text}\n${hr}`);
}

function printHelp(): void {
  console.log(`
Auto-Backtest — 운영 파이프라인 재현 + 파라미터 비교

Usage:
  ./scripts/auto-backtest.sh               기본 실행 (balanced 프로필)
  ./scripts/auto-backtest.sh sweep          3개 프로필 비교
  ./scripts/auto-backtest.sh <ADDR>         특정 풀 테스트
  ./scripts/auto-backtest.sh drill <ADDR>   캐시 CSV 드릴다운

Profiles:
  conservative   Risk 0.5%, Score>=65, DD 20% — 안전 우선
  balanced       Risk 1%,   Score>=50, DD 30% — 운영 동일 (기본값)
  aggressive     Risk 2%,   Score>=40, DD 40% — 수익 추구

Options:
  --profile <name>   프로필 선택 (default: balanced)
  --sweep            3개 프로필 동시 비교
  --pool <addr>      특정 풀 (트렌딩 탐색 건너뜀)
  --pool-file <path> 풀 주소 목록 파일 (줄 단위)
  --top N            결과 수 (default: 10)
  --days N           수집 기간 day 수 (default: 7)
  --balance N        초기 SOL (default: 1)
  --min-tvl N        최소 TVL (default: 50000)
  --min-vol N        최소 볼륨 (default: 10000)
  --min-age N        최소 나이h (default: 24)
  --csv-dir <path>   CSV 경로 (default: ./data)
  --results-dir <p>  summary JSON 경로 (default: ./results)
  --no-notify        텔레그램 끄기
  `);
}

if (require.main === module) {
  main().catch(error => {
    console.error('Auto-backtest failed:', error);
    process.exit(1);
  });
}
