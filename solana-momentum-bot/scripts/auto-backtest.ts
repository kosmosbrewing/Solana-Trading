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
import { GeckoTerminalClient, GeckoPool, GeckoOHLCVBar } from '../src/ingester/geckoTerminalClient';
import {
  BacktestEngine,
  BacktestReporter,
  BacktestResult,
  CsvLoader,
  BacktestConfig,
} from '../src/backtest';
import { Notifier } from '../src/notifier/notifier';

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
}

interface ProfileResult {
  profile: Profile;
  results: PoolBacktestResult[];
  aggregate: {
    totalTrades: number;
    avgPF: number;
    avgWR: number;
    totalPnlPct: number;
    maxDD: number;
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
  const csvDir = getArg(args, '--csv-dir') || path.resolve(__dirname, '../data');
  const minTvl = numArg(args, '--min-tvl', 50_000);
  const minVol = numArg(args, '--min-vol', 10_000);
  const minAge = numArg(args, '--min-age', 24);
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
    manualPool, csvDir, minTvl, minVol, minAge
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
  csvDir: string,
  minTvl: number,
  minVol: number,
  minAge: number
): Promise<PoolMeta[]> {
  const gecko = new GeckoTerminalClient();
  let pools: GeckoPool[];

  if (manualPool) {
    log('POOL', `Manual: ${manualPool}`);
    pools = [manualPoolEntry(manualPool, minTvl, minVol, minAge)];
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

    try {
      process.stdout.write(`  ${tag} `);
      const ohlcv = await gecko.getOHLCV(pool.address);

      if (ohlcv.bars.length < 30) {
        console.log(`skip (${ohlcv.bars.length} bars)`);
        continue;
      }

      saveCsv(path.join(csvDir, `${pool.address}_300.csv`), ohlcv.bars);

      const ageHours = pool.poolCreatedAt
        ? (Date.now() - new Date(pool.poolCreatedAt).getTime()) / 3_600_000
        : 24;

      collected.push({
        address: pool.address,
        symbol: ohlcv.baseTokenSymbol || pool.baseTokenSymbol || pool.name,
        name: pool.name,
        tvlUsd: pool.tvlUsd,
        volume24hUsd: pool.volume24hUsd,
        ageHours,
      });

      console.log(`${ohlcv.bars.length} bars cached`);
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
          lpBurned: false,
          ownershipRenounced: false,
        },
      };

      const engine = new BacktestEngine(engineConfig);
      const { combined } = engine.runCombined(candles, pool.address);

      if (combined.totalTrades > 0) {
        results.push({ pool, combined });
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
    return { totalTrades: 0, avgPF: 0, avgWR: 0, totalPnlPct: 0, maxDD: 0 };
  }

  const totalTrades = results.reduce((s, r) => s + r.combined.totalTrades, 0);
  const pfs = results.map(r => r.combined.profitFactor).filter(p => p !== Infinity && p > 0);
  const avgPF = pfs.length > 0 ? pfs.reduce((s, p) => s + p, 0) / pfs.length : 0;
  const avgWR = results.reduce((s, r) => s + r.combined.winRate, 0) / results.length;
  const totalPnlPct = results.reduce((s, r) => s + r.combined.netPnlPct, 0) / results.length;
  const maxDD = Math.max(...results.map(r => r.combined.maxDrawdownPct));

  return { totalTrades, avgPF, avgWR, totalPnlPct, maxDD };
}

// ─── 출력 ───

function printSweepComparison(profileResults: ProfileResult[], totalPools: number, balance: number): void {
  const hr = '═'.repeat(78);
  console.log(`\n${hr}`);
  console.log(`  PARAMETER SWEEP COMPARISON | ${totalPools} pools | ${balance} SOL`);
  console.log(hr);

  console.log(
    '  ' + pad('Profile', 20) + pad('Pools', 7) + pad('Trades', 8) +
    pad('Avg PF', 8) + pad('Avg WR', 8) + pad('Avg PnL%', 10) + pad('Max DD%', 8)
  );
  console.log('  ' + '─'.repeat(69));

  for (const pr of profileResults) {
    const a = pr.aggregate;
    const pnl = (a.totalPnlPct * 100).toFixed(2);
    console.log(
      '  ' +
      pad(pr.profile.name, 20) +
      pad(String(pr.results.length), 7) +
      pad(String(a.totalTrades), 8) +
      pad(a.avgPF.toFixed(2), 8) +
      pad((a.avgWR * 100).toFixed(0) + '%', 8) +
      pad((Number(pnl) >= 0 ? '+' : '') + pnl + '%', 10) +
      pad((a.maxDD * 100).toFixed(1) + '%', 8)
    );
  }

  console.log(hr);

  // 최적 프로필 추천
  const best = profileResults
    .filter(pr => pr.aggregate.totalTrades > 0)
    .sort((a, b) => b.aggregate.avgPF - a.aggregate.avgPF)[0];
  if (best) {
    console.log(`  Best PF: ${best.profile.name} (avg PF ${best.aggregate.avgPF.toFixed(2)})`);
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
    pad('PnL%', 8) + pad('DD%', 7) + pad('TVL', 10) + 'Age'
  );
  console.log('  ' + '─'.repeat(76));

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
      pad((r.maxDrawdownPct * 100).toFixed(1) + '%', 7) +
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
    `<b>Auto-Backtest Sweep</b>`,
    `${new Date().toISOString().slice(0, 10)} | ${totalPools} pools`,
    '',
  ];

