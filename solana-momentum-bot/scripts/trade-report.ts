/**
 * VPS DB 거래 리포트 스크립트
 *
 * Usage:
 *   npx ts-node scripts/trade-report.ts              # 최근 24h
 *   npx ts-node scripts/trade-report.ts --hours 48   # 최근 48h
 *   npx ts-node scripts/trade-report.ts --all        # 전체
 *
 * 필수 환경변수: DATABASE_URL
 *
 * 주의:
 * - 이 리포트는 created_at(활동량)과 closed_at(실현 손익)을 분리해 출력한다.
 * - TP1/TP2 부분 청산은 별도 CLOSED row + 잔여 OPEN row를 생성하므로,
 *   row 수는 독립 진입 횟수와 다를 수 있다.
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
  breakout_grade: string | null;
  exit_reason: string | null;
  status: string;
  created_at: Date;
  closed_at: Date | null;
}

interface WindowConfig {
  dbNow: Date;
  windowStart?: Date;
  label: string;
}

function parseArgs(): { hours: number | null; showAll: boolean } {
  const args = process.argv.slice(2);
  const showAll = args.includes('--all');
  const hoursIdx = args.indexOf('--hours');
  const hours = hoursIdx >= 0 ? Number(args[hoursIdx + 1]) : (showAll ? null : 24);
  return { hours, showAll };
}

function buildWindowConfig(dbNow: Date, hours: number | null): WindowConfig {
  if (hours == null) {
    return { dbNow, label: '전체' };
  }

  return {
    dbNow,
    windowStart: new Date(dbNow.getTime() - hours * 3_600_000),
    label: `최근 ${hours}h`,
  };
}

function inWindow(ts: Date | null | undefined, windowStart?: Date): boolean {
  if (!ts) return false;
  if (!windowStart) return true;
  return ts.getTime() >= windowStart.getTime();
}

function formatTimestamp(ts?: Date | null): string {
  if (!ts) return '---';
  return ts.toISOString().slice(0, 19);
}

function formatShortTimestamp(ts?: Date | null): string {
  if (!ts) return '---';
  return ts.toISOString().slice(5, 16).replace('T', ' ');
}

function formatMs(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function formatSignedSol(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(6)} SOL`;
}

function getTokenLabel(rows: TradeRow[]): { symbol: string; shortAddr: string } {
  const symbol = rows.find((row) => row.token_symbol)?.token_symbol ?? rows[0].pair_address.slice(0, 12);
  const addr = rows[0].pair_address;
  return {
    symbol: symbol.toUpperCase(),
    shortAddr: `${addr.slice(0, 12)}...${addr.slice(-6)}`,
  };
}

function groupByPair(rows: TradeRow[]): Array<[string, TradeRow[]]> {
  const grouped = new Map<string, TradeRow[]>();
  for (const row of rows) {
    const key = row.pair_address;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(row);
  }
  return Array.from(grouped.entries()).sort((a, b) => b[1].length - a[1].length);
}

function printActivitySummary(rows: TradeRow[], window: WindowConfig): void {
  const openedRows = rows.filter((row) => inWindow(row.created_at, window.windowStart));
  const openRows = openedRows.filter((row) => row.status === 'OPEN');
  const closedRows = openedRows.filter((row) => row.status === 'CLOSED');
  const partialRows = closedRows.filter((row) =>
    row.exit_reason === 'TAKE_PROFIT_1' || row.exit_reason === 'TAKE_PROFIT_2'
  );

  console.log('='.repeat(76));
  console.log(`   TRADE REPORT (${window.label}) — 운영 원장 + 실현 손익 분리`);
  console.log(`   Window: ${window.windowStart ? formatTimestamp(window.windowStart) : 'BEGIN'} ~ ${formatTimestamp(window.dbNow)}`);
  console.log('='.repeat(76));
  console.log(` opened_at 기준 row: ${openedRows.length}건`);
  console.log(` closed_at 기준 실현 row: ${rows.filter((row) => row.status === 'CLOSED' && inWindow(row.closed_at, window.windowStart)).length}건`);
  console.log(` 현재 OPEN row: ${openRows.length}건`);
  console.log(` partial close row(TP1/TP2): ${partialRows.length}건`);
  console.log(' 주의: row 수는 독립 진입 횟수와 다를 수 있음 (부분 청산 시 row 분기).');
}

function printRealizedSummary(rows: TradeRow[], window: WindowConfig): void {
  const realized = rows
    .filter((row) => row.status === 'CLOSED' && inWindow(row.closed_at, window.windowStart))
    .sort((a, b) => (a.closed_at?.getTime() ?? 0) - (b.closed_at?.getTime() ?? 0));

  console.log(`\n${'='.repeat(76)}`);
  console.log('   REALIZED PNL (closed_at 기준)');
  console.log(`${'='.repeat(76)}`);

  if (realized.length === 0) {
    console.log(' 실현 손익 row 없음.');
    return;
  }

  const grouped = groupByPair(realized);
  const totalPnl = realized.reduce((sum, row) => sum + Number(row.pnl ?? 0), 0);
  const wins = realized.filter((row) => Number(row.pnl ?? 0) > 0);
  const losses = realized.filter((row) => Number(row.pnl ?? 0) <= 0);

  console.log(` 총 실현 row: ${realized.length}건`);
  console.log(` 승/패: ${wins.length}W / ${losses.length}L (승률 ${((wins.length / realized.length) * 100).toFixed(1)}%)`);
  console.log(` 순 실현 손익: ${formatSignedSol(totalPnl)}`);
  console.log(` 토큰 수: ${grouped.length}개`);

  for (const [, trades] of grouped) {
    const { symbol, shortAddr } = getTokenLabel(trades);
    const pnls = trades.map((trade) => Number(trade.pnl ?? 0));
    const localWins = pnls.filter((pnl) => pnl > 0);
    const localLosses = pnls.filter((pnl) => pnl <= 0);
    const holdTimes = trades
      .filter((trade) => trade.closed_at)
      .map((trade) => trade.closed_at!.getTime() - trade.created_at.getTime());

    console.log(`\n${'─'.repeat(76)}`);
    console.log(` ${symbol} (${shortAddr})`);
    console.log(`${'─'.repeat(76)}`);
    console.log(` 실현 row: ${trades.length}건`);
    console.log(` 승/패: ${localWins.length}W / ${localLosses.length}L (승률 ${((localWins.length / trades.length) * 100).toFixed(1)}%)`);
    console.log(` 순 손익: ${formatSignedSol(pnls.reduce((a, b) => a + b, 0))}`);
    if (localWins.length > 0) {
      console.log(` 평균 수익: ${formatSignedSol(localWins.reduce((a, b) => a + b, 0) / localWins.length)}`);
    }
    if (localLosses.length > 0) {
      console.log(` 평균 손실: ${formatSignedSol(localLosses.reduce((a, b) => a + b, 0) / localLosses.length)}`);
    }

    const exitReasons = new Map<string, number>();
    for (const trade of trades) {
      const reason = trade.exit_reason ?? 'unknown';
      exitReasons.set(reason, (exitReasons.get(reason) ?? 0) + 1);
    }
    console.log(
      ` 종료 사유: ${Array.from(exitReasons.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => `${reason}=${count}`)
        .join(', ')}`
    );

    if (holdTimes.length > 0) {
      const avgHold = holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length;
      console.log(
        ` 보유 시간: 평균 ${formatMs(avgHold)} / 최소 ${formatMs(Math.min(...holdTimes))} / 최대 ${formatMs(Math.max(...holdTimes))}`
      );
    }

    const partialRows = trades.filter((trade) =>
      trade.exit_reason === 'TAKE_PROFIT_1' || trade.exit_reason === 'TAKE_PROFIT_2'
    ).length;
    if (partialRows > 0) {
      console.log(` partial close row: ${partialRows}건`);
    }

    console.log('\n   # | 종료시각 (UTC)   | 전략         | 진입가        | 종료가        | PnL (SOL)   | 사유       | 등급');
    console.log(`   ${'-'.repeat(100)}`);
    trades.forEach((trade, index) => {
      const ep = Number(trade.entry_price).toPrecision(6);
      const xp = trade.exit_price ? Number(trade.exit_price).toPrecision(6) : '---';
      const pnl = `${Number(trade.pnl ?? 0) >= 0 ? '+' : ''}${Number(trade.pnl ?? 0).toFixed(6)}`;
      const reason = (trade.exit_reason ?? '---').padEnd(10).slice(0, 10);
      const grade = (trade.breakout_grade ?? '-').padEnd(2);
      const strategy = trade.strategy.padEnd(12).slice(0, 12);
      console.log(
        `  ${String(index + 1).padStart(2)} | ${formatShortTimestamp(trade.closed_at).padEnd(16)} | ${strategy} | ${ep.padStart(12)} | ${xp.padStart(12)} | ${pnl.padStart(11)} | ${reason} | ${grade}`
      );
    });
  }
}

function printLedgerActivity(rows: TradeRow[], window: WindowConfig): void {
  const opened = rows
    .filter((row) => inWindow(row.created_at, window.windowStart))
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

  console.log(`\n${'='.repeat(76)}`);
  console.log('   LEDGER ACTIVITY (created_at 기준)');
  console.log(`${'='.repeat(76)}`);

  if (opened.length === 0) {
    console.log(' created_at 기준 row 없음.');
    return;
  }

  const grouped = groupByPair(opened);
  console.log(` 총 opened row: ${opened.length}건`);

  for (const [, trades] of grouped) {
    const { symbol, shortAddr } = getTokenLabel(trades);
    const closed = trades.filter((trade) => trade.status === 'CLOSED');
    const open = trades.filter((trade) => trade.status === 'OPEN');

    console.log(`\n${'─'.repeat(76)}`);
    console.log(` ${symbol} (${shortAddr})`);
    console.log(`${'─'.repeat(76)}`);
    console.log(` opened row: ${trades.length}건 (종료 ${closed.length} / 미결 ${open.length})`);

    const byReason = new Map<string, number>();
    for (const trade of closed) {
      const reason = trade.exit_reason ?? 'unknown';
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    }
    if (byReason.size > 0) {
      console.log(
        ` 종료 사유: ${Array.from(byReason.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([reason, count]) => `${reason}=${count}`)
          .join(', ')}`
      );
    }

    if (open.length > 0) {
      console.log(' 현재 OPEN rows:');
      open.forEach((trade) => {
        console.log(
          `   - ${formatShortTimestamp(trade.created_at)} | ${trade.strategy} | entry=${Number(trade.entry_price).toPrecision(6)} | qty=${Number(trade.quantity).toFixed(6)}`
        );
      });
    }
  }
}

async function main() {
  const { hours } = parseArgs();

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
    const nowResult = await pool.query<{ db_now: Date }>('SELECT now() AS db_now');
    const window = buildWindowConfig(nowResult.rows[0].db_now, hours);
    const whereClause = window.windowStart
      ? `WHERE created_at >= $1 OR closed_at >= $1`
      : '';
    const params = window.windowStart ? [window.windowStart] : [];

    const { rows } = await pool.query<TradeRow>(
      `SELECT * FROM trades ${whereClause} ORDER BY COALESCE(closed_at, created_at) ASC, created_at ASC`,
      params
    );

    if (rows.length === 0) {
      console.log(hours ? `최근 ${hours}시간 거래 없음.` : '거래 없음.');
      return;
    }

    printActivitySummary(rows, window);
    printRealizedSummary(rows, window);
    printLedgerActivity(rows, window);
  } catch (err) {
    console.error(`DB 조회 실패: ${err}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err}`);
  process.exit(1);
});
