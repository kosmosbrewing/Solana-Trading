#!/usr/bin/env ts-node
/**
 * Signal Cohort Audit
 *
 * Why: 2026-04-07 — `edge-cohort-quality-2026-04-07.md` Axis 3 첫 칸을
 * read-only로 부분 충족하기 위한 스크립트. 운영 가설("저시총 고거래량 surge에서
 * edge가 나오는가")을 검증하려면 signal/trade를 marketCap × volumeMcap × status
 * cohort로 분리해야 하지만, 현재 trades 테이블에는 marketCap 컬럼이 없다.
 * 대신 Feature 2(2026-04-05 commit 076e1f4) 이후 모든 세션의 signal-intents.jsonl이
 * `context.marketCapUsd` / `context.volumeMcapRatio`를 함께 persist하므로,
 * 이 파일들을 입력으로 cohort cross-tab을 산출한다.
 *
 * Inputs (read-only, DB 의존성 0):
 *   - data/realtime/sessions/<session>/signal-intents.jsonl (모든 세션 자동 수집)
 *
 * Output: cohort cross-tab 마크다운 + low-cap surge pass-rate 한 줄 verdict
 *
 * Usage:
 *   npx ts-node scripts/analysis/signal-cohort-audit.ts \
 *     [--sessions-dir data/realtime/sessions] \
 *     [--session-glob '*-live'] \
 *     [--out docs/audits/signal-cohort-2026-04-07.md]
 *
 * Important caveat:
 *   이 스크립트가 보는 대상은 **trades 테이블이 아니라 signal 단위**다.
 *   따라서 "cohort별 R-multiple"은 산출하지 못한다 (그건 axis_3 acceptance 두 번째 칸).
 *   여기서는 1) cohort 분포 가시화 2) status × cohort 분리 (가드 차단 패턴 노출)에 집중한다.
 */

import fs from 'fs';
import path from 'path';

interface SignalIntentRecord {
  id?: string;
  strategy?: string;
  pairAddress?: string;
  tokenSymbol?: string;
  signalTimestamp?: string;
  processing?: {
    status?: string;
    filterReason?: string;
    tradeId?: string;
  };
  context?: {
    marketCapUsd?: number;
    volumeMcapRatio?: number;
    poolTvl?: number;
  };
}

interface CohortRow {
  sessionId: string;
  symbol: string;
  pair: string;
  status: string;
  filterReason?: string;
  tradeId?: string;
  marketCapUsd: number | null;
  volumeMcapRatio: number | null;
}

interface Args {
  sessionsDir: string;
  sessionGlob: string;
  outPath: string | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    sessionsDir: 'data/realtime/sessions',
    sessionGlob: '*-live',
    outPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--sessions-dir' && value) { args.sessionsDir = value; i++; }
    else if (flag === '--session-glob' && value) { args.sessionGlob = value; i++; }
    else if (flag === '--out' && value) { args.outPath = value; i++; }
  }
  return args;
}

function matchGlob(name: string, pattern: string): boolean {
  // 단순 glob: '*' 만 지원. 정규식으로 변환.
  const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return re.test(name);
}

function loadSignalIntents(args: Args): CohortRow[] {
  const baseDir = path.resolve(process.cwd(), args.sessionsDir);
  if (!fs.existsSync(baseDir)) {
    throw new Error(`sessions dir not found: ${baseDir}`);
  }
  const sessionDirs = fs.readdirSync(baseDir).filter((name) => {
    if (!matchGlob(name, args.sessionGlob)) return false;
    const stat = fs.statSync(path.join(baseDir, name));
    return stat.isDirectory();
  });
  const rows: CohortRow[] = [];
  for (const sessionDir of sessionDirs) {
    const filePath = path.join(baseDir, sessionDir, 'signal-intents.jsonl');
    if (!fs.existsSync(filePath)) continue;
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as SignalIntentRecord;
        rows.push({
          sessionId: sessionDir,
          symbol: rec.tokenSymbol ?? '?',
          pair: rec.pairAddress ?? '?',
          status: rec.processing?.status ?? 'unknown',
          filterReason: rec.processing?.filterReason,
          tradeId: rec.processing?.tradeId,
          marketCapUsd: rec.context?.marketCapUsd ?? null,
          volumeMcapRatio: rec.context?.volumeMcapRatio ?? null,
        });
      } catch (e) {
        process.stderr.write(`skip malformed line in ${sessionDir}: ${(e as Error).message}\n`);
      }
    }
  }
  return rows;
}

