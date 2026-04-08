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
import { FAKE_FILL_SLIPPAGE_BPS_THRESHOLD } from '../src/utils/constants';

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
  planned_entry_price: string | null;
  decision_price: string | null;
  entry_slippage_bps: number | null;
  exit_slippage_bps: number | null;
  entry_price_impact_pct: string | null;
  round_trip_cost_pct: string | null;
  effective_rr: string | null;
  take_profit1: string | null;
  high_water_mark: string | null;
  // 2026-04-07: parent-child 그룹핑 (TP1 partial → child remainder 합산)
  parent_trade_id: string | null;
  // 2026-04-07: fake-fill / Phase A4 anomaly 마커 (comma-joined)
  exit_anomaly_reason: string | null;
}

// 2026-04-07: Jupiter Ultra outputAmountResult="0" fake-fill 경보 임계값은
// src/utils/constants.ts에 공유 상수로 존재 (9000bps = 90%).

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

// Why: TP1 partial은 부모 row + 자식 remainder row로 나뉘어 저장된다. row 단위 W/L은
// 한 엔트리를 중복 카운트하므로, 논리적 entry 기준으로 다시 합산해야 정확한 승률이 나온다.
// parent_trade_id가 null이면 자신이 parent, 아니면 parent에 귀속된다.
function groupByParent(rows: TradeRow[]): TradeRow[][] {
  const byParent = new Map<string, TradeRow[]>();
  for (const row of rows) {
    const key = row.parent_trade_id ?? row.id;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(row);
  }
  return Array.from(byParent.values());
}

interface ClosedEntryGroupSummary {
  rows: TradeRow[];
  totalPnl: number;
  tp1Hit: boolean;
  finalExitReason: string;
  exhaustionBeforeTp1: boolean;
  exhaustionAfterTp1: boolean;
}

function buildClosedEntryGroups(rows: TradeRow[], window: WindowConfig): ClosedEntryGroupSummary[] {
  const groups = groupByParent(rows);
  const summaries: ClosedEntryGroupSummary[] = [];
  for (const group of groups) {
    const hasRealizedCloseInWindow = group.some((row) => row.status === 'CLOSED' && inWindow(row.closed_at, window.windowStart));
    if (!hasRealizedCloseInWindow) continue;
    if (!group.every((row) => row.status === 'CLOSED')) continue;

    const parent = group.find((row) => row.parent_trade_id == null) ?? group[0];
    const sorted = [...group].sort((a, b) => (a.closed_at?.getTime() ?? 0) - (b.closed_at?.getTime() ?? 0));
    const lastRow = sorted[sorted.length - 1];
    const totalPnl = group.reduce((sum, row) => sum + Number(row.pnl ?? 0), 0);
    const tp1Hit = group.some((row) => row.exit_reason === 'TAKE_PROFIT_1');
    const takeProfit1 = Number(parent.take_profit1 ?? 0);
    const maxHighWaterMark = group.reduce((max, row) => Math.max(max, Number(row.high_water_mark ?? 0)), 0);
    const finalExitReason = lastRow.exit_reason ?? 'unknown';
    const exhaustionBeforeTp1 =
      finalExitReason === 'EXHAUSTION' &&
      takeProfit1 > 0 &&
      !tp1Hit &&
      maxHighWaterMark > entryPrice &&
      maxHighWaterMark > 0 &&
      maxHighWaterMark < takeProfit1;
    const exhaustionAfterTp1 =
      finalExitReason === 'EXHAUSTION' &&
      takeProfit1 > 0 &&
      (tp1Hit || maxHighWaterMark >= takeProfit1);

    summaries.push({
      rows: group,
      totalPnl,
      tp1Hit,
      finalExitReason,
      exhaustionBeforeTp1,
      exhaustionAfterTp1,
    });
  }
  return summaries;
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

  // Entry 기준: TP1 partial child를 parent에 다시 합산 — 논리적 거래 1건당 1 W/L
  const entryGroups = buildClosedEntryGroups(rows, window);
  const entryPnls = entryGroups.map((group) => group.totalPnl);
  const entryWins = entryPnls.filter((p) => p > 0).length;
  const entryLosses = entryPnls.length - entryWins;
  const entryWinRate = entryGroups.length > 0 ? (entryWins / entryGroups.length) * 100 : 0;
  const exhaustionGroups = entryGroups.filter((group) => group.finalExitReason === 'EXHAUSTION');
  const exhaustionBeforeTp1 = exhaustionGroups.filter((group) => group.exhaustionBeforeTp1).length;
  const exhaustionAfterTp1 = exhaustionGroups.filter((group) => group.exhaustionAfterTp1).length;

  console.log(` 총 실현 row: ${realized.length}건`);
  console.log(` 승/패 (row): ${wins.length}W / ${losses.length}L (승률 ${((wins.length / realized.length) * 100).toFixed(1)}%)`);
  console.log(` 승/패 (entry): ${entryWins}W / ${entryLosses}L (승률 ${entryWinRate.toFixed(1)}%) — partial close 합산 기준`);
  console.log(` 순 실현 손익: ${formatSignedSol(totalPnl)}`);
  console.log(` 토큰 수: ${grouped.length}개`);
  console.log(` EXHAUSTION (entry): ${exhaustionGroups.length}건 | pre-TP1 ${exhaustionBeforeTp1} | post-TP1 ${exhaustionAfterTp1}`);

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
      // 비용 분해 서브라인
      const costParts: string[] = [];
      if (trade.planned_entry_price != null) {
        const pp = Number(trade.planned_entry_price);
        const epNum = Number(trade.entry_price);
        const gapStr = pp > 0
          ? `${((epNum - pp) / pp * 100) >= 0 ? '+' : ''}${((epNum - pp) / pp * 100).toFixed(2)}%`
          : '---';
        costParts.push(`planned=${pp.toPrecision(6)} entryGap=${gapStr}`);
      }
      if (trade.decision_price != null) {
        const dp = Number(trade.decision_price);
        const xpNum = trade.exit_price ? Number(trade.exit_price) : null;
        const gapStr = xpNum != null && dp > 0
          ? `${((xpNum - dp) / dp * 100) >= 0 ? '+' : ''}${((xpNum - dp) / dp * 100).toFixed(2)}%`
          : '---';
        costParts.push(`decision=${dp.toPrecision(6)} exitGap=${gapStr}`);
      }
      if (trade.entry_slippage_bps != null || trade.exit_slippage_bps != null) {
        costParts.push(
          `entry_slip=${trade.entry_slippage_bps ?? '?'}bps exit_slip=${trade.exit_slippage_bps ?? '?'}bps`
        );
      }
      if (trade.round_trip_cost_pct != null || trade.effective_rr != null) {
        // Why: rtCost/effRR는 entry-time gate snapshot 값이다 (exit 시점 갱신 X)
        const rtc = trade.round_trip_cost_pct != null ? `${Number(trade.round_trip_cost_pct).toFixed(2)}%` : '?';
        const rr = trade.effective_rr != null ? Number(trade.effective_rr).toFixed(1) : '?';
        costParts.push(`rtCost(entry)=${rtc} effRR(entry)=${rr}`);
      }
      // 2026-04-07: fake-fill / Phase A4 anomaly 마커 노출
      if (trade.exit_anomaly_reason) {
        costParts.push(`anomaly=${trade.exit_anomaly_reason}`);
      }
      if (costParts.length > 0) {
        console.log(`      └ ${costParts.join(' | ')}`);
      }
    });
  }

  // 비용 집계 섹션
  printCostAggregation(realized);
}

