/**
 * VPS DB 거래 리포트 스크립트
 *
 * Usage:
 *   npx ts-node scripts/trade-report.ts              # 최근 24h
 *   npx ts-node scripts/trade-report.ts --hours 48   # 최근 48h
 *   npx ts-node scripts/trade-report.ts --all         # 전체
 *
 * 필수 환경변수: DATABASE_URL
 */
import { Pool } from 'pg';

interface TradeRow {
  id: string;
  pair_address: string;
  strategy: string;
  token_symbol: string | null;
  entry_price: string;
  exit_price: string | null;
  quantity: string;
  pnl: string | null;
  slippage: string | null;
  breakout_score: number | null;
  breakout_grade: string | null;
  exit_reason: string | null;
  status: string;
  stop_loss: string;
  take_profit1: string;
  take_profit2: string;
  source_label: string | null;
  size_constraint: string | null;
  created_at: Date;
  closed_at: Date | null;
}

async function main() {
  const args = process.argv.slice(2);
  const showAll = args.includes('--all');
  const hoursIdx = args.indexOf('--hours');
  const hours = hoursIdx >= 0 ? Number(args[hoursIdx + 1]) : (showAll ? null : 24);

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('ERROR: DATABASE_URL 환경변수가 필요합니다.');
    console.error('  export DATABASE_URL=postgres://user:pass@host:5432/dbname');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: dbUrl,
    max: 3,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 5_000,
  });

  try {
    const whereClause = hours
      ? `WHERE created_at >= now() - interval '${hours} hours'`
      : '';
    const { rows } = await pool.query<TradeRow>(
      `SELECT * FROM trades ${whereClause} ORDER BY created_at ASC`
    );

    if (rows.length === 0) {
      console.log(hours ? `최근 ${hours}시간 거래 없음.` : '거래 없음.');
      return;
    }

    const periodLabel = hours ? `최근 ${hours}h` : '전체';
    const firstTs = rows[0].created_at.toISOString().slice(0, 19);
    const lastTs = rows[rows.length - 1].created_at.toISOString().slice(0, 19);

    console.log('='.repeat(76));
    console.log(`   TRADE REPORT (${periodLabel}) — DB 실거래 기록`);
    console.log(`   ${firstTs} ~ ${lastTs}`);
    console.log('='.repeat(76));

    // ─── Token-level summary ─────────────────────────
    const byToken = new Map<string, TradeRow[]>();
    for (const row of rows) {
      const key = row.pair_address;
      if (!byToken.has(key)) byToken.set(key, []);
      byToken.get(key)!.push(row);
    }

    let totalPnl = 0;
    let totalTrades = 0;
    let totalWins = 0;
    let totalLosses = 0;
    let totalOpen = 0;

    const sortedTokens = Array.from(byToken.entries()).sort(
      (a, b) => b[1].length - a[1].length
    );
    for (const [pairAddress, trades] of sortedTokens) {
      const symbol = trades[0].token_symbol || pairAddress.slice(0, 12);
      const shortAddr = `${pairAddress.slice(0, 12)}...${pairAddress.slice(-6)}`;
      const closed = trades.filter((t) => t.status === 'CLOSED');
      const open = trades.filter((t) => t.status === 'OPEN');

      console.log(`\n${'─'.repeat(76)}`);
      console.log(` ${symbol.toUpperCase()} (${shortAddr})`);
      console.log(`${'─'.repeat(76)}`);
      console.log(` 거래: ${trades.length}건 (종료 ${closed.length} / 미결 ${open.length})`);

      if (closed.length > 0) {
        const pnls = closed.map((t) => Number(t.pnl ?? 0));
        const wins = pnls.filter((p) => p > 0);
        const losses = pnls.filter((p) => p <= 0);
        const sumPnl = pnls.reduce((a, b) => a + b, 0);
        const winRate = wins.length / closed.length;

        totalPnl += sumPnl;
        totalTrades += closed.length;
        totalWins += wins.length;
        totalLosses += losses.length;

        console.log(` 승/패: ${wins.length}W / ${losses.length}L (승률 ${(winRate * 100).toFixed(1)}%)`);
        console.log(` 순 손익: ${sumPnl >= 0 ? '+' : ''}${sumPnl.toFixed(6)} SOL`);
        if (wins.length > 0) {
          console.log(` 평균 수익: +${(wins.reduce((a, b) => a + b, 0) / wins.length).toFixed(6)} SOL`);
        }
        if (losses.length > 0) {
          console.log(` 평균 손실: ${(losses.reduce((a, b) => a + b, 0) / losses.length).toFixed(6)} SOL`);
        }

        // Exit reason breakdown
        const exitReasons = new Map<string, number>();
        for (const t of closed) {
          const reason = t.exit_reason ?? 'unknown';
          exitReasons.set(reason, (exitReasons.get(reason) ?? 0) + 1);
        }
        const reasonStr = Array.from(exitReasons.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([r, c]) => `${r}=${c}`)
          .join(', ');
        console.log(` 종료 사유: ${reasonStr}`);

        // Hold time
        const holdTimes = closed
          .filter((t) => t.closed_at)
          .map((t) => t.closed_at!.getTime() - t.created_at.getTime());
        if (holdTimes.length > 0) {
          const avgHold = holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length;
          const minHold = Math.min(...holdTimes);
          const maxHold = Math.max(...holdTimes);
          console.log(
            ` 보유 시간: 평균 ${formatMs(avgHold)} / 최소 ${formatMs(minHold)} / 최대 ${formatMs(maxHold)}`
          );
        }

        // Strategy breakdown
        const byStrategy = new Map<string, { count: number; pnl: number }>();
        for (const t of closed) {
          const s = byStrategy.get(t.strategy) ?? { count: 0, pnl: 0 };
          s.count++;
          s.pnl += Number(t.pnl ?? 0);
          byStrategy.set(t.strategy, s);
        }
        if (byStrategy.size > 1) {
          console.log(` 전략별:`);
          for (const [strategy, stats] of Array.from(byStrategy.entries())) {
            console.log(`   ${strategy}: ${stats.count}건 / ${stats.pnl >= 0 ? '+' : ''}${stats.pnl.toFixed(6)} SOL`);
          }
        }

        // Grade breakdown
        const byGrade = new Map<string, { count: number; wins: number; pnl: number }>();
        for (const t of closed) {
          const g = t.breakout_grade ?? 'N/A';
          const entry = byGrade.get(g) ?? { count: 0, wins: 0, pnl: 0 };
          entry.count++;
          entry.pnl += Number(t.pnl ?? 0);
          if (Number(t.pnl ?? 0) > 0) entry.wins++;
          byGrade.set(g, entry);
        }
        if (byGrade.size > 0) {
          console.log(` 등급별:`);
          for (const [grade, stats] of Array.from(byGrade.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
            const wr = stats.count > 0 ? (stats.wins / stats.count * 100).toFixed(0) : '0';
            console.log(`   ${grade}: ${stats.count}건 / WR ${wr}% / ${stats.pnl >= 0 ? '+' : ''}${stats.pnl.toFixed(6)} SOL`);
          }
        }
      }

      // Individual trades table
      console.log(`\n   # | 시각 (UTC)      | 전략         | 진입가        | 종료가        | PnL (SOL)   | 사유       | 등급`);
      console.log(`   ${'-'.repeat(100)}`);
      for (let i = 0; i < trades.length; i++) {
        const t = trades[i];
        const ts = t.created_at.toISOString().slice(5, 16).replace('T', ' ');
        const ep = Number(t.entry_price).toPrecision(6);
        const xp = t.exit_price ? Number(t.exit_price).toPrecision(6) : '  ---   ';
        const pnl = t.pnl != null ? `${Number(t.pnl) >= 0 ? '+' : ''}${Number(t.pnl).toFixed(6)}` : '   ---   ';
        const reason = (t.exit_reason ?? (t.status === 'OPEN' ? 'OPEN' : '---')).padEnd(10).slice(0, 10);
        const grade = (t.breakout_grade ?? '-').padEnd(2);
        const strategy = t.strategy.padEnd(12).slice(0, 12);
        console.log(`  ${String(i + 1).padStart(2)} | ${ts} | ${strategy} | ${ep.padStart(12)} | ${xp.padStart(12)} | ${pnl.padStart(11)} | ${reason} | ${grade}`);
      }

      totalOpen += open.length;
    }

    // ─── Grand total ─────────────────────────────────
    console.log(`\n${'='.repeat(76)}`);
    console.log(`   TOTAL`);
    console.log(`${'='.repeat(76)}`);
    console.log(` 총 거래: ${rows.length}건 (종료 ${totalTrades} / 미결 ${totalOpen})`);
    console.log(` 승/패: ${totalWins}W / ${totalLosses}L (승률 ${totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(1) : 0}%)`);
    console.log(` 순 손익: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(6)} SOL`);
    console.log(` 토큰 수: ${byToken.size}개`);
  } catch (err) {
    console.error(`DB 조회 실패: ${err}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

function formatMs(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

main().catch((err) => {
  console.error(`Fatal: ${err}`);
  process.exit(1);
});
