import { createModuleLogger } from '../utils/logger';
import type { SwapResult } from './executor';

const log = createModuleLogger('LiveSellRetry');

export const LIVE_SELL_IMMEDIATE_RETRY_COUNT = 5;
const DEFAULT_LIVE_SELL_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const;
const HARD_CUT_LIVE_SELL_RETRY_DELAYS_MS = [0, 150, 300, 600, 1_200] as const;
const STRUCTURAL_LIVE_SELL_RETRY_DELAYS_MS = [0, 100, 200, 400, 800] as const;
const DEFAULT_INITIAL_BALANCE_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const;
const DEFAULT_ZERO_BALANCE_CONFIRM_DELAYS_MS = [0, 500] as const;
const DEFAULT_ENTRY_TX_FALLBACK_MAX_AGE_MS = 30_000;

export type LiveSellRetryUrgency = 'normal' | 'hard_cut' | 'structural';

let liveSellRetryDelaysMsByUrgency: Record<LiveSellRetryUrgency, readonly number[]> = {
  normal: DEFAULT_LIVE_SELL_RETRY_DELAYS_MS,
  hard_cut: HARD_CUT_LIVE_SELL_RETRY_DELAYS_MS,
  structural: STRUCTURAL_LIVE_SELL_RETRY_DELAYS_MS,
};
let initialBalanceRetryDelaysMs: readonly number[] = DEFAULT_INITIAL_BALANCE_RETRY_DELAYS_MS;
let zeroBalanceConfirmDelaysMs: readonly number[] = DEFAULT_ZERO_BALANCE_CONFIRM_DELAYS_MS;

export interface LiveSellRetryExecutor {
  executeSell(tokenMint: string, amountRaw: bigint): Promise<SwapResult>;
  getTokenBalance(tokenMint: string): Promise<bigint>;
  getTokenBalanceFromTransaction?(signature: string, tokenMint: string): Promise<bigint | null>;
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

export interface LiveSellInitialBalanceProbe {
  balance: bigint;
  attempts: number;
  source: 'rpc_balance' | 'entry_tx_post_balance' | 'zero_confirmed';
}

export interface LiveSellZeroBalanceConfirmResult {
  confirmedZero: boolean;
  attempts: number;
  zeroConfirmations: number;
  lastBalance: bigint | null;
}

export interface LiveSellInitialBalanceParams {
  executor: LiveSellRetryExecutor;
  tokenMint: string;
  context: string;
  reason: string;
  entryTxSignature?: string;
  entryTimeSec?: number;
  nowMs?: number;
  entryTxFallbackMaxAgeMs?: number;
}

export interface LiveSellZeroBalanceConfirmParams {
  executor: LiveSellRetryExecutor;
  tokenMint: string;
  context: string;
  reason: string;
  minZeroConfirmations?: number;
}

function waitLiveSellRetry(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function resolveLiveSellInitialTokenBalance(
  params: LiveSellInitialBalanceParams
): Promise<LiveSellInitialBalanceProbe> {
  const { executor, tokenMint, context, reason, entryTxSignature } = params;
  const maxAttempts = 1 + initialBalanceRetryDelaysMs.length;
  const nowMs = params.nowMs ?? Date.now();
  const fallbackMaxAgeMs = params.entryTxFallbackMaxAgeMs ?? DEFAULT_ENTRY_TX_FALLBACK_MAX_AGE_MS;
  const entryAgeMs = typeof params.entryTimeSec === 'number'
    ? nowMs - params.entryTimeSec * 1000
    : 0;
  const entryTxFallbackAllowed = entryAgeMs >= 0 && entryAgeMs <= fallbackMaxAgeMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      const delayMs = initialBalanceRetryDelaysMs[attempt - 2] ?? 0;
      await waitLiveSellRetry(delayMs);
    }

    const balance = await executor.getTokenBalance(tokenMint);
    if (balance > 0n) {
      if (attempt > 1) {
        log.warn(
          `[LIVE_SELL_INITIAL_BALANCE_SETTLED] ${context} reason=${reason} ` +
          `attempt=${attempt}/${maxAttempts} balance=${balance.toString()}`
        );
      }
      return { balance, attempts: attempt, source: 'rpc_balance' };
    }

    if (entryTxSignature && executor.getTokenBalanceFromTransaction && entryTxFallbackAllowed) {
      const txBalance = await executor.getTokenBalanceFromTransaction(entryTxSignature, tokenMint);
      if (txBalance != null && txBalance > 0n) {
        log.warn(
          `[LIVE_SELL_INITIAL_BALANCE_TX_FALLBACK] ${context} reason=${reason} ` +
          `attempt=${attempt}/${maxAttempts} rpcBalance=0 txBalance=${txBalance.toString()} ` +
          `entryTx=${entryTxSignature.slice(0, 12)} entryAgeMs=${entryAgeMs}`
        );
        return { balance: txBalance, attempts: attempt, source: 'entry_tx_post_balance' };
      }
    } else if (entryTxSignature && executor.getTokenBalanceFromTransaction && !entryTxFallbackAllowed && attempt === 1) {
      log.warn(
        `[LIVE_SELL_INITIAL_BALANCE_TX_FALLBACK_SKIPPED] ${context} reason=${reason} ` +
        `entryAgeMs=${entryAgeMs} maxAgeMs=${fallbackMaxAgeMs}`
      );
    }

    if (attempt < maxAttempts) {
      log.warn(
        `[LIVE_SELL_INITIAL_BALANCE_RETRY] ${context} reason=${reason} ` +
        `attempt=${attempt}/${maxAttempts} balance=0`
      );
    }
  }

