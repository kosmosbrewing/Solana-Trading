/**
 * Admission Skip DEX Logger (2026-04-18, Block 2)
 *
 * Why: Layer 3 bottleneck analysis 는 `unsupported_dex=182 (77.8%)` 를 coverage 주 병목으로 지목했다.
 * 하지만 runtime 이 in-memory 집계만 해서 "어떤 DEX 가 거부되는가" 는 알 수 없었다.
 * 이 모듈은 admission skip 이 발생한 dexId + samplePair 를 JSONL 로 persist 하여
 * 24-48h 후 empirical 기반으로 어느 DEX 를 support 해야 하는지 판정할 수 있게 한다.
 *
 * 설계:
 *   - fire-and-forget append (실패해도 trading 경로 차단 금지)
 *   - per-dexId dedup (60초 TTL) — 동일 DEX 반복 기록으로 disk 폭증 방지
 *   - convexity 기여도 낮음 (데이터 수집 목적). 기본 활성.
 */
import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { config } from '../utils/config';
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('AdmissionSkipLogger');

const DEDUP_TTL_MS = 60_000;
const dedupTimestamps = new Map<string, number>();
let dirEnsured = false;

export interface AdmissionSkipDexEntry {
  reason: string;
  detail?: string;
  tokenMint: string;
  dexId?: string;
  samplePair?: string;
  resolvedPairsCount?: number;
  admissionPairsCount?: number;
  source?: string;
}

export async function logAdmissionSkipDex(entry: AdmissionSkipDexEntry): Promise<void> {
  // Only persist unsupported_dex / no_pairs / unsupported_pool_program — DEX 판정 관련 skip 만
  if (
    entry.reason !== 'unsupported_dex' &&
    entry.reason !== 'no_pairs' &&
    entry.reason !== 'unsupported_pool_program'
  ) {
    return;
  }

  try {
    const dedupeKey = `${entry.reason}:${entry.dexId ?? 'none'}:${entry.tokenMint}`;
    const nowMs = Date.now();
    const pruneBeforeMs = nowMs - DEDUP_TTL_MS;
    for (const [key, timestamp] of dedupTimestamps) {
      if (timestamp < pruneBeforeMs) dedupTimestamps.delete(key);
    }
    if (dedupTimestamps.has(dedupeKey)) return;
    dedupTimestamps.set(dedupeKey, nowMs);

    const dir = config.realtimeDataDir;
    if (!dirEnsured) {
      await mkdir(dir, { recursive: true });
      dirEnsured = true;
    }
    const record = {
      recordedAt: new Date().toISOString(),
      ...entry,
    };
    await appendFile(
      path.join(dir, 'admission-skips-dex.jsonl'),
      JSON.stringify(record) + '\n',
      'utf8'
    );
  } catch (err) {
    log.debug(`[ADM_SKIP_LOG] append failed (non-fatal): ${err}`);
  }
}

export function resetAdmissionSkipLoggerForTests(): void {
  dedupTimestamps.clear();
  dirEnsured = false;
}
