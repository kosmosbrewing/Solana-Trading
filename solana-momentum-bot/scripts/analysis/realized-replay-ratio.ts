#!/usr/bin/env ts-node
/**
 * Realized vs Replay Edge Ratio
 *
 * Why: 2026-04-07 P3 — replay headline edge(+24.02% per-signal weighted adj)가
 * 실제 체결(라이브 또는 paper)을 거치면 얼마나 보존되는지 측정한다. 핵심 질문은
 * "1 SOL → 100 SOL mission에 도달하기 위한 edge 부족분이 얼마나 큰가?".
 *
 * Inputs (모두 디스크, 로컬 DB 의존성 0):
 *   - trades JSONL: `data/vps-trades-latest.jsonl` — `bash scripts/sync-vps-data.sh`로 동기화.
 *     row_to_json 출력이라 스키마 변화에 자동 적응.
 *   - signal jsonl: 각 세션의 `realtime-signals.jsonl` (replay-equivalent adj return horizon 포함)
 *
 * Output: 세션별 + 전체 ratio. realized_pnl_pct / predicted_adj_return_pct.
 *
 * Modes (--mode):
 *   - live (default): tx_signature ≠ 'PAPER_TRADE' (real wallet trades). 운영 reality check.
 *   - paper:          tx_signature = 'PAPER_TRADE'.
 *   - all:            paper + live 모두 포함.
 *
 * Usage:
 *   npx ts-node scripts/analysis/realized-replay-ratio.ts \
 *     [--mode live|paper|all] [--horizon 180] [--strategy bootstrap] \
 *     [--session-glob '*-live'] [--trades-file data/vps-trades-latest.jsonl] \
 *     [--out docs/audits/realized-replay-ratio-2026-04-07.md]
 */

import fs from 'fs';
import path from 'path';
import { RealtimeReplayStore } from '../../src/realtime/replayStore';
import type { RealtimeSignalRecord } from '../../src/reporting/realtimeMeasurement';
import { FAKE_FILL_SLIPPAGE_BPS_THRESHOLD } from '../../src/utils/constants';

interface TradeRow {
  id: string;
  pair_address: string;
  strategy: string;
  status: string;
  tx_signature: string | null;
  entry_price: number;
  exit_price: number | null;
  pnl: number | null;
  closed_at: Date | null;
  created_at: Date;
  exit_reason: string | null;
  decision_price: number | null;
  entry_slippage_bps: number | null;
  exit_slippage_bps: number | null;
  round_trip_cost_pct: number | null;
  // 2026-04-07: parent_trade_id — TP1 partial child row를 parent에 합산하기 위한 키
  parent_trade_id: string | null;
  // 2026-04-07 (F1-deep follow-up): saturated slippage / fake-fill 격리용. trade-report와
  // edgeInputSanitizer 두 곳이 이미 동일 임계로 outlier를 격리하고 있는데 이 스크립트만
  // 누락되어 있어 ratio가 1건의 fake-fill로 왜곡될 수 있었다.
  exit_anomaly_reason: string | null;
}

// 2026-04-07: |predicted_adj| 가 이 임계보다 작으면 ratio(realized/predicted)는 noise 중 noise다.
// 매우 작은 분모는 수치 불안정성을 초래하므로 floor를 두고 NaN 처리한다.
const MIN_PREDICTED_MAGNITUDE_PCT = 0.05;

interface MatchedTrade {
  tradeId: string;
  txSignature: string | null;
  sessionId: string;
  pairAddress: string;
  strategy: string;
  entryPrice: number;
  exitPrice: number;
  realizedPct: number;          // (exit - entry) / entry
  predictedAdjPct: number;      // signal.horizons[horizonSec].adjustedReturnPct
  predictedRawPct: number;      // signal.horizons[horizonSec].returnPct (no cost)
  ratio: number;                 // realizedPct / predictedAdjPct
  exitReason: string | null;
  decisionGapPct: number | null; // (entry - decision) / decision (entry slippage)
  matchSource: 'trade_id' | 'tx_signature';
}

