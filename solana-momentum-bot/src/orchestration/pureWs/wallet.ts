// Lane wallet routing. Block 1 (2026-04-18) 의 명시적 wallet ownership.
// 기본은 sandbox executor 가 있으면 sandbox, 없으면 main (backward compat).

import { config } from '../../utils/config';
import type { BotContext } from '../types';

export function getPureWsExecutor(ctx: BotContext) {
  const mode = config.pureWsLaneWalletMode;
  if (mode === 'main') return ctx.executor;
  if (mode === 'sandbox') {
    if (!ctx.sandboxExecutor) {
      throw new Error(
        `PUREWS_WALLET_MODE=sandbox but sandboxExecutor not initialized. ` +
        `Check SANDBOX_WALLET_PRIVATE_KEY and STRATEGY_D_LIVE_ENABLED.`
      );
    }
    return ctx.sandboxExecutor;
  }
  return ctx.sandboxExecutor ?? ctx.executor;
}

export function resolvePureWsWalletLabel(ctx: BotContext): 'main' | 'sandbox' {
  const mode = config.pureWsLaneWalletMode;
  if (mode === 'main') return 'main';
  if (mode === 'sandbox') return 'sandbox';
  return ctx.sandboxExecutor ? 'sandbox' : 'main';
}