// 2026-04-07 (F1-deep-1): saturated slippage row(>=9000bps) 1건이 4건 평균을 2500bps로
// 끌어올리는 outlier 효과를 ops-history 작성 시 즉시 가시화하기 위해 raw + trimmed 두 줄을 항상
// 출력한다. trimmed가 raw와 동일하면 contamination 없음을 확인할 수 있다.
function printSlippageRawAndTrimmed(label: 'entry' | 'exit', samples: number[]): void {
  const labelText = label === 'entry' ? 'entry slippage' : 'exit slippage ';
  const rawAvg = samples.reduce((s, v) => s + v, 0) / samples.length;
  const trimmed = samples.filter((v) => v < FAKE_FILL_SLIPPAGE_BPS_THRESHOLD);
  const excluded = samples.length - trimmed.length;
  const trimmedAvg =
    trimmed.length > 0 ? trimmed.reduce((s, v) => s + v, 0) / trimmed.length : 0;
  const trimmedNote =
    excluded > 0
      ? `excluded ${excluded} saturated >=${FAKE_FILL_SLIPPAGE_BPS_THRESHOLD}bps`
      : 'no saturated rows';
  console.log(` 평균 ${labelText} (raw):     ${rawAvg.toFixed(1)} bps (n=${samples.length})`);
  if (trimmed.length > 0) {
    console.log(
      ` 평균 ${labelText} (trimmed): ${trimmedAvg.toFixed(1)} bps (n=${trimmed.length}, ${trimmedNote})`
    );
  } else {
    console.log(
      ` 평균 ${labelText} (trimmed): -- bps (n=0, ${trimmedNote})`
    );
  }
}