type ExecMode = 'paper' | 'live' | 'all';

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string) => {
    const index = args.indexOf(flag);
    return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
  };
  const modeRaw = get('--mode', 'live');
  if (modeRaw !== 'paper' && modeRaw !== 'live' && modeRaw !== 'all') {
    throw new Error(`--mode must be 'paper' | 'live' | 'all', got: ${modeRaw}`);
  }
  return {
    horizonSec: Number(get('--horizon', '180')),
    strategyFilter: get('--strategy', ''),
    sessionGlob: get('--session-glob', ''),
    outPath: get('--out', 'docs/audits/realized-replay-ratio-2026-04-07.md'),
    tradesFile: get('--trades-file', 'data/vps-trades-latest.jsonl'),
    mode: modeRaw as ExecMode,
    dryRun: args.includes('--dry-run'),
  };
}

function listSessionDirs(sessionGlob: string): string[] {
  const root = path.resolve(__dirname, '../../data/realtime/sessions');
  if (!fs.existsSync(root)) return [];
  const all = fs.readdirSync(root).filter((name) => name.endsWith('-live') || name.startsWith('legacy-'));
  if (!sessionGlob) return all.map((name) => path.join(root, name));
  // Why: 단순 substring 매칭. 대규모 glob 필요 시 별도 lib 도입.
  return all.filter((name) => name.includes(sessionGlob)).map((name) => path.join(root, name));
}