  return { balance: 0n, attempts: maxAttempts, source: 'zero_confirmed' };
}

export async function confirmLiveSellZeroTokenBalance(
  params: LiveSellZeroBalanceConfirmParams
): Promise<LiveSellZeroBalanceConfirmResult> {
  const minZeroConfirmations = Math.max(2, Math.floor(params.minZeroConfirmations ?? 2));
  let zeroConfirmations = 0;
  let lastBalance: bigint | null = null;

  for (let attempt = 1; attempt <= minZeroConfirmations; attempt += 1) {
    const delayMs = zeroBalanceConfirmDelaysMs[attempt - 1] ?? zeroBalanceConfirmDelaysMs[zeroBalanceConfirmDelaysMs.length - 1] ?? 0;
    if (delayMs > 0) {
      await waitLiveSellRetry(delayMs);
    }

    try {
      const balance = await params.executor.getTokenBalance(params.tokenMint);
      lastBalance = balance;
      if (balance !== 0n) {
        log.warn(
          `[LIVE_SELL_ZERO_BALANCE_NOT_CONFIRMED] ${params.context} reason=${params.reason} ` +
          `attempt=${attempt}/${minZeroConfirmations} balance=${balance.toString()}`
        );
        return { confirmedZero: false, attempts: attempt, zeroConfirmations, lastBalance };
      }
      zeroConfirmations += 1;
    } catch (err) {
      log.warn(
        `[LIVE_SELL_ZERO_BALANCE_CONFIRM_FAILED] ${params.context} reason=${params.reason} ` +
        `attempt=${attempt}/${minZeroConfirmations}: ${err}`
      );
      return { confirmedZero: false, attempts: attempt, zeroConfirmations, lastBalance };
    }
  }

  return {
    confirmedZero: zeroConfirmations >= minZeroConfirmations,
    attempts: minZeroConfirmations,
    zeroConfirmations,
    lastBalance,
  };
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
          lastErr = new Error(
            `sell retry balance recovered disabled; balance=${currentBalance.toString()} ` +
            `expectedRemaining=${expectedRemainingBalance.toString()}`
          );
          log.warn(
            `[LIVE_SELL_BALANCE_RECOVERY_SKIPPED] ${context} reason=${reason} ` +
            `attempt=${attempt}/${maxAttempts} balance=${currentBalance.toString()} ` +
            `expectedRemaining=${expectedRemainingBalance.toString()}`
          );
          continue;
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

export function setLiveSellInitialBalanceRetryDelaysMsForTests(delays?: readonly number[]): void {
  initialBalanceRetryDelaysMs = delays ?? DEFAULT_INITIAL_BALANCE_RETRY_DELAYS_MS;
}

export function setLiveSellZeroBalanceConfirmDelaysMsForTests(delays?: readonly number[]): void {
  zeroBalanceConfirmDelaysMs = delays ?? DEFAULT_ZERO_BALANCE_CONFIRM_DELAYS_MS;
}
