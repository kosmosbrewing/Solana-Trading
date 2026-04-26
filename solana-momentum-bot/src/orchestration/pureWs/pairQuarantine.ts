// 2026-04-25 Phase 4 P2-1/P2-2: pair quarantine bootstrap + ledger.
// drift_reject burst 가 임계치 넘으면 60min quarantine — pippin 류 stale price 자동 격리.
// configurePairQuarantine 는 idempotent — 첫 entryFlow 진입 시 lazy bootstrap.

import { appendFile as appendFileFs, mkdir as mkdirFs } from 'fs/promises';
import path from 'path';
import { config } from '../../utils/config';
import { configurePairQuarantine } from '../../risk/pairQuarantineTracker';

let pairQuarantineLedgerDirEnsured = false;
export async function appendPairQuarantineLedger(entry: Record<string, unknown>): Promise<void> {
  try {
    const dir = config.realtimeDataDir;
    if (!pairQuarantineLedgerDirEnsured) {
      await mkdirFs(dir, { recursive: true });
      pairQuarantineLedgerDirEnsured = true;
    }
    await appendFileFs(
      path.join(dir, 'pair-quarantine.jsonl'),
      JSON.stringify(entry) + '\n',
      'utf8'
    );
  } catch {
    // best-effort — observability 만, trade path 차단 금지
  }
}

export let pairQuarantineConfigured = false;
export function ensurePairQuarantineConfigured(): void {
  if (pairQuarantineConfigured) return;
  pairQuarantineConfigured = true;
  configurePairQuarantine({
    enabled: config.pairQuarantineEnabled,
    driftRejectThreshold: config.pairQuarantineDriftRejectThreshold,
    favorableDriftThreshold: config.pairQuarantineFavorableDriftThreshold,
    windowMs: config.pairQuarantineWindowMin * 60 * 1000,
    durationMs: config.pairQuarantineDurationMin * 60 * 1000,
  });
}

/** resetPureWsLaneStateForTests 가 사용 — bootstrap flag 만 다시 false 로. */
export function clearPairQuarantineConfigured(): void {
  pairQuarantineConfigured = false;
}