async function loadSignalsFromSessions(sessionDirs: string[]): Promise<Array<{ sessionId: string; record: RealtimeSignalRecord }>> {
  const out: Array<{ sessionId: string; record: RealtimeSignalRecord }> = [];
  for (const dir of sessionDirs) {
    const sessionId = path.basename(dir);
    const store = new RealtimeReplayStore(dir);
    try {
      const records = await store.loadSignals();
      for (const record of records) out.push({ sessionId, record });
    } catch (error) {
      console.warn(`skip ${sessionId}: ${(error as Error).message}`);
    }
  }
  return out;
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

function loadTradesFromJsonl(
  filePath: string,
  strategyFilter: string,
  mode: ExecMode
): TradeRow[] {
  // Why: VPS sync 스크립트가 row_to_json으로 떨군 jsonl 한 줄 = 한 trade.
  // 스키마 변화 시 새 키만 들어옴 → 코드 수정 불필요. 로컬 PG 의존성 제거.
  if (!fs.existsSync(filePath)) {
    throw new Error(`trades file not found: ${filePath} (run \`bash scripts/sync-vps-data.sh\` first)`);
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const rows: TradeRow[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.status !== 'CLOSED') continue;
    const txSig = (obj.tx_signature as string | null) ?? null;
    // mode 필터: live = 실제 체결 wallet 트레이드, paper = paper sim, all = 둘 다
    if (mode === 'paper' && txSig !== 'PAPER_TRADE') continue;
    if (mode === 'live' && (txSig === null || txSig === 'PAPER_TRADE')) continue;
    if (strategyFilter && !String(obj.strategy ?? '').includes(strategyFilter)) continue;
    rows.push({
      id: String(obj.id),
      pair_address: String(obj.pair_address),
      strategy: String(obj.strategy),
      status: String(obj.status),
      tx_signature: txSig,
      entry_price: Number(obj.entry_price),
      exit_price: toNumberOrNull(obj.exit_price),
      pnl: toNumberOrNull(obj.pnl),
      closed_at: toDateOrNull(obj.closed_at),
      created_at: toDateOrNull(obj.created_at) ?? new Date(0),
      exit_reason: (obj.exit_reason as string | null) ?? null,
      decision_price: toNumberOrNull(obj.decision_price),
      entry_slippage_bps: toNumberOrNull(obj.entry_slippage_bps),
      exit_slippage_bps: toNumberOrNull(obj.exit_slippage_bps),
      round_trip_cost_pct: toNumberOrNull(obj.round_trip_cost_pct),
      parent_trade_id: (obj.parent_trade_id as string | null) ?? null,
      exit_anomaly_reason: (obj.exit_anomaly_reason as string | null) ?? null,
    });
  }
  rows.sort((left, right) => {
    const leftTime = left.closed_at?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const rightTime = right.closed_at?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return leftTime - rightTime;
  });
  return rows;
}

/**
 * 2026-04-07 (F1-deep follow-up): saturated slippage / fake-fill row가 realized vs replay
 * ratio를 1건 outlier로 왜곡하지 않도록 parent group 단위로 격리한다.
 *
 * Why parent group 단위:
 * - TP1 partial child + remainder는 같은 entry이므로 child 1건이 anomalous면 parent의
 *   합산 pnl이 통째로 오염된다 (exitPrice/qty 산식이 fake-fill 분기로 들어감).
 * - 따라서 row 단위 drop이 아니라 group 단위 drop이 안전하다.
 *
 * Anomaly 기준 (edgeInputSanitizer.ts:117 와 정확히 동일 — drift 방지):
 * - exit_anomaly_reason 컬럼이 set (mergeAnomalyReasons로 fake_fill_*, slippage_saturated,
 *   exit_ratio, decision_fill_gap 5종 마커가 들어옴)
 * - exit_slippage_bps >= FAKE_FILL_SLIPPAGE_BPS_THRESHOLD (=9000bps, 90%)
 */
function isAnomalousRow(t: TradeRow): boolean {
  if (t.exit_anomaly_reason && t.exit_anomaly_reason.length > 0) return true;
  if (t.exit_slippage_bps != null && t.exit_slippage_bps >= FAKE_FILL_SLIPPAGE_BPS_THRESHOLD) {
    return true;
  }
  return false;
}

interface AnomalyFilterResult {
  clean: TradeRow[];
  excludedGroupCount: number;
  excludedRowCount: number;
}

function filterAnomalousTradeGroups(trades: TradeRow[]): AnomalyFilterResult {
  const byParent = new Map<string, TradeRow[]>();
  for (const t of trades) {
    const key = t.parent_trade_id ?? t.id;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(t);
  }
  const clean: TradeRow[] = [];
  let excludedGroupCount = 0;
  let excludedRowCount = 0;
  for (const group of byParent.values()) {
    if (group.some(isAnomalousRow)) {
      excludedGroupCount += 1;
      excludedRowCount += group.length;
      continue;
    }
    clean.push(...group);
  }
  return { clean, excludedGroupCount, excludedRowCount };
}

/**
 * TP1 partial child + remainder row를 논리적 entry 하나로 합산.
 * Why: matched 14건이 실은 parent 4-7건의 중복이므로, child row가 별개 tx_signature로
 * 매칭되는 경로를 제거해야 한다. parent row의 entry/decision을 기준으로 삼고,
 * pnl은 전체 합산, exit_price는 최종 청산 row의 값을 사용한다.
 */
function aggregateByParent(trades: TradeRow[]): TradeRow[] {
  const byParent = new Map<string, TradeRow[]>();
  for (const t of trades) {
    const key = t.parent_trade_id ?? t.id;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(t);
  }
  return Array.from(byParent.values()).map((group) => {
    if (group.length === 1) return group[0];
    const parent = group.find((t) => t.parent_trade_id === null) ?? group[0];
    const sortedByClose = [...group].sort((a, b) =>
      (a.closed_at?.getTime() ?? 0) - (b.closed_at?.getTime() ?? 0)
    );
    const lastExit = sortedByClose[sortedByClose.length - 1];
    const totalPnl = group.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
    return {
      ...parent,
      exit_price: lastExit.exit_price,
      pnl: totalPnl,
      closed_at: lastExit.closed_at ?? parent.closed_at,
      tx_signature: parent.tx_signature ?? lastExit.tx_signature,
    };
  });
}

function joinTradesToSignals(
  trades: TradeRow[],
  signals: Array<{ sessionId: string; record: RealtimeSignalRecord }>,
  horizonSec: number
): MatchedTrade[] {
  // Why: live 환경에서는 trades.id와 processing.tradeId namespace가 다를 수 있어
  // tx_signature를 2차 join key로 허용한다. tx_signature도 없으면 unmatched로 남긴다.
  // 2026-04-07: child row가 별도 tx_signature로 중복 매칭되지 않도록 먼저 parent 기준 합산.
  const aggregated = aggregateByParent(trades);

  const signalByTradeId = new Map<string, { sessionId: string; record: RealtimeSignalRecord }>();
  const signalByTxSignature = new Map<string, { sessionId: string; record: RealtimeSignalRecord }>();
  for (const item of signals) {
    const tradeId = item.record.processing?.tradeId;
    if (tradeId) signalByTradeId.set(tradeId, item);
    const txSignature = item.record.processing?.txSignature;
    if (txSignature) signalByTxSignature.set(txSignature, item);
  }

  const matched: MatchedTrade[] = [];
  for (const trade of aggregated) {
    if (trade.exit_price === null) continue;
    const tradeIdMatch = signalByTradeId.get(trade.id);
    const txSignatureMatch = trade.tx_signature ? signalByTxSignature.get(trade.tx_signature) : undefined;
    const signalMatch = tradeIdMatch ?? txSignatureMatch;
    if (!signalMatch) continue;
    const matchSource = tradeIdMatch ? 'trade_id' : 'tx_signature';
    const horizon = signalMatch.record.horizons.find((item) => item.horizonSec === horizonSec);
    if (!horizon) continue;

    const realizedPct = ((trade.exit_price - trade.entry_price) / trade.entry_price) * 100;
    const predictedAdjPct = horizon.adjustedReturnPct;
    const predictedRawPct = horizon.returnPct;
    // 2026-04-07: 분모가 0 근방(|adj| < 0.05%)이면 ratio는 의미 없음 — NaN 처리해서 통계에서 제외
    const ratio = Math.abs(predictedAdjPct) >= MIN_PREDICTED_MAGNITUDE_PCT
      ? realizedPct / predictedAdjPct
      : NaN;
    const decisionGapPct =
      trade.decision_price && trade.decision_price > 0
        ? ((trade.entry_price - trade.decision_price) / trade.decision_price) * 100
        : null;

    matched.push({
      tradeId: trade.id,
      txSignature: trade.tx_signature,
      sessionId: signalMatch.sessionId,
      pairAddress: trade.pair_address,
      strategy: trade.strategy,
      entryPrice: trade.entry_price,
      exitPrice: trade.exit_price,
      realizedPct,
      predictedAdjPct,
      predictedRawPct,
      ratio,
      exitReason: trade.exit_reason,
      decisionGapPct,
      matchSource,
    });
  }
  return matched;
}

function fmt(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

interface AggregateResult {
  n: number;
  sumRealized: number;
  sumPredictedAdj: number;
  avgRealized: number;
  avgPredictedAdj: number;
  avgPredictedRaw: number;
  avgRatio: number;
  medianRatio: number;
  ratioRealizedTotal: number;
  winRate: number;
  finiteRatioCount: number;
  excludedByMagnitudeFloor: number;
}

function aggregate(matched: MatchedTrade[]): AggregateResult {
  if (matched.length === 0) {
    return {
      n: 0,
      sumRealized: 0,
      sumPredictedAdj: 0,
      avgRealized: 0,
      avgPredictedAdj: 0,
      avgPredictedRaw: 0,
      avgRatio: NaN,
      medianRatio: NaN,
      ratioRealizedTotal: NaN,
      winRate: 0,
      finiteRatioCount: 0,
      excludedByMagnitudeFloor: 0,
    };
  }
  const n = matched.length;
  const sumRealized = matched.reduce((sum, item) => sum + item.realizedPct, 0);
  const sumPredAdj = matched.reduce((sum, item) => sum + item.predictedAdjPct, 0);
  const sumPredRaw = matched.reduce((sum, item) => sum + item.predictedRawPct, 0);
  const finiteRatios = matched.map((item) => item.ratio).filter((ratio) => Number.isFinite(ratio));
  const excludedByMagnitudeFloor = n - finiteRatios.length;
  const avgRatio = finiteRatios.length > 0
    ? finiteRatios.reduce((sum, ratio) => sum + ratio, 0) / finiteRatios.length
    : NaN;
  const sortedRatios = [...finiteRatios].sort((left, right) => left - right);
  const medianRatio = sortedRatios.length > 0 ? sortedRatios[Math.floor(sortedRatios.length / 2)] : NaN;
  // 2026-04-07: sum-based ratio 도 per-trade 와 동일한 magnitude floor 적용.
  // |Σ predicted_adj| 가 floor 미만이면 denominator 가 noise → NaN 으로 의미 없음 신호.
  const ratioRealizedTotal = Math.abs(sumPredAdj) >= MIN_PREDICTED_MAGNITUDE_PCT
    ? sumRealized / sumPredAdj
    : NaN;
  const winRate = matched.filter((item) => item.realizedPct > 0).length / n;
  return {
    n,
    sumRealized,
    sumPredictedAdj: sumPredAdj,
    avgRealized: sumRealized / n,
    avgPredictedAdj: sumPredAdj / n,
    avgPredictedRaw: sumPredRaw / n,
    avgRatio,
    medianRatio,
    ratioRealizedTotal,
    winRate,
    finiteRatioCount: finiteRatios.length,
    excludedByMagnitudeFloor,
  };
}

async function main() {
  const args = parseArgs();
  console.log(
    `Mode: ${args.mode} | Horizon: ${args.horizonSec}s | Strategy filter: ${args.strategyFilter || '(all)'} | Session glob: ${args.sessionGlob || '(all)'}`
  );
  console.log(`Trades file: ${args.tradesFile}`);

  const sessionDirs = listSessionDirs(args.sessionGlob);
  console.log(`Sessions: ${sessionDirs.length}`);
  const signalEntries = await loadSignalsFromSessions(sessionDirs);
  console.log(`Loaded ${signalEntries.length} signal records`);

  const tradesPath = path.isAbsolute(args.tradesFile)
    ? args.tradesFile
    : path.resolve(__dirname, '../..', args.tradesFile);
  const rawTrades = loadTradesFromJsonl(tradesPath, args.strategyFilter, args.mode);
  console.log(`Loaded ${rawTrades.length} closed trades (mode=${args.mode})`);

  // 2026-04-07 (F1-deep follow-up): saturated slippage / fake-fill row를 parent group 단위로 격리.
  const anomalyFilter = filterAnomalousTradeGroups(rawTrades);
  if (anomalyFilter.excludedGroupCount > 0) {
    console.log(
      `Anomaly filter (>=${FAKE_FILL_SLIPPAGE_BPS_THRESHOLD}bps slippage or exit_anomaly_reason set): ` +
        `${anomalyFilter.excludedGroupCount} parent groups (${anomalyFilter.excludedRowCount} rows) excluded`
    );
  }
  const trades = anomalyFilter.clean;

  const matched = joinTradesToSignals(trades, signalEntries, args.horizonSec);
  console.log(`Matched ${matched.length} parent-dedup trades to signals (clean rows: ${trades.length}, raw: ${rawTrades.length})`);
  const tradeIdMatches = matched.filter((item) => item.matchSource === 'trade_id').length;
  const txSignatureMatches = matched.filter((item) => item.matchSource === 'tx_signature').length;
  console.log(`Match source: trade_id=${tradeIdMatches}, tx_signature=${txSignatureMatches}`);
  const floorExcluded = matched.filter((item) => !Number.isFinite(item.ratio)).length;
  if (floorExcluded > 0) {
    console.log(`Magnitude floor (|predicted_adj| < ${MIN_PREDICTED_MAGNITUDE_PCT}%): ${floorExcluded}/${matched.length} excluded from ratio stats`);
  }

  const overall = aggregate(matched);
  const bySessionMap = new Map<string, MatchedTrade[]>();
  for (const item of matched) {
    if (!bySessionMap.has(item.sessionId)) bySessionMap.set(item.sessionId, []);
    bySessionMap.get(item.sessionId)!.push(item);
  }

  const lines: string[] = [];
  lines.push(`# Realized vs Replay Edge Ratio — 2026-04-07`);
  lines.push('');
  lines.push(`> Mode: \`${args.mode}\` | Horizon: ${args.horizonSec}s | Strategy filter: \`${args.strategyFilter || 'all'}\``);
  lines.push(`> Trades source: \`${args.tradesFile}\``);
  lines.push(`> Sessions scanned: ${sessionDirs.length} | Signal records: ${signalEntries.length}`);
  lines.push(
    `> Closed trades: raw=${rawTrades.length}, clean=${trades.length} ` +
      `(anomaly filter excluded ${anomalyFilter.excludedGroupCount} parent groups / ${anomalyFilter.excludedRowCount} rows)`
  );
  lines.push(`> Matched to signals: ${matched.length}`);
  lines.push(`> Match source: trade_id=${tradeIdMatches}, tx_signature=${txSignatureMatches}`);
  lines.push(
    `> Anomaly filter rule: \`exit_anomaly_reason\` set OR \`exit_slippage_bps >= ${FAKE_FILL_SLIPPAGE_BPS_THRESHOLD}\` ` +
      `(parent group 단위 drop — TP1 partial child가 anomalous면 parent 합산 pnl 전체 오염)`
  );
  lines.push('');
  lines.push('## What this measures');
  lines.push('');
  lines.push(`- **Realized %** = (exit_price − entry_price) / entry_price × 100 (실체결 fill price 기반)`);
  lines.push(`- **Predicted adj %** = signal.horizons[${args.horizonSec}s].adjustedReturnPct (replay 헤드라인과 동일 metric)`);
  lines.push(`- **Ratio** = realized / predicted_adj (1.0 = replay 그대로 실현, 0.0 = 완전 손실)`);
  lines.push(`- 이상치 수렴을 위해 \`ratioRealizedTotal\` = Σ realized / Σ predicted_adj 도 함께 보고`);
  lines.push('');

  lines.push('## Overall');
  lines.push('');
  if (overall.n === 0) {
    lines.push(
      `No matched trades. Verify (1) trades-file path is correct, (2) tx_signature filter for mode='${args.mode}', (3) signal jsonl 시기와 trades 시기가 겹치는지.`
    );
    lines.push('');
  } else {
    const ratioRealizedTotalStr = Number.isFinite(overall.ratioRealizedTotal)
      ? `**${fmt(overall.ratioRealizedTotal)}**`
      : `**N/A — predicted edge ≈ 0, ratio not meaningful** (|Σ predicted_adj|=${fmt(Math.abs(overall.sumPredictedAdj))}% < ${MIN_PREDICTED_MAGNITUDE_PCT}% floor)`;
    const meanRatioStr = overall.finiteRatioCount > 0
      ? `**${fmt(overall.avgRatio)}** (n=${overall.finiteRatioCount} finite, ${overall.excludedByMagnitudeFloor} excluded by |denom|<${MIN_PREDICTED_MAGNITUDE_PCT}% floor)`
      : `**N/A** (0 finite, ${overall.excludedByMagnitudeFloor} excluded by |denom|<${MIN_PREDICTED_MAGNITUDE_PCT}% floor)`;
    lines.push(`- Matched trades: **${overall.n}** (parent-dedup 적용)`);
    lines.push(`- Avg realized: **${fmt(overall.avgRealized)}%**`);
    lines.push(`- Avg predicted adj (replay): **${fmt(overall.avgPredictedAdj)}%**`);
    lines.push(`- Avg predicted raw (no cost): ${fmt(overall.avgPredictedRaw)}%`);
    lines.push(`- Mean of per-trade ratios: ${meanRatioStr}`);
    lines.push(`- Median per-trade ratio: ${fmt(overall.medianRatio)}`);
    lines.push(`- Sum-based ratio (Σ realized / Σ predicted_adj): ${ratioRealizedTotalStr}`);
    lines.push(`- Win rate: ${fmt(overall.winRate * 100, 1)}%`);
    if (overall.finiteRatioCount === 0) {
      lines.push('');
      lines.push(`> ⚠ **Verdict: 표본 부족 (predicted edge ≈ 0).** 모든 매칭 trade 의 |predicted_adj| 가 ${MIN_PREDICTED_MAGNITUDE_PCT}% floor 미만이므로 ratio 기반 판단이 불가능합니다. replay edge 가 충분한 magnitude 를 가질 때까지 P3 verdict 확정을 보류합니다.`);
    }
    lines.push('');
  }

  lines.push('## Per-session');
  lines.push('');
  if (bySessionMap.size === 0) {
    lines.push('(no session breakdown — no matched trades)');
  } else {
    lines.push('| Session | n | Avg Realized | Avg Predicted Adj | Sum Ratio | Avg Ratio |');
    lines.push('|---|---:|---:|---:|---:|---:|');
    for (const [sessionId, items] of [...bySessionMap.entries()].sort()) {
      const agg = aggregate(items);
      lines.push(`| ${sessionId} | ${agg.n} | ${fmt(agg.avgRealized)}% | ${fmt(agg.avgPredictedAdj)}% | ${fmt(agg.ratioRealizedTotal)} | ${fmt(agg.avgRatio)} |`);
    }
  }
  lines.push('');

  lines.push('## Per-trade detail');
  lines.push('');
  if (matched.length === 0) {
    lines.push('(none)');
  } else {
    lines.push('| Trade ID (8) | Match | Session | Pair (8) | Realized | Predicted Adj | Ratio | Decision Gap | Exit Reason |');
    lines.push('|---|---|---|---|---:|---:|---:|---:|---|');
    for (const item of matched) {
      lines.push(
        `| ${item.tradeId.slice(0, 8)} | ${item.matchSource} | ${item.sessionId.slice(0, 16)} | ${item.pairAddress.slice(0, 8)} | ${fmt(item.realizedPct)}% | ${fmt(item.predictedAdjPct)}% | ${fmt(item.ratio)} | ${fmt(item.decisionGapPct)}% | ${item.exitReason ?? '—'} |`
      );
    }
  }
  lines.push('');

  lines.push('## Interpretation guide');
  lines.push('');
  lines.push('| Sum Ratio | Verdict | Mission Implication |');
  lines.push('|---:|---|---|');
  lines.push('| ≥ 0.8 | execution layer가 replay edge를 거의 보존 | replay 예측을 mission math에 사실상 그대로 사용 가능 |');
  lines.push('| 0.5 – 0.8 | 30-50% 손실 (slippage / timing) | edge 낙폭 반영 후 mission horizon 1.5-2x 연장 |');
  lines.push('| 0.2 – 0.5 | 절반 이상 손실, slippage 또는 SL 오작동 의심 | 실행 layer 개선 없이는 mission 도달 가능성 낮음 |');
  lines.push('| < 0.2 | edge 사실상 전무 | 전략 또는 execution path 재검토 필수 |');
  lines.push('| < 0 | 음수 — replay 양수가 실현 음수로 뒤집힘 | sample contamination 또는 chronic adverse selection |');
  lines.push('');
  lines.push('### Notes');
  lines.push('- Match rate는 (matched / total trades). 1차는 tradeId, 2차는 tx_signature fallback으로 매칭한다.');
  lines.push('- Decision gap = paper에서 발생한 entry slippage (decision_price → fill price).');
  lines.push('- 표본 < 20이면 ratio는 reference만. 20 trades 누적 후 P3 verdict 확정.');

  const outAbs = path.resolve(args.outPath);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, lines.join('\n'));
  console.log(`Saved: ${outAbs}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
