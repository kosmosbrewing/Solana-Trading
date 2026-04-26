/**
 * Entry Integrity Shared Helper (2026-04-17, Block 1.5-2)
 *
 * Why: 2026-04-17 wallet-reconcile 감사에서 <unknown> 206 buys (-15.65 SOL) 발견 —
 * on-chain buy tx 성공 + DB insertTrade 실패 (silent) 누적이 원인. 2026-04-16 Phase E 시점에
 * cupseyLaneHandler 에만 `integrityHaltActive` + `executed-buys.jsonl` fallback ledger 가 추가됐고,
 * 다른 lane (main/migration/strategy_d) 은 동일한 방어가 없었다.
 *
 * 본 모듈은 그 3 단 방어 패턴을 **공통 helper** 로 추출하여 모든 entry 경로가 재사용하게 한다.
 *
 * 3단 방어:
 *   1) tx 성공 직후 `executed-buys.jsonl` 에 **fallback 기록** (DB 실패해도 on-chain 사실 보존)
 *   2) `insertTrade` 시도
 *   3) 실패 시 해당 lane 의 **integrityHaltActive** 세팅 + critical notifier
 *      → 이후 동일 lane 의 신규 entry 는 차단 (operator 가 reset 할 때까지)
 *
 * Lane 분리:
 *   - cupsey / migration / main / strategy_d — 각자 독립 halt flag
 *   - 한 lane halt 는 다른 lane 의 entry 와 무관
 *
 * Fallback ledger 파일:
 *   - `${realtimeDataDir}/executed-buys.jsonl` (공유, lane 필드 포함)
 *   - `${realtimeDataDir}/executed-sells.jsonl` (공유)
 *   - cupsey 기존 파일과 동일 — 이미 사용 중인 dedup/format 재사용
 */
import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { createModuleLogger } from '../utils/logger';
import { config } from '../utils/config';
import type { Trade } from '../utils/types';
import type { BotContext } from './types';
// Phase H2.2 (2026-04-26): halt state 는 src/state/ 로 이동.
// 본 파일에서는 backward compat 위해 re-export. 신규 코드는 직접 src/state/entryHaltState 사용 권장.
import {
  type EntryLane,
  triggerEntryHalt,
  resetAllEntryHaltsForTests as resetAllEntryHaltStateForTests,
} from '../state/entryHaltState';

const log = createModuleLogger('EntryIntegrity');

export {
  type EntryLane,
  isEntryHaltActive,
  triggerEntryHalt,
  resetEntryHalt,
  getAllLaneIntegrityState,
} from '../state/entryHaltState';

// Fallback ledger dedup — `${type}:${txSignature}` 기준 24h TTL
const ledgerDedupTimestamps = new Map<string, number>();
const LEDGER_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
let ledgerDirEnsured = false;

export function resetAllEntryHaltsForTests(): void {
  resetAllEntryHaltStateForTests();
  ledgerDedupTimestamps.clear();
  ledgerDirEnsured = false;
}

// ─── Fallback Ledger (shared executed-buys.jsonl / executed-sells.jsonl) ───

export async function appendEntryLedger(
  type: 'buy' | 'sell',
  entry: Record<string, unknown>
): Promise<void> {
  try {
    const txSignature = typeof entry.txSignature === 'string' ? entry.txSignature : '';
    if (txSignature) {
      const dedupeKey = `${type}:${txSignature}`;
      const nowMs = Date.now();
      const pruneBeforeMs = nowMs - LEDGER_DEDUP_TTL_MS;
      for (const [key, timestampMs] of ledgerDedupTimestamps) {
        if (timestampMs < pruneBeforeMs) ledgerDedupTimestamps.delete(key);
      }
      if (ledgerDedupTimestamps.has(dedupeKey)) return;
      ledgerDedupTimestamps.set(dedupeKey, nowMs);
    }
    const logDir = config.realtimeDataDir;
    if (!ledgerDirEnsured) {
      await mkdir(logDir, { recursive: true });
      ledgerDirEnsured = true;
    }
    await appendFile(
      path.join(logDir, `executed-${type}s.jsonl`),
      JSON.stringify({ ...entry, recordedAt: new Date().toISOString() }) + '\n',
      'utf8'
    );
  } catch {
    // Why: fallback ledger 기록 실패는 trading path 차단하지 않음 — log only
  }
}

// ─── Integrated Wrapper — tx 성공 후 DB 저장 + 실패 방어 ───

export interface PersistOpenTradeInput {
  ctx: BotContext;
  lane: EntryLane;
  tradeData: Omit<Trade, 'id'>;
  /** fallback ledger 에 남길 entry (tx_signature 포함 권장, dedup 키 역할) */
  ledgerEntry: Record<string, unknown>;
  /** notifier critical 의 key/tag */
  notifierKey: string;
  /** notifier 메시지 builder — DB 실패 시 critical 알람에 사용 */
  buildNotifierMessage: (err: unknown) => string;
  /** live 모드에서만 halt 설정. paper/backtest 는 halt 생략 (기본 true) */
  haltOnFailure?: boolean;
}

export interface PersistOpenTradeResult {
  dbTradeId: string | null;
  halted: boolean;
}

export async function persistOpenTradeWithIntegrity(
  opts: PersistOpenTradeInput
): Promise<PersistOpenTradeResult> {
  // Step 1: fallback ledger (DB 실패해도 on-chain 사실 보존)
  await appendEntryLedger('buy', opts.ledgerEntry);

  // Step 2: insertTrade
  try {
    const dbTradeId = await opts.ctx.tradeStore.insertTrade(opts.tradeData);
    return { dbTradeId, halted: false };
  } catch (err) {
    // Step 3: halt + critical notifier
    const shouldHalt = (opts.haltOnFailure ?? true) && opts.ctx.tradingMode === 'live';
    log.error(`[ENTRY_PERSIST_FAIL] lane=${opts.lane} ${err}`);
    if (shouldHalt) {
      const txSig = typeof opts.ledgerEntry.txSignature === 'string'
        ? opts.ledgerEntry.txSignature
        : 'unknown';
      triggerEntryHalt(opts.lane, `insertTrade failed after tx=${txSig}: ${err}`);
    }
    // 2026-04-26 quality fix: notifier 실패도 log 로 추적 (이전 silent catch).
    // 운영자가 critical alert 미수신 시 노드 health 추적에 도움.
    await opts.ctx.notifier.sendCritical(
      opts.notifierKey,
      opts.buildNotifierMessage(err)
    ).catch((notifyErr) =>
      log.warn(`[ENTRY_INTEGRITY_NOTIFY_FAIL] lane=${opts.lane} key=${opts.notifierKey}: ${notifyErr}`)
    );
    return { dbTradeId: null, halted: shouldHalt };
  }
}
