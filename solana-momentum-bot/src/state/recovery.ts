import { createModuleLogger } from '../utils/logger';
import { PositionRecord } from '../utils/types';
import { PositionStore } from './positionStore';

const log = createModuleLogger('Recovery');

export interface RecoveryDeps {
  positionStore: PositionStore;
  getTokenBalance: (pairAddress: string) => Promise<bigint>;
  getCurrentPrice: (pairAddress: string) => Promise<number | null>;
}

export interface RecoveryResult {
  recovered: number;
  closed: number;
  failed: number;
  details: string[];
}

/**
 * 재시작 복구 프로토콜
 * 1. DB에서 OPEN 포지션 조회
 * 2. 온체인 잔고 확인
 * 3. 잔고 있음 → 복구, 잔고 없음 → 보정
 */
export async function runRecovery(deps: RecoveryDeps): Promise<RecoveryResult> {
  const result: RecoveryResult = { recovered: 0, closed: 0, failed: 0, details: [] };

  const openPositions = await deps.positionStore.getOpenPositions();
  if (openPositions.length === 0) {
    log.info('No open positions to recover');
    return result;
  }

  log.info(`Found ${openPositions.length} open position(s) to recover`);

  for (const pos of openPositions) {
    try {
      await recoverPosition(pos, deps, result);
    } catch (error) {
      result.failed++;
      const msg = `Failed to recover position ${pos.id}: ${error}`;
      log.error(msg);
      result.details.push(msg);
    }
  }

  log.info(
    `Recovery complete: ${result.recovered} recovered, ${result.closed} closed, ${result.failed} failed`
  );
  return result;
}

async function recoverPosition(
  pos: PositionRecord,
  deps: RecoveryDeps,
  result: RecoveryResult
): Promise<void> {
  // ORDER_SUBMITTED — 온체인 확인 필요
  if (pos.state === 'ORDER_SUBMITTED') {
    const balance = await deps.getTokenBalance(pos.pairAddress);
    if (balance > 0n) {
      // 체결됨 — ENTRY_CONFIRMED로 전환
      await deps.positionStore.updateState(pos.id, 'ENTRY_CONFIRMED');
      result.recovered++;
      result.details.push(`Position ${pos.id}: ORDER_SUBMITTED → ENTRY_CONFIRMED (on-chain balance found)`);
    } else {
      // 미체결 — 무시 (IDLE)
      await deps.positionStore.updateState(pos.id, 'ORDER_FAILED');
      result.closed++;
      result.details.push(`Position ${pos.id}: ORDER_SUBMITTED → ORDER_FAILED (no on-chain balance)`);
    }
    return;
  }

  // ENTRY_CONFIRMED / MONITORING — 잔고 확인 후 복구
  if (pos.state === 'ENTRY_CONFIRMED' || pos.state === 'MONITORING' || pos.state === 'SIGNAL_DETECTED') {
    const balance = await deps.getTokenBalance(pos.pairAddress);
    if (balance > 0n) {
      // 포지션 존재 — SL/TP 재설정
      const currentPrice = await deps.getCurrentPrice(pos.pairAddress);
      if (currentPrice && pos.entryPrice) {
        await deps.positionStore.updateState(pos.id, 'MONITORING');
        result.recovered++;
        result.details.push(
          `Position ${pos.id}: ${pos.state} → MONITORING (balance found, current price: ${currentPrice})`
        );
      } else {
        await deps.positionStore.updateState(pos.id, 'MONITORING');
        result.recovered++;
        result.details.push(`Position ${pos.id}: ${pos.state} → MONITORING (balance found, no price data)`);
      }
    } else {
      // 이미 청산됨
      await deps.positionStore.updateState(pos.id, 'EXIT_CONFIRMED', {
        exitReason: 'RECOVERED_CLOSED',
      });
      result.closed++;
      result.details.push(`Position ${pos.id}: ${pos.state} → EXIT_CONFIRMED (no on-chain balance)`);
    }
    return;
  }

  // EXIT_TRIGGERED — 청산 tx 재시도 필요
  if (pos.state === 'EXIT_TRIGGERED') {
    const balance = await deps.getTokenBalance(pos.pairAddress);
    if (balance > 0n) {
      result.recovered++;
      result.details.push(`Position ${pos.id}: EXIT_TRIGGERED — balance still exists, needs re-sell`);
    } else {
      await deps.positionStore.updateState(pos.id, 'EXIT_CONFIRMED', {
        exitReason: 'RECOVERED_CLOSED',
      });
      result.closed++;
      result.details.push(`Position ${pos.id}: EXIT_TRIGGERED → EXIT_CONFIRMED (already sold)`);
    }
  }
}