  for (const pr of profileResults) {
    const a = pr.aggregate;
    const pnl = (a.totalPnlPct * 100).toFixed(1);
    lines.push(
      `<b>${escapeHtml(pr.profile.name)}</b> [${pr.profile.tag}]`,
      `${pr.results.length} pools | ${a.totalTrades}t | PF ${a.avgPF.toFixed(2)} | WR ${(a.avgWR * 100).toFixed(0)}% | ${Number(pnl) >= 0 ? '+' : ''}${pnl}% | DD ${(a.maxDD * 100).toFixed(1)}%`,
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
  const lines = [
    `<b>Auto-Backtest</b> [${profile.tag}]`,
    `${new Date().toISOString().slice(0, 10)} | ${totalPools} pools | ${results.length} traded`,
    '',
  ];

  for (let i = 0; i < results.length; i++) {
    const { pool, combined: r } = results[i];
    const pnlPct = (r.netPnlPct * 100).toFixed(1);
    lines.push(
      `<b>#${i + 1} ${escapeHtml(pool.symbol)}</b> <code>${pool.address.slice(0, 6)}..${pool.address.slice(-2)}</code>`,
      `PF ${formatPF(r.profitFactor)} | WR ${(r.winRate * 100).toFixed(0)}% | ${r.totalTrades}t | ${Number(pnlPct) >= 0 ? '+' : ''}${pnlPct}% | DD ${(r.maxDrawdownPct * 100).toFixed(1)}%`,
      '',
    );
  }

  await notifier.sendTradeAlert(lines.join('\n'));
  log('TG', 'Report sent');
}

// ─── CSV ───

function saveCsv(filepath: string, bars: GeckoOHLCVBar[]): void {
  const header = 'timestamp,open,high,low,close,volume,trade_count,buy_volume,sell_volume';
  const rows = bars.map(b => [b.timestamp, b.open, b.high, b.low, b.close, b.volume, 0, 0, 0].join(','));
  fs.writeFileSync(filepath, [header, ...rows].join('\n'), 'utf-8');
}

// ─── Helpers ───

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
  --top N            결과 수 (default: 10)
  --balance N        초기 SOL (default: 1)
  --min-tvl N        최소 TVL (default: 50000)
  --min-vol N        최소 볼륨 (default: 10000)
  --min-age N        최소 나이h (default: 24)
  --csv-dir <path>   CSV 경로 (default: ./data)
  --no-notify        텔레그램 끄기
  `);
}

main().catch(error => {
  console.error('Auto-backtest failed:', error);
  process.exit(1);
});
