import { appendFile, mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { CostSummary, DailySummaryReport, RealtimeAdmissionSummary } from '../notifier/dailySummaryFormatter';
import {
  buildHeartbeatPerformanceSummary,
  // 2026-04-30 (사용자 권고): heartbeat trading + regime summary 제거 — hourlyDigest 와 중복.
  HEARTBEAT_WINDOW_HOURS,
} from '../reporting/heartbeatSummary';
import { buildSparseOpsSummaryMessage, loadSparseOpsSummary } from '../reporting/sparseOpsSummary';
import { RuntimeDiagnosticsSummary } from '../reporting/runtimeDiagnosticsTracker';
import { RealtimeAdmissionSnapshotEntry } from '../realtime';
import { EdgeTracker, sanitizeEdgeLikeTrades, summarizeTradesBySource, computeExplainedEntryRatio } from '../reporting';
import { config } from '../utils/config';
import { createModuleLogger } from '../utils/logger';
import { BotContext } from './types';
import { sendKolDailySummary } from './kolDailySummary';

const log = createModuleLogger('Reporting');

/** KST 전일 기준 짝수 시각(00, 02, ..., 22)에 heartbeat, 09시에 daily full report */
const HEARTBEAT_KST_HOURS = Array.from({ length: 12 }, (_, index) => index * 2);
const DAILY_KST_HOUR = 9;

/**
 * 2026-04-29: 매 시간 KST snapshot — 잔고 + 1h 증감 + close 카운트.
 * Why: paper close 가 silent (kolPaperNotifier 가 hourly digest + 5x anomaly 만) 하여 운영자가
 *   close 알림 누락 인지. hourly snapshot 으로 매 시간 paper/live close 누적 표시.
 *   2h heartbeat 와 daily 는 그대로 유지 (더 자세). hourly 는 짧은 quick check.
 */
const HOURLY_SNAPSHOT_KST_HOURS = Array.from({ length: 24 }, (_, i) => i);

export function getScheduledReportType(now: Date): 'daily' | 'heartbeat' | 'hourly' | null {
  // 2026-04-29 fix: minute===0 strict 검사 제거.
  // 이전 로직: `setInterval(60_000) + minute === 0` 패턴은 event loop lag / 시작 시각 misalign
  //   시 매 시간 firing 을 통째로 skip 가능 (e.g., 시작 12:34:56 → fire 시각 HH:00:56 일 때 OK,
  //   누적 drift 5초만 발생해도 HH:01:01 으로 밀려 minute===0 false → 그 시간 skip).
  // 신규: 호출자가 hour boundary 1회 fire 보장 (lastFiredHour 추적). minute 조건 제거.
  const kstHour = (now.getUTCHours() + 9) % 24;

  // 우선순위: daily > heartbeat > hourly (같은 시각이면 더 자세한 보고만)
  if (kstHour === DAILY_KST_HOUR) {
    return 'daily';
  }

  if (HEARTBEAT_KST_HOURS.includes(kstHour)) {
    return 'heartbeat';
  }

  if (HOURLY_SNAPSHOT_KST_HOURS.includes(kstHour)) {
    return 'hourly';
  }

  return null;
}

// 2026-04-29 fix: UTC hour boundary 기반 fire-once tracking.
// scheduler 가 매 30s 깨어나서 현재 UTC hour 이 lastFiredHour 와 다른지 확인.
// 다르면 1회 fire 후 lastFiredHour 갱신 → event loop drift / 시작 misalign 무관 보장.
let lastFiredUtcHour = -1;

export function scheduleDailySummary(ctx: BotContext): ReturnType<typeof setInterval> {
  // 2026-04-27: handle 반환하여 setupShutdown 에서 clearInterval. 이전엔 leak.
  // 2026-04-29 fix: 30s polling + lastFiredUtcHour 기반 fire-once-per-hour 보장.
  log.info('[Reporting] scheduler started — 30s poll, fire-once-per-UTC-hour, KST-aware');

  // 2026-04-29 (restart-resilient): disk 에서 hourly buffer rehydrate.
  // lastFlushAtMs 이후 entries 만 → 다음 heartbeat 시 봇 재기동 무관 정확한 batch 구성.
  void loadHourlyLinesSinceFlush().then((lines) => {
    if (lines.length > 0) {
      hourlyLineBuffer.push(...lines);
      log.info(`[Reporting] rehydrated ${lines.length} hourly snapshot(s) from disk (since last flush)`);
    }
  }).catch((err) => {
    log.warn(`[Reporting] hourly buffer rehydrate failed: ${err}`);
  });

  // 2026-04-29: 기동 직후 startup snapshot 1회 발사 — 운영자가 봇 정상 작동 + 현재 상태 확인.
  // 다음 정규 batch (heartbeat / daily) 까지 기다리지 않고 즉시 Telegram 으로 baseline 노출.
  // hourlyBaseline 도 동시에 set → 다음 hour 의 delta 계산 정확히.
  void sendStartupSnapshot(ctx).catch((err) => {
    log.warn(`[Reporting] startup snapshot failed: ${err}`);
  });

  return setInterval(async () => {
    const now = new Date();
    const currentUtcHour = Math.floor(now.getTime() / 3_600_000);
    if (currentUtcHour === lastFiredUtcHour) return;  // 이미 이 hour 발사 — skip

    const reportType = getScheduledReportType(now);
    if (!reportType) return;  // KST 정의된 hour 가 아니면 skip (방어 — 실제론 매 시간 1개 type)

    // 발사 확정 — drift 보호 위해 mark 우선 (await 도중 다음 30s tick 진입 차단)
    lastFiredUtcHour = currentUtcHour;
    const kstHour = (now.getUTCHours() + 9) % 24;
    log.info(`[Reporting] firing ${reportType} (UTC ${now.toISOString()} / KST ${kstHour}:00)`);

    if (reportType === 'daily') {
      try {
        await sendDailySummaryReport(ctx);
      } catch (error) {
        log.error(`Daily summary failed: ${error}`);
      }
    } else if (reportType === 'heartbeat') {
      try {
        await sendHeartbeatReport(ctx);
      } catch (error) {
        log.error(`Heartbeat report failed: ${error}`);
      }
    } else if (reportType === 'hourly') {
      // 2026-04-29 B안: hourly Telegram 발사 안 함. buffer 에만 capture (heartbeat 시 일괄 flush).
      await bufferHourlySnapshot(ctx);
    }
  }, 30_000);
}

// ─── Hourly Snapshot (2026-04-29) ───
// 매 KST 시간 정각 — 잔고 + 1h 증감 + close 카운트 + 5x winner 누적.
// state: 직전 1h baseline 저장 (in-memory, 봇 재시작 시 reset 됨 — 첫 1h 는 증감 표시 없음).

interface HourlyBaseline {
  balanceSol: number;
  capturedAtMs: number;
}
let hourlyBaseline: HourlyBaseline | null = null;

function formatKstHour(now: Date): string {
  const kstHour = (now.getUTCHours() + 9) % 24;
  return `${kstHour.toString().padStart(2, '0')}:00`;
}

// 2026-04-29 (B안): hourly 개별 Telegram 발사 → 2시간 batch 로 통합.
// 매 KST hour 정각 1회 capture (in-memory line buffer) + heartbeat / daily 시점에 일괄 flush.
// 한 줄 요약 형식: `- HH:00 · X.XXXX SOL (±delta) · close N건 (WL) net ±M SOL [· 🎉 5x+]`
//
// 2026-04-29 (restart-resilient): disk persist 추가.
//   - 매 hourly capture → `data/realtime/hourly-snapshots.jsonl` 에 append
//   - lastFlushAtMs 는 `data/realtime/hourly-flush-state.json` 에 기록
//   - scheduler startup 시 lastFlushAtMs 이후의 entries 만 in-memory rehydrate
//   - heartbeat / daily flush 시 lastFlushAtMs 갱신 → 다음 batch 는 새 window 만
//   → 봇 재기동 시점 무관 24h 전체 (또는 last-flush 기준 window) 정확 출력.
export interface HourlyLine {
  kstHour: number;
  capturedAtMs: number;  // restart-resilient persistence + cross-day filter
  text: string;
  balanceSol?: number;       // 2026-05-01: compact digest 용 structured balance.
  balanceDeltaSol?: number;  // 직전 capture 대비 변화. legacy row 는 text parse fallback.
  liveClosed: number;
  liveWinners: number;
  liveLosers: number;
  liveCumPnl: number;
  fivexWinners: number;       // 후방호환 — capture + killed 합산 (총 5x peak 도달)
  fivexCaptured?: number;     // 2026-04-30: net 도 5x 인 실제 winner
  fivexKilled?: number;       // 2026-04-30: mfe 5x 도달했지만 net < 5x (winner-kill)
}
const hourlyLineBuffer: HourlyLine[] = [];

const HOURLY_SNAPSHOT_FILE = 'hourly-snapshots.jsonl';
const HOURLY_FLUSH_STATE_FILE = 'hourly-flush-state.json';
const HOURLY_SNAPSHOT_RETENTION_MS = 72 * 60 * 60 * 1000;  // 72h — daily 24h 의 안전 여유

async function persistHourlyLine(line: HourlyLine): Promise<void> {
  try {
    const dir = config.realtimeDataDir;
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, HOURLY_SNAPSHOT_FILE), JSON.stringify(line) + '\n', 'utf8');
  } catch (err) {
    log.warn(`[Reporting] hourly snapshot persist failed: ${err}`);
  }
}

