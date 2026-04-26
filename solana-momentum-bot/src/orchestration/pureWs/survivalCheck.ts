// 2026-04-21 Survival Layer (P0 mission-refinement-2026-04-21):
// pure_ws 진입 전 security + exit liquidity 체크.
//
// 반환 형태는 evaluateSecurityGate 와 유사하지만 sizing multiplier 는 제거 (pure_ws fixed ticket).
// gateCache 재사용 — bootstrap path 에서 이미 populate 된 pair 는 즉시 hit.
//
// 데이터 resolve 실패 (RPC 간헐 / onchainSecurityClient 미구성) 시 config 로 제어:
//  - `pureWsSurvivalAllowDataMissing=true`  → 진입 허용 (observability flag `NO_SECURITY_DATA`)
//  - `pureWsSurvivalAllowDataMissing=false` → 보수적 reject

import { evaluateSecurityGate } from '../../gate/securityGate';
import { config } from '../../utils/config';
import type { BotContext } from '../types';
import { log } from './constants';

export async function checkPureWsSurvival(
  tokenMint: string,
  ctx: BotContext
): Promise<{ approved: boolean; reason?: string; flags: string[] }> {
  // 1) gateCache hit: bootstrap path 에서 populate 된 data 재사용
  const cached = ctx.gateCache?.get(tokenMint);
  let tokenSecurityData = cached?.tokenSecurityData ?? null;
  let exitLiquidityData = cached?.exitLiquidityData ?? null;

  // 2) cache miss — onchainSecurityClient 직접 조회
  if (!cached && ctx.onchainSecurityClient) {
    try {
      const [secData, exitData] = await Promise.all([
        ctx.onchainSecurityClient.getTokenSecurityDetailed(tokenMint),
        ctx.onchainSecurityClient.getExitLiquidity(tokenMint),
      ]);
      tokenSecurityData = secData;
      exitLiquidityData = exitData;
      // cache populate 하여 같은 signal 반복 시 RPC 절약
      ctx.gateCache?.set(tokenMint, {
        tokenSecurityData: secData,
        exitLiquidityData: exitData,
      });
    } catch (err) {
      log.warn(`[PUREWS_SURVIVAL] ${tokenMint.slice(0, 12)} security fetch failed: ${err}`);
      // Phase 6 P2-6: RPC fail 시 stale fallback (≤24h 이내 cached). RPC pressure 방어.
      const stale = ctx.gateCache?.getStaleFallback(tokenMint);
      if (stale) {
        tokenSecurityData = stale.tokenSecurityData;
        exitLiquidityData = stale.exitLiquidityData;
        log.info(
          `[PUREWS_SURVIVAL_STALE_FALLBACK] ${tokenMint.slice(0, 12)} RPC fail, using stale cache`
        );
      }
    }
  }

  // 3) 데이터 자체 없음 (client 미구성 or 조회 실패)
  if (!tokenSecurityData) {
    if (config.pureWsSurvivalAllowDataMissing) {
      return { approved: true, flags: ['NO_SECURITY_DATA'] };
    }
    return {
      approved: false,
      reason: 'security_data_unavailable',
      flags: ['NO_SECURITY_DATA'],
    };
  }

  // 4) evaluateSecurityGate 재사용 — 공유 로직 단일화.
  //    exit liquidity 값은 null 이어도 gate 가 soft handling (reduced sizing).
  //    pure_ws 는 fixed ticket 이므로 sizing 은 무시, approved flag 만 본다.
  const gateResult = evaluateSecurityGate(tokenSecurityData, exitLiquidityData, {
    minExitLiquidityUsd: config.pureWsSurvivalMinExitLiquidityUsd,
    maxTop10HolderPct: config.pureWsSurvivalMaxTop10HolderPct,
    // pure_ws 는 mintable reject 유지 (allowMintableWithReduction=false default).
  });

  return {
    approved: gateResult.approved,
    reason: gateResult.reason,
    flags: gateResult.flags,
  };
}
