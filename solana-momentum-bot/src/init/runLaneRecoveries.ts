// Lane-level OPEN trade recovery (cupsey / migration / pure_ws).
// runRecovery (state-level) 와 분리 — 이쪽은 lane handler 의 in-memory state rehydrate.
// 호출 시점: runRecovery 후, ingester 시작 전. config flag off 면 no-op.

import { Notifier } from '../notifier';
import { recoverCupseyOpenPositions } from '../orchestration/cupseyLaneHandler';
import { recoverMigrationOpenPositions } from '../orchestration/migrationLaneHandler';
import { recoverPureWsOpenPositions } from '../orchestration/pureWsBreakoutHandler';
import type { BotContext } from '../orchestration/types';
import { config } from '../utils/config';

export async function runLaneRecoveries(ctx: BotContext, notifier: Notifier): Promise<void> {
  if (config.cupseyLaneEnabled) {
    const recoveredCupseyCount = await recoverCupseyOpenPositions(ctx);
    if (recoveredCupseyCount > 0) {
      await notifier.sendInfo(
        `Cupsey recovery: ${recoveredCupseyCount} OPEN trades rehydrated from ledger`,
        'recovery'
      ).catch(() => {});
    }
  }

  if (config.migrationLaneEnabled) {
    const recoveredMigrationCount = await recoverMigrationOpenPositions(ctx);
    if (recoveredMigrationCount > 0) {
      await notifier.sendInfo(
        `Migration recovery: ${recoveredMigrationCount} OPEN trades rehydrated from ledger`,
        'recovery'
      ).catch(() => {});
    }
  }

  // Block 3 (2026-04-18): pure_ws_breakout lane recovery
  // Why: stale OPEN ledger 가 자주 남아 텔레그램 노이즈를 유발 — 운영 신호 가치 낮음. log-only.
  if (config.pureWsLaneEnabled) {
    await recoverPureWsOpenPositions(ctx);
  }
}