/**
 * 2026-04-30 (사용자 권고): heartbeat / daily digest 를 **KST 00:00 부터 현재까지** 누적 표시.
 * 이전: lastFlushAtMs 기반 batch window (2-3h 만 보임) → 사용자가 "전체 시간 보고 싶다" 요청.
 * 수정: KST 자정 시각 (UTC 로 환산) 이후 모든 hourly snapshot 을 disk 에서 load.
 * 안전망: 24h hard window 유지 — daily 미발사 incident 시 cross-day 누적 방지.
 */
async function loadHourlyLinesSinceKstMidnight(): Promise<HourlyLine[]> {
  try {
    const dir = config.realtimeDataDir;
    const now = new Date();
    // KST 자정 = UTC 의 (어제 15:00) 또는 (오늘 15:00)
    const utcHourNow = now.getUTCHours();
    const kstMidnightUtcMs = (() => {
      const d = new Date(now);
      d.setUTCMinutes(0, 0, 0);
      // KST 자정 → UTC 15:00 of previous calendar day (KST 00:00 == UTC 15:00 전날)
      // utcHourNow >= 15 → 오늘 KST = 오늘 UTC, kstMidnight = today UTC 15:00 (어제 KST 23 → 오늘 KST 0 의 경계)
      // utcHourNow < 15 → 오늘 KST 의 자정은 어제 UTC 15:00
      if (utcHourNow >= 15) {
        d.setUTCHours(15, 0, 0, 0);
      } else {
        d.setUTCDate(d.getUTCDate() - 1);
        d.setUTCHours(15, 0, 0, 0);
      }
      return d.getTime();
    })();

    // 24h hard window — daily 미발사 incident 시 무한 누적 차단
    const windowStartMs = Math.max(kstMidnightUtcMs, Date.now() - HOURLY_SNAPSHOT_RETENTION_MS);

    let text: string;
    try {
      text = await readFile(path.join(dir, HOURLY_SNAPSHOT_FILE), 'utf8');
    } catch {
      return [];
    }
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    const result: HourlyLine[] = [];
    for (const raw of lines) {
      try {
        const entry = JSON.parse(raw) as HourlyLine;
        if (typeof entry.capturedAtMs === 'number' && entry.capturedAtMs >= windowStartMs) {
          result.push(entry);
        }
      } catch {
        // malformed — skip
      }
    }
    result.sort((a, b) => a.capturedAtMs - b.capturedAtMs);
    return result;
  } catch (err) {
    log.warn(`[Reporting] hourly snapshot KST-midnight load failed: ${err}`);
    return [];
  }
}

async function loadHourlyLinesSinceFlush(): Promise<HourlyLine[]> {
  try {
    const dir = config.realtimeDataDir;
    let lastFlushAtMs = 0;
    try {
      const stateRaw = await readFile(path.join(dir, HOURLY_FLUSH_STATE_FILE), 'utf8');
      const state = JSON.parse(stateRaw) as { lastFlushAtMs?: number };
      lastFlushAtMs = typeof state.lastFlushAtMs === 'number' ? state.lastFlushAtMs : 0;
    } catch {
      // first run — no state file yet
    }
    // 24h hard window (안전망 — daily 미발사 incident 시 무한 누적 차단)
    const windowStartMs = Math.max(lastFlushAtMs, Date.now() - HOURLY_SNAPSHOT_RETENTION_MS);

    let text: string;
    try {
      text = await readFile(path.join(dir, HOURLY_SNAPSHOT_FILE), 'utf8');
    } catch {
      return [];
    }
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    const result: HourlyLine[] = [];
    for (const raw of lines) {
      try {
        const entry = JSON.parse(raw) as HourlyLine;
        if (typeof entry.capturedAtMs === 'number' && entry.capturedAtMs > windowStartMs) {
          result.push(entry);
        }
      } catch {
        // malformed line — skip
      }
    }
    // sort by capturedAtMs ascending (file is append-order, but defensive)
    result.sort((a, b) => a.capturedAtMs - b.capturedAtMs);
    return result;
  } catch (err) {
    log.warn(`[Reporting] hourly snapshot load failed: ${err}`);
    return [];
  }
}