// 2026-04-07: marketCap band 정의 — 밈코인 운영 맥락에서의 의미 있는 분할.
// <100K = 신생/마이크로캡 (가드 차단 위험구간)
// 100K-1M = 미세캡
// 1M-10M = 소형
// 10M-100M = 중형 (PIPPIN 등 대형 밈 continuation 구간)
// >100M = 대형 (확립 토큰)
function marketCapBand(mc: number | null): string {
  if (mc == null) return 'unknown';
  if (mc < 100_000) return '<$100K';
  if (mc < 1_000_000) return '$100K-1M';
  if (mc < 10_000_000) return '$1M-10M';
  if (mc < 100_000_000) return '$10M-100M';
  return '>$100M';
}

// volumeMcap_ratio band — 24h volume / marketCap.
// >1.0 = 일거래대금이 시총을 초과 (저시총 surge 후보)
// >3.0 = 극단적 surge (사용자 가설 핵심 구간)
function volumeMcapBand(ratio: number | null): string {
  if (ratio == null) return 'unknown';
  if (ratio < 0.1) return '<0.1';
  if (ratio < 0.5) return '0.1-0.5';
  if (ratio < 1.0) return '0.5-1.0';
  if (ratio < 3.0) return '1.0-3.0';
  return '>3.0';
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return '—';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function buildReport(rows: CohortRow[]): string {
  const lines: string[] = [];
  lines.push('# Signal Cohort Audit');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Source: signal-intents.jsonl across ${new Set(rows.map((r) => r.sessionId)).size} sessions`);
  lines.push(`Total rows: ${rows.length}, with marketCapUsd: ${rows.filter((r) => r.marketCapUsd != null).length}`);
  lines.push('');

  // Status 분포 (sanity)
  const statusCounts = new Map<string, number>();
  for (const r of rows) {
    statusCounts.set(r.status, (statusCounts.get(r.status) ?? 0) + 1);
  }
  lines.push('## Status Distribution');
  lines.push('');
  lines.push('| Status | Count |');
  lines.push('|---|---:|');
  for (const [status, count] of [...statusCounts.entries()].sort()) {
    lines.push(`| ${status} | ${count} |`);
  }
  lines.push('');

  // marketCap × status cross-tab
  const mcBands = ['<$100K', '$100K-1M', '$1M-10M', '$10M-100M', '>$100M', 'unknown'];
  const statuses = [...statusCounts.keys()].sort();
  lines.push('## marketCap × status (signal counts)');
  lines.push('');
  lines.push(`| marketCap band | ${statuses.join(' | ')} | total | exec rate |`);
  lines.push(`|---|${statuses.map(() => '---:').join('|')}|---:|---:|`);
  for (const band of mcBands) {
    const bandRows = rows.filter((r) => marketCapBand(r.marketCapUsd) === band);
    if (bandRows.length === 0) continue;
    const cells: string[] = [];
    let executed = 0;
    for (const status of statuses) {
      const count = bandRows.filter((r) => r.status === status).length;
      cells.push(String(count));
      if (status === 'executed_live') executed = count;
    }
    lines.push(`| ${band} | ${cells.join(' | ')} | ${bandRows.length} | ${pct(executed, bandRows.length)} |`);
  }
  lines.push('');

  // volumeMcap × status cross-tab
  const ratioBands = ['<0.1', '0.1-0.5', '0.5-1.0', '1.0-3.0', '>3.0', 'unknown'];
  lines.push('## volumeMcap_ratio × status (signal counts)');
  lines.push('');
  lines.push(`| volumeMcap_ratio | ${statuses.join(' | ')} | total | exec rate |`);
  lines.push(`|---|${statuses.map(() => '---:').join('|')}|---:|---:|`);
  for (const band of ratioBands) {
    const bandRows = rows.filter((r) => volumeMcapBand(r.volumeMcapRatio) === band);
    if (bandRows.length === 0) continue;
    const cells: string[] = [];
    let executed = 0;
    for (const status of statuses) {
      const count = bandRows.filter((r) => r.status === status).length;
      cells.push(String(count));
      if (status === 'executed_live') executed = count;
    }
    lines.push(`| ${band} | ${cells.join(' | ')} | ${bandRows.length} | ${pct(executed, bandRows.length)} |`);
  }
  lines.push('');

  // 결정적 verdict — low-cap surge cohort의 pass rate
  // "사용자 가설 핵심 구간" = 저시총 (<$1M) AND 고volumeMcap_ratio (>1.0)
  const lowCapSurge = rows.filter((r) =>
    r.marketCapUsd != null && r.marketCapUsd < 1_000_000 &&
    r.volumeMcapRatio != null && r.volumeMcapRatio > 1.0
  );
  const lowCapSurgeExecuted = lowCapSurge.filter((r) => r.status === 'executed_live').length;
  const highCapContinuation = rows.filter((r) =>
    r.marketCapUsd != null && r.marketCapUsd >= 10_000_000 &&
    r.volumeMcapRatio != null && r.volumeMcapRatio < 0.5
  );
  const highCapExecuted = highCapContinuation.filter((r) => r.status === 'executed_live').length;
  lines.push('## Hypothesis Verdict');
  lines.push('');
  lines.push('| Cohort | Definition | Signals | Executed | Exec Rate |');
  lines.push('|---|---|---:|---:|---:|');
  lines.push(`| **low-cap surge** | mc<$1M AND ratio>1.0 | ${lowCapSurge.length} | ${lowCapSurgeExecuted} | ${pct(lowCapSurgeExecuted, lowCapSurge.length)} |`);
  lines.push(`| **high-cap continuation** | mc≥$10M AND ratio<0.5 | ${highCapContinuation.length} | ${highCapExecuted} | ${pct(highCapExecuted, highCapContinuation.length)} |`);
  lines.push('');

  if (lowCapSurge.length > 0) {
    lines.push('### low-cap surge per-signal detail');
    lines.push('');
    lines.push('| session | symbol | mc | ratio | status | filterReason |');
    lines.push('|---|---|---:|---:|---|---|');
    for (const r of lowCapSurge) {
      const mcStr = r.marketCapUsd != null ? `$${Math.round(r.marketCapUsd).toLocaleString()}` : '—';
      const ratioStr = r.volumeMcapRatio != null ? r.volumeMcapRatio.toFixed(2) : '—';
      const reason = r.filterReason ? r.filterReason.slice(0, 60) : '—';
      lines.push(`| ${r.sessionId.slice(0, 19)} | ${r.symbol.slice(0, 14)} | ${mcStr} | ${ratioStr} | ${r.status} | ${reason} |`);
    }
    lines.push('');
  }

  lines.push('## Interpretation Notes');
  lines.push('');
  lines.push('- 이 audit은 **signal 단위**다. 즉 cohort별 R-multiple은 산출하지 못한다 (axis_3 두 번째 acceptance).');
  lines.push('- 그러나 cohort별 **pass rate**(signal → executed_live 진입률)를 직접 보여주므로, 사용자 가설 (저시총 surge edge)이 데이터 부족 때문인지, 가드 차단 때문인지 1차 분리 가능.');
  lines.push('- low-cap surge cohort exec rate가 high-cap continuation 대비 현저히 낮으면 → universe 부족이 아니라 **가드 차단이 가설 검증을 봉인 중**이라는 정량 근거.');
  lines.push('- 다음 단계: low-cap surge cohort에서 차단된 signal의 `filterReason`을 보고, `assertEntryAlignmentSafe` 가드의 false positive rate를 별도 측정 (F1-deep audit과 연동).');
  return lines.join('\n');
}

function main(): void {
  const args = parseArgs();
  const rows = loadSignalIntents(args);
  if (rows.length === 0) {
    console.log(`No signal-intents.jsonl found under ${args.sessionsDir} matching ${args.sessionGlob}`);
    process.exit(0);
  }
  const report = buildReport(rows);
  console.log(report);
  if (args.outPath) {
    const outAbs = path.resolve(process.cwd(), args.outPath);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, report);
    console.log(`\nReport written to: ${outAbs}`);
  }
}

main();