function printCostAggregation(trades: TradeRow[]): void {
  const withEntrySl = trades.filter((t) => t.entry_slippage_bps != null);
  const withExitSl = trades.filter((t) => t.exit_slippage_bps != null);
  const withRtCost = trades.filter((t) => t.round_trip_cost_pct != null);
  const withEntryGap = trades.filter((t) => t.planned_entry_price != null);
  const withGap = trades.filter((t) => t.decision_price != null && t.exit_price != null);

  if (
    withEntrySl.length === 0 &&
    withExitSl.length === 0 &&
    withRtCost.length === 0 &&
    withEntryGap.length === 0 &&
    withGap.length === 0
  ) {
    return;
  }

  console.log(`\n${'─'.repeat(76)}`);
  console.log(' COST DECOMPOSITION (전체 집계)');
  console.log(`${'─'.repeat(76)}`);

  if (withEntrySl.length > 0) {
    printSlippageRawAndTrimmed('entry', withEntrySl.map((t) => t.entry_slippage_bps ?? 0));
  }
  if (withEntryGap.length > 0) {
    const gaps = withEntryGap.map((t) => {
      const pp = Number(t.planned_entry_price!);
      const ep = Number(t.entry_price);
      return pp > 0 ? ((ep - pp) / pp) * 100 : 0;
    });
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const maxGap = Math.max(...gaps.map(Math.abs));
    console.log(` 평균 entry gap (planned→fill): ${avgGap >= 0 ? '+' : ''}${avgGap.toFixed(2)}% (n=${withEntryGap.length}, max abs=${maxGap.toFixed(2)}%)`);
  }
  if (withExitSl.length > 0) {
    printSlippageRawAndTrimmed('exit', withExitSl.map((t) => t.exit_slippage_bps ?? 0));
  }
  if (withRtCost.length > 0) {
    const avg = withRtCost.reduce((s, t) => s + Number(t.round_trip_cost_pct ?? 0), 0) / withRtCost.length;
    // Why: 컬럼은 entry 시점 gate snapshot 값 — exit 시 갱신되지 않는다. 라벨 명시.
    console.log(` 평균 round-trip cost (entry-time gate snapshot): ${avg.toFixed(2)}% (n=${withRtCost.length})`);
  }
  if (withGap.length > 0) {
    const gaps = withGap.map((t) => {
      const dp = Number(t.decision_price!);
      const xp = Number(t.exit_price!);
      return dp > 0 ? ((xp - dp) / dp) * 100 : 0;
    });
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const maxGap = Math.max(...gaps.map(Math.abs));
    console.log(` 평균 exit gap (decision→fill): ${avgGap >= 0 ? '+' : ''}${avgGap.toFixed(2)}% (n=${withGap.length}, max abs=${maxGap.toFixed(2)}%)`);
  }

  printTakeProfitOutcomeSummary(trades);

  // 2026-04-07: Jupiter Ultra saturated swap 경보 — 마킹된 row가 있으면 위쪽 집계는 왜곡됨
  const fakeFillRows = trades.filter((t) =>
    (t.exit_anomaly_reason != null && t.exit_anomaly_reason.length > 0) ||
    (t.exit_slippage_bps != null && t.exit_slippage_bps >= FAKE_FILL_SLIPPAGE_BPS_THRESHOLD)
  );
  if (fakeFillRows.length > 0) {
    console.log(`\n ⚠ FAKE-FILL WARNING: ${fakeFillRows.length}/${trades.length} rows contain saturated slippage or anomaly markers.`);
    console.log(`   → Aggregations above (esp. exit slippage avg) are distorted. Filter and re-run for clean view.`);
  }
}

function printTakeProfitOutcomeSummary(trades: TradeRow[]): void {
  const tp2Rows = trades.filter((t) => t.exit_reason === 'TAKE_PROFIT_2');
  if (tp2Rows.length === 0) return;

  const wins = tp2Rows.filter((t) => Number(t.pnl ?? 0) > 0).length;
  const losses = tp2Rows.length - wins;
  const totalPnl = tp2Rows.reduce((sum, t) => sum + Number(t.pnl ?? 0), 0);

  console.log(` TP2 realized outcome: ${wins}W / ${losses}L | net=${formatSignedSol(totalPnl)} (n=${tp2Rows.length})`);
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
    const query = window.windowStart
      ? `
        WITH seeded_groups AS (
          SELECT DISTINCT COALESCE(parent_trade_id, id) AS trade_group_id
          FROM trades
          WHERE created_at >= $1 OR closed_at >= $1
        )
        SELECT t.*
        FROM trades t
        JOIN seeded_groups g
          ON COALESCE(t.parent_trade_id, t.id) = g.trade_group_id
        ORDER BY COALESCE(t.closed_at, t.created_at) ASC, t.created_at ASC
      `
      : `
        SELECT *
        FROM trades
        ORDER BY COALESCE(closed_at, created_at) ASC, created_at ASC
      `;
    const params = window.windowStart ? [window.windowStart] : [];

    const { rows } = await pool.query<TradeRow>(query, params);

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