async function persistFlushState(nowMs: number): Promise<void> {
  try {
    const dir = config.realtimeDataDir;
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, HOURLY_FLUSH_STATE_FILE),
      JSON.stringify({ lastFlushAtMs: nowMs }),
      'utf8'
    );
  } catch (err) {
    log.warn(`[Reporting] hourly flush state persist failed: ${err}`);
  }
}

async function pruneOldHourlySnapshots(): Promise<void> {
  // 72h 이전 entries 제거 (lazy — heartbeat / daily 시 호출).
  // 실패해도 silent — 무한 누적은 24h hard window 가 차단.
  try {
    const dir = config.realtimeDataDir;
    const filePath = path.join(dir, HOURLY_SNAPSHOT_FILE);
    const text = await readFile(filePath, 'utf8').catch(() => '');
    if (!text) return;
    const cutoffMs = Date.now() - HOURLY_SNAPSHOT_RETENTION_MS;
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    const kept: string[] = [];
    for (const raw of lines) {
      try {
        const entry = JSON.parse(raw) as HourlyLine;
        if (typeof entry.capturedAtMs === 'number' && entry.capturedAtMs > cutoffMs) {
          kept.push(raw);
        }
      } catch { /* drop malformed */ }
    }
    if (kept.length !== lines.length) {
      await writeFile(filePath, kept.join('\n') + (kept.length > 0 ? '\n' : ''), 'utf8');
      log.debug(`[Reporting] hourly snapshot pruned: ${lines.length} → ${kept.length}`);
    }
  } catch (err) {
    log.debug(`[Reporting] hourly snapshot prune failed: ${err}`);
  }
}

async function captureHourlySnapshot(ctx: BotContext): Promise<HourlyLine> {
  const now = new Date();
  const kstHour = (now.getUTCHours() + 9) % 24;
  const balance = ctx.tradingMode === 'paper' && ctx.paperBalance != null
    ? ctx.paperBalance
    : await ctx.executor.getBalance();

  let deltaStr = '';
  let balanceDeltaSol: number | undefined;
  if (hourlyBaseline != null) {
    const delta = balance - hourlyBaseline.balanceSol;
    balanceDeltaSol = delta;
    const sign = delta >= 0 ? '+' : '';
    deltaStr = ` (${sign}${delta.toFixed(4)})`;
  }

  // 2026-04-29 (Q3 fix): tradeStore fetch 실패해도 balance line 은 보존.
  // 이전: getTradesCreatedWithinHours throw → captureHourlySnapshot 전체 throw → 그 hour 의 line 누락 +
  //   heartbeat/daily 시점 currentHourLine null → buffer 도 미flush 되어 누적 hourly digest 통째로 사라짐.
  // 수정: trade fetch 실패 시 closeText='close ?' (degraded line) + 카운트 0 으로 line 생성.
  //   balance / delta 는 유효 → 운영자가 잔고 추이는 끊김 없이 확인. 다음 hour 정상 fetch 시 정확값 복귀.
  const oneHourAgoMs = now.getTime() - 60 * 60 * 1000;
  let liveClosedCount = 0;
  let liveWinners = 0;
  let liveLosers = 0;
  let liveCumPnl = 0;
  let fivexCaptured = 0;  // mfe peak ≥+400% AND net ≥+400% (실제 winner)
  let fivexKilled = 0;    // mfe peak ≥+400% BUT net < +400% (winner-kill, 사용자 지적)
  let fetchFailed = false;
  try {
    const recentTrades = await ctx.tradeStore.getTradesCreatedWithinHours(1);
    const liveClosed = recentTrades.filter(
      (t) => t.status === 'CLOSED' && t.pnl !== undefined && t.closedAt && t.closedAt.getTime() >= oneHourAgoMs
    );
    liveClosedCount = liveClosed.length;
    liveWinners = liveClosed.filter((t) => (t.pnl ?? 0) > 0).length;
    liveLosers = liveClosed.filter((t) => (t.pnl ?? 0) <= 0).length;
    liveCumPnl = liveClosed.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    // 2026-04-30 (사용자 권고 — 🎉 톤 다운): 5x peak 도달 trade 를 capture / killed 분리.
    //   capture: mfe peak ≥+400% AND net ≥+400% (실제 winner — 사명 §3 카운트 + 축하)
    //   killed: mfe peak ≥+400% BUT net < +400% (winner-kill — 톤 다운, 정직한 표기)
    //   net loss 인데 🎉 표시는 misleading 했음. 5x peak 라는 사실은 사명 §3 measurement 정합 유지.
    for (const t of liveClosed) {
      if (!t.entryPrice || t.entryPrice <= 0) continue;
      const peak = t.highWaterMark ?? t.exitPrice ?? 0;
      if (peak <= 0) continue;
      if (peak / t.entryPrice >= 5.0) {
        const exitPrice = t.exitPrice ?? 0;
        const netRatio = exitPrice > 0 ? exitPrice / t.entryPrice : 0;
        if (netRatio >= 5.0) fivexCaptured++;
        else fivexKilled++;
      }
    }
  } catch (err) {
    fetchFailed = true;
    log.warn(`[Reporting] getTradesCreatedWithinHours(1) failed in hourly snapshot: ${err}`);
  }

  const closeText = fetchFailed
    ? 'close ?건 (DB unavailable)'
    : liveClosedCount === 0
      ? 'close 0건'
      : `close ${liveClosedCount}건 (${liveWinners}W/${liveLosers}L) net ${liveCumPnl >= 0 ? '+' : ''}${liveCumPnl.toFixed(4)}`;
  // 5x peak 표기 — capture 와 killed 분리. 폭죽 → 목표(🎯) 로 톤 다운.
  const fivexParts: string[] = [];
  if (fivexCaptured > 0) fivexParts.push(`🎯 5x capture ${fivexCaptured}`);
  if (fivexKilled > 0) fivexParts.push(`⚠ 5x killed ${fivexKilled}`);
  const fivexText = fivexParts.length > 0 ? ` · ${fivexParts.join(' · ')}` : '';
  const text = `- ${kstHour.toString().padStart(2, '0')}:00 · ${balance.toFixed(4)} SOL${deltaStr} · ${closeText}${fivexText}`;

  hourlyBaseline = { balanceSol: balance, capturedAtMs: now.getTime() };

  const line: HourlyLine = {
    kstHour,
    capturedAtMs: now.getTime(),
    text,
    balanceSol: balance,
    balanceDeltaSol,
    liveClosed: liveClosedCount,
    liveWinners,
    liveLosers,
    liveCumPnl,
    fivexWinners: fivexCaptured + fivexKilled,  // 후방호환 (총 5x peak 도달 카운트)
    fivexCaptured,
    fivexKilled,
  };

  // 2026-04-30 (사용자 권고 — 시간대 누락 fix): captureHourlySnapshot 자체에서 disk persist.
  // 이전: bufferHourlySnapshot 만 persist → heartbeat (짝수 KST hour) / daily (KST 09) 시각의
  //   line 은 buffer 에만 들어가서 flushHourlyBuffer 후 사라짐 → 다음 batch load 시 02/04/06/08/09 누락.
  // 수정: captureHourlySnapshot 모든 호출자에서 disk 에 즉시 append → KST midnight load 시 빠짐 없음.
  await persistHourlyLine(line);
  return line;
}

