/**
 * Migration Event Detector (2026-04-17, Tier 1 — skeleton)
 *
 * 목적: Pump.fun graduation / PumpSwap canonical pool / Raydium LaunchLab 이벤트를 감지해
 * MigrationEvent를 emit한다.
 *
 * 현재 구현 상태 (skeleton):
 *   - `classifyCandidateAsMigrationEvent()` — 새로 discover된 pair의 metadata를 보고
 *     migration 여부를 heuristic 으로 판정.
 *   - 실제 on-chain graduation tx decode (Pump.fun BondingCurve Program log 분석)는
 *     Tier 1 Phase 2 후속 작업 — 지금은 `signal-only` 모드로 먼저 데이터 수집.
 *
 * Integration: index.ts의 scanner / poolDiscovery 경로에서
 * `onMigrationEvent(detector.classify(pool))`를 호출한다.
 *
 * TODO (Phase 2 후속):
 *   - Pump.fun Program ID log 패턴으로 정확한 graduation tx 식별
 *   - PumpSwap canonical pool init instruction decode
 *   - Raydium LaunchLab 졸업 이벤트 별도 구현
 */
import { MigrationEvent, MigrationEventKind } from '../strategy/migrationHandoffReclaim';
import { RealtimePoolMetadata } from './types';
import { isPumpSwapPool, PUMP_SWAP_PROGRAM } from './pumpSwapParser';
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('MigrationDetector');

export interface MigrationCandidate {
  pairAddress: string;
  tokenSymbol?: string;
  metadata?: RealtimePoolMetadata;
  currentPrice?: number;
  /** 새 pair로 분류된 시각 (scanner discovery 시점) */
  discoveredAtSec: number;
  /** 이 pool이 on-chain에 처음 등장한 시각 (가능하면) */
  poolCreatedAtSec?: number;
}

/**
 * 후보 pool을 MigrationEvent로 분류. 일치하지 않으면 null.
 *
 * heuristic:
 *   - pumpfun/pumpswap metadata + 생성 < 10분 = graduation 직후로 추정
 *   - currentPrice 있으면 eventPrice로 사용
 */
export function classifyMigrationCandidate(candidate: MigrationCandidate): MigrationEvent | null {
  const meta = candidate.metadata;
  if (!meta) return null;

  let kind: MigrationEventKind | null = null;
  if (isPumpSwapPool(meta)) {
    kind = 'pumpswap_canonical_init';
    // 실제 pump.fun graduation 과 PumpSwap init 은 별개 이벤트지만, 현재는 단일 kind로 취급.
    // 정확한 구분은 BondingCurve Program log 기반 decode 이후에 가능.
  }

  if (!kind) return null;

  const poolAge = candidate.poolCreatedAtSec != null
    ? candidate.discoveredAtSec - candidate.poolCreatedAtSec
    : 0;
  // Why: Scanner discover 시점의 pool age가 10분 이내일 때만 "migration 직후"로 본다.
  // 이 값은 heuristic. poolCreatedAtSec를 가지고 있지 않으면 0 fallback (즉 항상 fresh 취급).
  const MAX_POOL_AGE_SEC = 600;
  if (poolAge > MAX_POOL_AGE_SEC) return null;

  const eventPrice = candidate.currentPrice ?? 0;
  if (eventPrice <= 0) return null;

  const signature = `migration-${candidate.pairAddress}-${candidate.poolCreatedAtSec ?? candidate.discoveredAtSec}`;
  const event: MigrationEvent = {
    kind,
    pairAddress: candidate.pairAddress,
    tokenSymbol: candidate.tokenSymbol,
    eventPrice,
    eventTimeSec: candidate.poolCreatedAtSec ?? candidate.discoveredAtSec,
    signature,
  };
  log.info(
    `[MIG_DETECT] candidate ${candidate.pairAddress.slice(0, 12)} ` +
    `kind=${kind} eventPrice=${eventPrice.toFixed(8)} poolAge=${poolAge}s`
  );
  return event;
}

/** Reference: Pump.fun graduation program constants — 이후 on-chain decode 시 사용 */
export const PUMP_FUN_BONDING_CURVE_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_SWAP_CANONICAL_PROGRAM = PUMP_SWAP_PROGRAM;
