import { createModuleLogger } from '../utils/logger';
import type { SwapResult } from './executor';

const log = createModuleLogger('LiveSellRetry');

export const LIVE_SELL_IMMEDIATE_RETRY_COUNT = 5;
const DEFAULT_LIVE_SELL_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const;
const HARD_CUT_LIVE_SELL_RETRY_DELAYS_MS = [0, 150, 300, 600, 1_200] as const;
const STRUCTURAL_LIVE_SELL_RETRY_DELAYS_MS = [0, 100, 200, 400, 800] as const;

export type LiveSellRetryUrgency = 'normal' | 'hard_cut' | 'structural';

let liveSellRetryDelaysMsByUrgency: Record<LiveSellRetryUrgency, readonly number[]> = {
  normal: DEFAULT_LIVE_SELL_RETRY_DELAYS_MS,
  hard_cut: HARD_CUT_LIVE_SELL_RETRY_DELAYS_MS,
  structural: STRUCTURAL_LIVE_SELL_RETRY_DELAYS_MS,
};

export interface LiveSellRetryExecutor {
  executeSell(tokenMint: string, amountRaw: bigint): Promise<SwapResult>;
  getTokenBalance(tokenMint: string): Promise<bigint>;
}

export interface LiveSellRetryExecution {
  sellResult: SwapResult;
  soldRatio: number;
  soldRaw: bigint;
  attempts: number;
  recoveredFromBalanceOnly: boolean;
  urgency: LiveSellRetryUrgency;
}

export interface LiveSellRetryParams {
  executor: LiveSellRetryExecutor;
  tokenMint: string;
  initialTokenBalance: bigint;
  requestedSellAmount: bigint;
  expectedRemainingBalance?: bigint;
  context: string;
  reason: string;
  syntheticSignature: string;
  retryCount?: number;
  urgency?: LiveSellRetryUrgency;
  allowBalanceRecovered?: boolean;
}

function waitLiveSellRetry(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function rawAmountRatio(numerator: bigint, denominator: bigint): number {
  if (numerator <= 0n || denominator <= 0n) return 0;
  const scaled = (numerator * 1_000_000n) / denominator;
  return Math.max(0, Math.min(1, Number(scaled) / 1_000_000));
}

export function liveSellRetryMaxAttempts(retryCount = LIVE_SELL_IMMEDIATE_RETRY_COUNT): number {
  return 1 + Math.max(0, Math.floor(retryCount));
}

function liveSellRetryDelaysFor(urgency: LiveSellRetryUrgency): readonly number[] {
  return liveSellRetryDelaysMsByUrgency[urgency] ?? liveSellRetryDelaysMsByUrgency.normal;
}

export async function executeLiveSellWithImmediateRetries(
  params: LiveSellRetryParams
): Promise<LiveSellRetryExecution> {
  const {
    executor,
    tokenMint,
    initialTokenBalance,
    requestedSellAmount,
    context,
    reason,
    syntheticSignature,
  } = params;
  const allowBalanceRecovered = params.allowBalanceRecovered !== false;
  const urgency = params.urgency ?? 'normal';
  const retryDelaysMs = liveSellRetryDelaysFor(urgency);
  const expectedRemainingBalance = params.expectedRemainingBalance ??
    (initialTokenBalance > requestedSellAmount ? initialTokenBalance - requestedSellAmount : 0n);
  const maxAttempts = liveSellRetryMaxAttempts(params.retryCount);
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let sellAmount = requestedSellAmount;
    let preAttemptBalance = initialTokenBalance;

    if (attempt > 1) {
      const delayMs = retryDelaysMs[attempt - 2] ?? retryDelaysMs[retryDelaysMs.length - 1] ?? 0;
      log.warn(
        `[LIVE_SELL_RETRY] ${context} reason=${reason} ` +
        `urgency=${urgency} attempt=${attempt}/${maxAttempts} delayMs=${delayMs}`
      );
      await waitLiveSellRetry(delayMs);

      const currentBalance = await executor.getTokenBalance(tokenMint);
      if (currentBalance <= expectedRemainingBalance) {
        if (!allowBalanceRecovered) {
          throw new Error(
            `sell retry balance recovered disabled; balance=${currentBalance.toString()} ` +
            `expectedRemaining=${expectedRemainingBalance.toString()}`
          );
        }
        const soldRaw = initialTokenBalance > currentBalance ? initialTokenBalance - currentBalance : 0n;
        const soldRatio = rawAmountRatio(soldRaw, initialTokenBalance);
        log.warn(
          `[LIVE_SELL_BALANCE_RECOVERED] ${context} reason=${reason} ` +
          `attempt=${attempt}/${maxAttempts} balance=${currentBalance.toString()} ` +
          `expectedRemaining=${expectedRemainingBalance.toString()} soldRatio=${soldRatio.toFixed(4)}`
        );
        return {
          sellResult: {
            txSignature: syntheticSignature,
            expectedOutAmount: 0n,
            slippageBps: 0,
          },
          soldRatio,
          soldRaw,
          attempts: attempt,
          recoveredFromBalanceOnly: true,
          urgency,
        };
      }

      preAttemptBalance = currentBalance;
      sellAmount = currentBalance > expectedRemainingBalance
        ? currentBalance - expectedRemainingBalance
        : 0n;
      if (sellAmount <= 0n) {
        throw new Error(`sell retry amount resolved to zero; balance=${currentBalance.toString()}`);
      }
    }

    try {
      const sellResult = await executor.executeSell(tokenMint, sellAmount);
      const expectedPostBalance = preAttemptBalance > sellAmount ? preAttemptBalance - sellAmount : 0n;
      const soldRaw = initialTokenBalance > expectedPostBalance ? initialTokenBalance - expectedPostBalance : 0n;
      const soldRatio = rawAmountRatio(soldRaw, initialTokenBalance);
      return { sellResult, soldRatio, soldRaw, attempts: attempt, recoveredFromBalanceOnly: false, urgency };
    } catch (err) {
      lastErr = err;
      log.warn(
        `[LIVE_SELL_ATTEMPT_FAILED] ${context} reason=${reason} ` +
        `attempt=${attempt}/${maxAttempts}: ${err}`
      );
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function setLiveSellRetryDelaysMsForTests(
  delays?: readonly number[],
  urgency: LiveSellRetryUrgency = 'normal'
): void {
  if (delays == null) {
    liveSellRetryDelaysMsByUrgency = {
      normal: DEFAULT_LIVE_SELL_RETRY_DELAYS_MS,
      hard_cut: HARD_CUT_LIVE_SELL_RETRY_DELAYS_MS,
      structural: STRUCTURAL_LIVE_SELL_RETRY_DELAYS_MS,
    };
    return;
  }
  liveSellRetryDelaysMsByUrgency = {
    ...liveSellRetryDelaysMsByUrgency,
    [urgency]: delays,
  };
}