async function bufferHourlySnapshot(ctx: BotContext): Promise<void> {
  // hourly slot — 알림 미발사. heartbeat / daily 시 batch flush.
  // 2026-04-29 (restart-resilient): in-memory buffer + disk persist 동시.
  // 2026-04-30: persist 는 captureHourlySnapshot 내부에서 자동 호출 (모든 호출자 정합).
  try {
    const line = await captureHourlySnapshot(ctx);
    hourlyLineBuffer.push(line);
  } catch (err) {
    log.warn(`Hourly snapshot capture failed: ${err}`);
  }
}

const BALANCE_EQUAL_EPS = 0.00005;  // 4dp 표시 기준 같은 잔고로 취급

function balanceFromHourlyLine(line: HourlyLine): number | null {
  if (typeof line.balanceSol === 'number' && Number.isFinite(line.balanceSol)) return line.balanceSol;
  const match = line.text.match(/·\s*([0-9]+(?:\.[0-9]+)?)\s*SOL/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function isSameBalance(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return false;
  return Math.abs(a - b) < BALANCE_EQUAL_EPS;
}

function kstHourKey(line: HourlyLine): string {
  // KST date-hour key. 같은 hour 에 여러 번 capture 된 row 는 최신 row 만 사용한다.
  return new Date(line.capturedAtMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 13);
}

function dedupeHourlyLinesByKstHour(lines: HourlyLine[]): HourlyLine[] {
  const byHour = new Map<string, HourlyLine>();
  for (const line of [...lines].sort((a, b) => a.capturedAtMs - b.capturedAtMs)) {
    const key = kstHourKey(line);
    const current = byHour.get(key);
    if (!current || line.capturedAtMs >= current.capturedAtMs) byHour.set(key, line);
  }
  return [...byHour.values()].sort((a, b) => a.capturedAtMs - b.capturedAtMs);
}

function hasHourlyActivity(line: HourlyLine): boolean {
  if (line.liveClosed > 0) return true;
  if ((line.fivexCaptured ?? 0) > 0 || (line.fivexKilled ?? 0) > 0 || (line.fivexWinners ?? 0) > 0) return true;
  return line.text.includes('DB unavailable');
}

function formatBalanceDelta(current: number | null, previous: number | null): string {
  if (current == null || previous == null) return '';
  const delta = current - previous;
  if (Math.abs(delta) < BALANCE_EQUAL_EPS) return '';
  return ` (${delta >= 0 ? '+' : ''}${delta.toFixed(4)})`;
}

function formatHourLabel(line: HourlyLine): string {
  return `${line.kstHour.toString().padStart(2, '0')}:00`;
}

function formatQuietRange(start: HourlyLine, end: HourlyLine, balance: number | null): string {
  const startHour = start.kstHour.toString().padStart(2, '0');
  const endHour = end.kstHour.toString().padStart(2, '0');
  const range = startHour === endHour ? `${startHour}:00` : `${startHour}-${endHour}`;
  const balanceText = balance == null ? '잔고 n/a' : `${balance.toFixed(4)} SOL`;
  return `- ${range} · ${balanceText} · close 0건`;
}

function formatActiveHourlyLine(line: HourlyLine, previousBalance: number | null): string {
  const balance = balanceFromHourlyLine(line);
  const balanceText = balance == null ? '잔고 n/a' : `${balance.toFixed(4)} SOL${formatBalanceDelta(balance, previousBalance)}`;
  const closeText = line.liveClosed > 0
    ? `close ${line.liveClosed}건 (${line.liveWinners}W/${line.liveLosers}L) net ${line.liveCumPnl >= 0 ? '+' : ''}${line.liveCumPnl.toFixed(4)}`
    : line.text.includes('DB unavailable')
      ? 'close ?건 (DB unavailable)'
      : '잔고 변화';
  const fivexParts: string[] = [];
  if ((line.fivexCaptured ?? 0) > 0) fivexParts.push(`🎯 5x capture ${line.fivexCaptured}`);
  if ((line.fivexKilled ?? 0) > 0) fivexParts.push(`⚠ 5x killed ${line.fivexKilled}`);
  if (line.fivexCaptured == null && line.fivexKilled == null && (line.fivexWinners ?? 0) > 0) {
    fivexParts.push(`5x peak ${line.fivexWinners}`);
  }
  const fivexText = fivexParts.length > 0 ? ` · ${fivexParts.join(' · ')}` : '';
  return `- ${formatHourLabel(line)} · ${balanceText} · ${closeText}${fivexText}`;
}

function formatCompactHourlyLines(lines: HourlyLine[]): string[] {
  const out: string[] = [];
  let quietStart: HourlyLine | null = null;
  let quietEnd: HourlyLine | null = null;
  let quietBalance: number | null = null;
  let previousBalance: number | null = null;

  const flushQuiet = () => {
    if (quietStart && quietEnd) out.push(formatQuietRange(quietStart, quietEnd, quietBalance));
    quietStart = null;
    quietEnd = null;
    quietBalance = null;
  };

  for (const line of lines) {
    const balance = balanceFromHourlyLine(line);
    const active = hasHourlyActivity(line);
    const balanceChanged = previousBalance != null && balance != null && !isSameBalance(balance, previousBalance);

    if (!active && !balanceChanged) {
      if (!quietStart) {
        quietStart = line;
        quietBalance = balance;
      }
      quietEnd = line;
      previousBalance = balance ?? previousBalance;
      continue;
    }

    flushQuiet();
    out.push(formatActiveHourlyLine(line, previousBalance));
    previousBalance = balance ?? previousBalance;
  }

  flushQuiet();
  return out;
}

/**
 * 2026-04-29 (Q3 fix): currentHour 가 null 이어도 buffer 만으로 digest 생성.
 * 2026-04-30 (사용자 권고): KST 00:00 부터 누적 — buffer 가 아닌 priorLines (disk persisted KST-midnight-anchored).
 * 2026-05-01: 모바일 가독성 — 같은 KST hour 중복 row 는 최신만 사용하고, 잔고/close 변화 없는 구간은 range 로 압축.
 */
export function buildHourlyDigest(priorLines: HourlyLine[], currentHour: HourlyLine | null): string {
  const merged: HourlyLine[] = [...priorLines];
  if (currentHour != null) {
    // dedup — 같은 capturedAtMs 가 prior 에도 있으면 skip (replay 방어)
    const dup = merged.some((l) => l.capturedAtMs === currentHour.capturedAtMs);
    if (!dup) merged.push(currentHour);
  }
  if (merged.length === 0) return '';
  const compacted = dedupeHourlyLinesByKstHour(merged);
  if (compacted.length === 0) return '';

  const totalClosed = compacted.reduce((s, l) => s + l.liveClosed, 0);
  const totalW = compacted.reduce((s, l) => s + l.liveWinners, 0);
  const totalL = compacted.reduce((s, l) => s + l.liveLosers, 0);
  const totalNet = compacted.reduce((s, l) => s + l.liveCumPnl, 0);
  // 2026-04-30: 5x peak capture vs killed 분리 합계. legacy entries (fivexCaptured 미기록) 는 fivexWinners 를 unknown 으로 처리.
  const totalCaptured = compacted.reduce((s, l) => s + (l.fivexCaptured ?? 0), 0);
  const totalKilled = compacted.reduce((s, l) => s + (l.fivexKilled ?? 0), 0);
  const totalFivexLegacy = compacted.reduce((s, l) => {
    if (l.fivexCaptured == null && l.fivexKilled == null) return s + (l.fivexWinners ?? 0);
    return s;
  }, 0);
  const startHour = compacted[0].kstHour.toString().padStart(2, '0');
  const endHour = compacted[compacted.length - 1].kstHour.toString().padStart(2, '0');

  const headline = `📊 <b>오늘 요약</b> KST ${startHour}:00→${endHour}:00`;
  const fivexParts: string[] = [];
  if (totalCaptured > 0) fivexParts.push(`🎯 5x capture ${totalCaptured}`);
  if (totalKilled > 0) fivexParts.push(`⚠ 5x killed ${totalKilled}`);
  if (totalFivexLegacy > 0) fivexParts.push(`5x peak ${totalFivexLegacy} (legacy)`);
  const fivexSummary = fivexParts.length > 0 ? ` · ${fivexParts.join(' · ')}` : '';
  const aggregateLine = totalClosed > 0
    ? `· 합계 close ${totalClosed}건 (${totalW}W/${totalL}L) net ${totalNet >= 0 ? '+' : ''}${totalNet.toFixed(4)} SOL${fivexSummary}`
    : `· 합계 close 0건 (해당 구간 거래 없음)`;

  return [headline, ...formatCompactHourlyLines(compacted), aggregateLine].join('\n');
}

async function flushHourlyBuffer(): Promise<void> {
  hourlyLineBuffer.length = 0;
  // 2026-04-29 (restart-resilient): lastFlushAtMs 갱신 → 다음 batch window 의 시작점.
  await persistFlushState(Date.now());
  // lazy prune (72h 이전 entries 정리)
  void pruneOldHourlySnapshots();
}

// 2026-04-29: 기동 직후 1회 발사 — baseline + 현재 상태 + 다음 batch 시각 안내.
async function sendStartupSnapshot(ctx: BotContext): Promise<void> {
  const now = new Date();
  const kstHour = (now.getUTCHours() + 9) % 24;
  const kstMin = now.getUTCMinutes();
  const balance = ctx.tradingMode === 'paper' && ctx.paperBalance != null
    ? ctx.paperBalance
    : await ctx.executor.getBalance();

  // 1h 누적 close 카운트 — 기동 시점부터 직전 1h
  const oneHourAgoMs = now.getTime() - 60 * 60 * 1000;
  const recentTrades = await ctx.tradeStore.getTradesCreatedWithinHours(1).catch(() => []);
  const liveClosed = recentTrades.filter(
    (t) => t.status === 'CLOSED' && t.pnl !== undefined && t.closedAt && t.closedAt.getTime() >= oneHourAgoMs
  );
  const liveWinners = liveClosed.filter((t) => (t.pnl ?? 0) > 0).length;
  const liveLosers = liveClosed.filter((t) => (t.pnl ?? 0) <= 0).length;
  const liveCumPnl = liveClosed.reduce((sum, t) => sum + (t.pnl ?? 0), 0);

  // 다음 batch 시각 = 다음 KST 짝수 hour (heartbeat) 또는 KST 09 (daily) 중 가까운 것
  const nextEvenHour = kstHour % 2 === 0 && kstMin === 0 ? kstHour : (kstHour + (kstHour % 2 === 0 ? 2 : 1)) % 24;
  const minutesUntilNext = ((nextEvenHour - kstHour + 24) % 24) * 60 - kstMin;

  // wallet floor 까지 여유
  const floor = config.walletStopMinSol;
  const marginToFloor = balance - floor;

  const closeText = liveClosed.length === 0
    ? 'close 0건 (직전 1h)'
    : `close ${liveClosed.length}건 (${liveWinners}W/${liveLosers}L) net ${liveCumPnl >= 0 ? '+' : ''}${liveCumPnl.toFixed(4)} SOL`;
  const marginText = marginToFloor >= 0
    ? `floor 까지 +${marginToFloor.toFixed(4)} SOL`
    : `⚠ floor 위반 ${marginToFloor.toFixed(4)} SOL`;

  const lines = [
    `🚀 <b>Bot 기동</b> · KST ${kstHour.toString().padStart(2, '0')}:${kstMin.toString().padStart(2, '0')}`,
    `- 잔고: ${balance.toFixed(4)} SOL · ${marginText}`,
    `- 직전 1h: ${closeText}`,
    `- 다음 2h 요약: KST ${nextEvenHour.toString().padStart(2, '0')}:00 (~${minutesUntilNext}분 후)`,
  ];

  await ctx.notifier.sendInfo(lines.join('\n'), 'startup_snapshot');

  // baseline set → 다음 hourly capture 시 delta 정확.
  hourlyBaseline = { balanceSol: balance, capturedAtMs: now.getTime() };
  log.info(`[Reporting] startup snapshot sent — balance=${balance.toFixed(4)} SOL, next batch in ~${minutesUntilNext}min`);
}

/**
 * 테스트 / 재시작 시 reporting scheduler + hourly state 전체 reset.
 * 2026-04-29 (Q1 fix): 이전엔 resetReportSchedulerForTests 와 동일 역할 두 함수가 공존하여
 *   누락된 hourlyLineBuffer 가 test 간 누수 위험. 단일 함수로 통합.
 */
export function resetHourlyBaselineForTests(): void {
  hourlyBaseline = null;
  lastFiredUtcHour = -1;
  hourlyLineBuffer.length = 0;
}

/** @deprecated Use resetHourlyBaselineForTests. Q1 fix 후 alias 로 보존. */
export const resetReportSchedulerForTests = resetHourlyBaselineForTests;

/**
 * 2시간 간격 간략 리포트.
 * Why: 사용자 알림(잔액/전적/시장)과 운영 텔레메트리(희박/Freshness/Cohort funnel)를
 *      하나의 메시지에 섞으면 사용자가 노이즈에 묻혀 계좌 상태를 놓친다.
 *      별도 카테고리로 분리 발송해 throttle 키도 독립화한다.
 */
async function sendHeartbeatReport(ctx: BotContext): Promise<void> {
  // 2026-04-30 (사용자 권고): heartbeat = hourly digest 만 (KST 00:00 부터 누적).
  //   "📊 Live · 최근 4h" trading summary + "🔍 시장 regime" 부분은 hourlyDigest 와 중복 → 제거.
  // 잔액 / close 카운트 / net 은 hourlyDigest 의 합계 라인에 이미 포함.
  const currentHourLine = await captureHourlySnapshot(ctx).catch((err) => {
    log.warn(`[Reporting] heartbeat captureHourlySnapshot failed: ${err}`);
    return null;
  });
  const priorLines = await loadHourlyLinesSinceKstMidnight();
  const hourlyDigest = buildHourlyDigest(priorLines, currentHourLine);
  await flushHourlyBuffer();

  const userLines: string[] = [];
  if (hourlyDigest) userLines.push(hourlyDigest);

  if (ctx.paperMetrics) {
    const performanceSummary = buildHeartbeatPerformanceSummary(
      ctx.paperMetrics.getSummary(HEARTBEAT_WINDOW_HOURS)
    );
    if (performanceSummary) {
      userLines.push(performanceSummary);
    }
  }

  if (userLines.length > 0) {
    await ctx.notifier.sendInfo(userLines.join('\n\n'), 'heartbeat');
  }

  // 2026-04-29 (Tier 1 noise reduction): trivial-summary skip 강화.
  // 이전: `if (sparseSummary)` — undefined 만 차단 (loadSparseOpsSummary 가 undefined 반환 시).
  //   loadSparseOpsSummary 는 current-session.json + runtime-diagnostics.json 만 있으면 항상 build →
  //   "신호 0건 | 진입 0건 | 진단 이벤트 0건" 같은 trivially-empty summary 도 발사 = 실제 noise.
  // 현재: 신호/진입/진단/trigger/cupsey funnel/alias miss/freshness 전부 0 또는 부재면 skip.
  const sparseSummaryData = loadSparseOpsSummary(config.realtimeDataDir, HEARTBEAT_WINDOW_HOURS, 3);
  const sparseSummary = buildSparseOpsSummaryMessage(sparseSummaryData);
  const sparseTrivial = !sparseSummaryData
    || (sparseSummaryData.totalSignals === 0
      && sparseSummaryData.executedLiveSignals === 0
      && sparseSummaryData.diagnosticEvents === 0
      && !sparseSummaryData.latestTriggerStats
      && !sparseSummaryData.latestCupseyFunnel
      && sparseSummaryData.aliasMissTop.length === 0
      && !sparseSummaryData.freshness);
  if (sparseSummary && !sparseTrivial) {
    await ctx.notifier.sendInfo(sparseSummary, 'heartbeat_ops');
  }
}

async function sendDailySummaryReport(ctx: BotContext): Promise<void> {
  // 2026-04-29 B안: daily 시점에도 hourly buffer flush + digest 발송 (last batch 손실 방지).
  // 2026-04-29 (Q3 fix): dailyHourLine null 이어도 buffer 만으로 digest 시도.
  const dailyHourLine = await captureHourlySnapshot(ctx).catch((err) => {
    log.warn(`[Reporting] daily captureHourlySnapshot failed: ${err}`);
    return null;
  });
  // 2026-04-30 (사용자 권고): KST 00:00 ~ 09:00 (daily 시각) 까지 누적.
  const dailyPriorLines = await loadHourlyLinesSinceKstMidnight();
  const digest = buildHourlyDigest(dailyPriorLines, dailyHourLine);
  if (digest) {
    await ctx.notifier.sendInfo(digest, 'hourly_digest_pre_daily').catch(() => {});
  }
  await flushHourlyBuffer();

  const cadenceHours = [6, 12, 24];
  const rejectionMixHours = 24;
  const todayTrades = await ctx.tradeStore.getTodayTrades();
  const closedTodayTrades = todayTrades.filter(
    trade => trade.status === 'CLOSED' && trade.pnl !== undefined
  );
  const dailyPnl = await ctx.tradeStore.getTodayPnl();
  const signalCounts = await ctx.auditLogger.getTodaySignalCounts();
  const [signalCadence, tradeCadence, filterReasonCounts, strategyTelemetry, exitReasonBreakdown] = await Promise.all([
    ctx.auditLogger.getCadenceSignalSummary(cadenceHours),
    ctx.tradeStore.getCadenceTradeSummary(cadenceHours),
    ctx.auditLogger.getRecentGateFilterReasonCounts(rejectionMixHours),
    ctx.auditLogger.getRecentStrategyFilterBreakdown(rejectionMixHours),
    ctx.tradeStore.getExitReasonBreakdown(rejectionMixHours),
  ]);
  const balance = ctx.tradingMode === 'paper' && ctx.paperBalance != null
    ? ctx.paperBalance
    : await ctx.executor.getBalance();
  const status = ctx.healthMonitor.getStatus();
  const edgeTracker = new EdgeTracker(
    sanitizeEdgeLikeTrades(closedTodayTrades.map(trade => ({
      pairAddress: trade.pairAddress,
      strategy: trade.strategy,
      entryPrice: trade.entryPrice,
      stopLoss: trade.stopLoss,
      quantity: trade.quantity,
      pnl: trade.pnl ?? 0,
      // Phase B1: sanitizer가 오염된 row를 drop할 수 있도록 정합성 컨텍스트 전달.
      plannedEntryPrice: trade.plannedEntryPrice ?? null,
      exitReason: trade.exitReason ?? null,
      // 2026-04-07: fake-fill sanitizer filter 컨텍스트
      exitSlippageBps: trade.exitSlippageBps ?? null,
      exitAnomalyReason: trade.exitAnomalyReason ?? null,
    }))).trades
  );

  const wins = closedTodayTrades.filter(t => (t.pnl || 0) > 0);
  const losses = closedTodayTrades.filter(t => (t.pnl || 0) <= 0);
  const sourceOutcomes = summarizeTradesBySource(closedTodayTrades);
  // Why: MEASUREMENT.md "최근 50 executed trades" — 진입 기준 (open/closed 무관)
  const recentExecutedEntries = await ctx.tradeStore.getRecentExecutedEntries(50);
  const explainedEntry = computeExplainedEntryRatio(recentExecutedEntries);
  const portfolio = await ctx.riskManager.getPortfolioState(balance);
  const runtimeDiagnostics = ctx.runtimeDiagnosticsTracker?.buildSummary(rejectionMixHours);
  const todayUtcOps = ctx.runtimeDiagnosticsTracker?.buildTodayUtcOperationalSummary();

  let bestTrade: { pair: string; pnl: number; score: number; grade: string } | undefined;
  let worstTrade: { pair: string; pnl: number; score: number; grade: string } | undefined;

  for (const t of closedTodayTrades) {
    if (t.pnl !== undefined) {
      if (!bestTrade || t.pnl > bestTrade.pnl) {
        bestTrade = {
          pair: t.pairAddress,
          pnl: t.pnl,
          score: t.breakoutScore || 0,
          grade: t.breakoutGrade || 'N/A',
        };
      }
      if (!worstTrade || t.pnl < worstTrade.pnl) {
        worstTrade = {
          pair: t.pairAddress,
          pnl: t.pnl,
          score: t.breakoutScore || 0,
          grade: t.breakoutGrade || 'N/A',
        };
      }
    }
  }

  const costSummary = buildCostSummary(closedTodayTrades);

  await ctx.notifier.sendDailySummary({
    totalTrades: closedTodayTrades.length,
    wins: wins.length,
    losses: losses.length,
    pnl: dailyPnl,
    portfolioValue: balance,
    bestTrade,
    worstTrade,
    signalsDetected: signalCounts.detected,
    signalsExecuted: signalCounts.executed,
    signalsFiltered: signalCounts.filtered,
    dailyLossUsed: portfolio.equitySol > 0 ? Math.abs(dailyPnl) / portfolio.equitySol : 0,
    // 2026-04-29 (Option D): env override 반영 — Telegram digest 가 실 halt 임계 (riskManager.getActiveHalt) 와 정합.
    // null = tier 정책. 0 이하 = disable (해당 lane 은 wallet floor + canary cap 만 보호).
    dailyLossLimit: config.riskMaxDailyLossOverride != null
      ? config.riskMaxDailyLossOverride
      : (portfolio.riskTier?.maxDailyLoss ?? config.maxDailyLoss),
    consecutiveLosses: portfolio.consecutiveLosses,
    uptime: status.uptime,
    restarts: 0,
    edgeStats: edgeTracker.getAllStrategyStats(),
    sourceOutcomes,
    explainedEntryRatio: {
      total: explainedEntry.total,
      explained: explainedEntry.explained,
      ratio: explainedEntry.ratio,
    },
    costSummary,
    todayUtcOps,
    realtimeAdmission: buildRealtimeAdmissionSummary(ctx),
    strategyTelemetry,
    exitReasonBreakdown,
    cadence: buildDailyCadenceSummary(signalCadence, tradeCadence),
    rejectionMix: buildDailyRejectionMixSummary({
      hours: rejectionMixHours,
      filterReasonCounts,
      runtimeDiagnostics,
      lastCandleAt: status.lastCandleAt,
    }),
  } satisfies DailySummaryReport);

  // Phase 1B: Paper metrics + regime status
  if (ctx.paperMetrics) {
    const paperText = ctx.paperMetrics.formatSummaryText(24);
    await ctx.notifier.sendInfo(paperText, 'paper_metrics');
  }
  // 2026-04-30 (사용자 권고): "🔍 시장 regime" 별도 알림 제거 (heartbeat 와 동일 — 사용자가 noise 로 평가).
  // 운영자가 다시 필요하면 explicit env (REGIME_DAILY_ALERT_ENABLED=true) 로 재활성 권고.

  // 2026-04-26 L3: KOL paper A/B daily summary (kol-paper-trades.jsonl 기준).
  // config.kolDailySummaryEnabled 로 gate. 24h 거래 0건이면 skip.
  await sendKolDailySummary(ctx.notifier);
}

function buildCostSummary(trades: import('../utils/types').Trade[]): CostSummary | undefined {
  // Why: 비용 필드가 있는 거래만 집계 (legacy trade는 null)
  const withCost = trades.filter(t => t.entrySlippageBps != null || t.exitSlippageBps != null);
  if (withCost.length === 0) return undefined;

  const avg = (values: number[]) => values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;

  return {
    tradeCount: withCost.length,
    avgEntrySlippageBps: avg(withCost.map(t => t.entrySlippageBps ?? 0)),
    avgExitSlippageBps: avg(withCost.map(t => t.exitSlippageBps ?? 0)),
    avgRoundTripCostPct: avg(withCost.filter(t => t.roundTripCostPct != null).map(t => t.roundTripCostPct!)),
    avgEffectiveRR: avg(withCost.filter(t => t.effectiveRR != null).map(t => t.effectiveRR!)),
  };
}

function buildDailyRejectionMixSummary(params: {
  hours: number;
  filterReasonCounts: Array<{ reason: string; count: number }>;
  runtimeDiagnostics?: RuntimeDiagnosticsSummary;
  lastCandleAt?: Date;
}): DailySummaryReport['rejectionMix'] {
  const nowMs = Date.now();
  return {
    hours: params.hours,
    lastCandleAt: params.lastCandleAt?.toISOString(),
    timeSinceLastCandleMs: params.lastCandleAt
      ? Math.max(0, nowMs - params.lastCandleAt.getTime())
      : undefined,
    gateFilterReasonCounts: params.filterReasonCounts,
    admissionSkipCounts: params.runtimeDiagnostics?.admissionSkipCounts ?? [],
    admissionSkipDetailCounts: params.runtimeDiagnostics?.admissionSkipDetailCounts ?? [],
    aliasMissCounts: params.runtimeDiagnostics?.aliasMissCounts ?? [],
    candidateEvictedCount: params.runtimeDiagnostics?.candidateEvictedCount ?? 0,
    candidateReaddedWithinGraceCount: params.runtimeDiagnostics?.candidateReaddedWithinGraceCount ?? 0,
    signalNotInWatchlistCount: params.runtimeDiagnostics?.signalNotInWatchlistCount ?? 0,
    signalNotInWatchlistRecentlyEvictedCount:
      params.runtimeDiagnostics?.signalNotInWatchlistRecentlyEvictedCount ?? 0,
    missedTokens: params.runtimeDiagnostics?.missedTokens ?? [],
    capacityCounts: params.runtimeDiagnostics?.capacityCounts ?? [],
    triggerStatsCounts: params.runtimeDiagnostics?.triggerStatsCounts ?? [],
    latestTriggerStats: params.runtimeDiagnostics?.latestTriggerStats,
    bootstrapBoostedSignalCount: params.runtimeDiagnostics?.bootstrapBoostedSignalCount ?? 0,
    preWatchlistRejectCounts: params.runtimeDiagnostics?.preWatchlistRejectCounts ?? [],
    preWatchlistRejectDetailCounts: params.runtimeDiagnostics?.preWatchlistRejectDetailCounts ?? [],
    rateLimitCounts: params.runtimeDiagnostics?.rateLimitCounts ?? [],
    pollFailureCounts: params.runtimeDiagnostics?.pollFailureCounts ?? [],
    riskRejectionCounts: params.runtimeDiagnostics?.riskRejectionCounts ?? [],
    realtimeCandidateReadiness: params.runtimeDiagnostics?.realtimeCandidateReadiness ?? {
      totalCandidates: 0,
      prefiltered: 0,
      admissionSkipped: 0,
      ready: 0,
      readinessRate: 0,
    },
  };
}

function buildDailyCadenceSummary(
  signalCadence: {
    lastSignalAt?: Date;
    windows: Array<{ hours: number; detected: number; executed: number; filtered: number }>;
  },
  tradeCadence: {
    lastTradeAt?: Date;
    lastClosedTradeAt?: Date;
    windows: Array<{ hours: number; trades: number; closedTrades: number }>;
  }
): DailySummaryReport['cadence'] {
  const nowMs = Date.now();
  const signalWindowMap = new Map(signalCadence.windows.map((window) => [window.hours, window]));
  const tradeWindowMap = new Map(tradeCadence.windows.map((window) => [window.hours, window]));
  const hours = [...new Set([...signalWindowMap.keys(), ...tradeWindowMap.keys()])].sort((a, b) => a - b);

  return {
    lastSignalAt: signalCadence.lastSignalAt?.toISOString(),
    lastTradeAt: tradeCadence.lastTradeAt?.toISOString(),
    lastClosedTradeAt: tradeCadence.lastClosedTradeAt?.toISOString(),
    timeSinceLastSignalMs: signalCadence.lastSignalAt ? Math.max(0, nowMs - signalCadence.lastSignalAt.getTime()) : undefined,
    timeSinceLastTradeMs: tradeCadence.lastTradeAt ? Math.max(0, nowMs - tradeCadence.lastTradeAt.getTime()) : undefined,
    timeSinceLastClosedTradeMs: tradeCadence.lastClosedTradeAt
      ? Math.max(0, nowMs - tradeCadence.lastClosedTradeAt.getTime())
      : undefined,
    windows: hours.map((hour) => ({
      hours: hour,
      detectedSignals: signalWindowMap.get(hour)?.detected ?? 0,
      executedSignals: signalWindowMap.get(hour)?.executed ?? 0,
      filteredSignals: signalWindowMap.get(hour)?.filtered ?? 0,
      trades: tradeWindowMap.get(hour)?.trades ?? 0,
      closedTrades: tradeWindowMap.get(hour)?.closedTrades ?? 0,
    })),
  };
}

function buildRealtimeAdmissionSummary(ctx: BotContext): RealtimeAdmissionSummary | undefined {
  if (!ctx.realtimeAdmissionTracker) return undefined;

  const entries = ctx.realtimeAdmissionTracker.exportSnapshot();
  if (entries.length === 0) return undefined;

  const blockedDetails = entries
    .filter((entry) => entry.blocked)
    .map((entry) => ({
      pool: entry.pool,
      observedNotifications: entry.observedNotifications,
      parseRatePct: calculateParseRatePct(entry),
      skippedRatePct: calculateSkippedRatePct(entry),
    }))
    .sort((left, right) => right.observedNotifications - left.observedNotifications)
    .slice(0, 3);

  const blockedPools = entries.filter((entry) => entry.blocked).length;
  return {
    trackedPools: entries.length,
    allowedPools: entries.length - blockedPools,
    blockedPools,
    blockedDetails,
  };
}

function calculateParseRatePct(entry: RealtimeAdmissionSnapshotEntry): number {
  if (entry.observedNotifications <= 0) return 0;
  return Number((((entry.logParsed + (entry.fallbackParsed ?? 0)) / entry.observedNotifications) * 100).toFixed(2));
}

function calculateSkippedRatePct(entry: RealtimeAdmissionSnapshotEntry): number {
  if (entry.observedNotifications <= 0) return 0;
  return Number(((entry.fallbackSkipped / entry.observedNotifications) * 100).toFixed(2));
}
