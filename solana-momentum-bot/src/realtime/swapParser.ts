import { LAMPORTS_PER_SOL, ParsedTransactionWithMeta } from '@solana/web3.js';
import {
  ORCA_WHIRLPOOL_PROGRAM,
  parseRaydiumSwapFromLogs,
  RAYDIUM_CLMM_PROGRAM,
  RAYDIUM_ROUTER_PROGRAM,
  RAYDIUM_V4_PROGRAM,
} from './raydiumSwapLogParser';
import { ParsedSwap, RealtimePoolMetadata, SwapSide } from './types';

export { ORCA_WHIRLPOOL_PROGRAM, RAYDIUM_CLMM_PROGRAM, RAYDIUM_ROUTER_PROGRAM, RAYDIUM_V4_PROGRAM };

const SUPPORTED_PROGRAMS = [RAYDIUM_V4_PROGRAM, RAYDIUM_CLMM_PROGRAM, ORCA_WHIRLPOOL_PROGRAM];
const FALLBACK_PROGRAM_HINTS = [...SUPPORTED_PROGRAMS, RAYDIUM_ROUTER_PROGRAM];
const FALLBACK_SWAP_PATTERNS = [
  /process_swap_/i,
  /routeswapbase(?:in|out)args/i,
  /instruction:\s*swap/i,
  /instruction:\s*two_hop_swap/i,
  /ray_log:/i,
  /swap event/i,
];

interface SwapParseContext {
  poolAddress: string;
  signature: string;
  slot: number;
  timestamp?: number;
  poolMetadata?: RealtimePoolMetadata;
}

interface BalanceDelta {
  amount: number;
}

export function tryParseSwapFromLogs(logs: string[], context: SwapParseContext): ParsedSwap | null {
  const parsedRaydium = parseRaydiumSwapFromLogs(logs, context);
  if (parsedRaydium) return parsedRaydium;

  const joined = logs.join('\n');
  const side = parseSide(joined);
  const amountBase = parseNumeric(joined, ['base_amount', 'amount_in', 'token_in', 'amount_base']);
  const amountQuote = parseNumeric(joined, ['quote_amount', 'amount_out', 'token_out', 'amount_quote']);
  const priceNative = parseNumeric(joined, ['price_native', 'price', 'execution_price']);
  if (!side || amountBase == null || amountQuote == null) return null;

  const resolvedPrice = priceNative ?? amountQuote / amountBase;
  if (!Number.isFinite(resolvedPrice) || resolvedPrice <= 0) return null;

  return {
    pool: context.poolAddress,
    signature: context.signature,
    timestamp: context.timestamp ?? Math.floor(Date.now() / 1000),
    side,
    priceNative: resolvedPrice,
    amountBase,
    amountQuote,
    slot: context.slot,
    dexProgram: detectProgram(logs),
    source: 'logs',
  };
}

export function parseSwapFromTransaction(
  tx: ParsedTransactionWithMeta,
  context: SwapParseContext
): ParsedSwap | null {
  const meta = tx.meta;
  if (!meta) return null;

  const tokenDelta = pickLargestTokenDelta(tx);
  const nativeQuote = pickLargestLamportDelta(tx);
  const timestamp = tx.blockTime ?? context.timestamp ?? Math.floor(Date.now() / 1000);

  if (tokenDelta && nativeQuote) {
    const side: SwapSide = nativeQuote.amount < 0 ? 'buy' : 'sell';
    const amountBase = Math.abs(tokenDelta.amount);
    const amountQuote = Math.abs(nativeQuote.amount);
    if (amountBase > 0 && amountQuote > 0) {
      return {
        pool: context.poolAddress,
        signature: context.signature,
        timestamp,
        side,
        priceNative: amountQuote / amountBase,
        amountBase,
        amountQuote,
        slot: context.slot,
        dexProgram: detectProgram(meta.logMessages ?? []),
        source: 'transaction',
      };
    }
  }

  const tokenDeltas = collectTokenDeltas(tx);
  const positive = tokenDeltas.find((delta) => delta.amount > 0);
  const negative = tokenDeltas.find((delta) => delta.amount < 0);
  if (!positive || !negative) return null;

  const amountBase = Math.abs(positive.amount);
  const amountQuote = Math.abs(negative.amount);
  if (amountBase <= 0 || amountQuote <= 0) return null;

  return {
    pool: context.poolAddress,
    signature: context.signature,
    timestamp,
    side: 'buy',
    priceNative: amountQuote / amountBase,
    amountBase,
    amountQuote,
    slot: context.slot,
    dexProgram: detectProgram(meta.logMessages ?? []),
    source: 'transaction',
  };
}

export function shouldFallbackToTransaction(logs: string[]): boolean {
  const joined = logs.join('\n');
  return FALLBACK_PROGRAM_HINTS.some((program) => joined.includes(program))
    || FALLBACK_SWAP_PATTERNS.some((pattern) => pattern.test(joined));
}

function detectProgram(logs: string[]): string | undefined {
  return FALLBACK_PROGRAM_HINTS.find((program) => logs.some((line) => line.includes(program)));
}

function parseSide(text: string): SwapSide | null {
  if (/\bside\s*[:=]\s*buy\b/i.test(text) || /\bbuy\b/i.test(text)) return 'buy';
  if (/\bside\s*[:=]\s*sell\b/i.test(text) || /\bsell\b/i.test(text)) return 'sell';
  return null;
}

function parseNumeric(text: string, keys: string[]): number | null {
  for (const key of keys) {
    const match = text.match(new RegExp(`${key}\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?)`, 'i'));
    if (!match) continue;
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed)) return Math.abs(parsed);
  }
  return null;
}

function pickLargestTokenDelta(tx: ParsedTransactionWithMeta): BalanceDelta | null {
  return collectTokenDeltas(tx)[0] ?? null;
}

function collectTokenDeltas(tx: ParsedTransactionWithMeta): BalanceDelta[] {
  const deltas = new Map<string, number>();
  for (const balance of tx.meta?.preTokenBalances ?? []) {
    deltas.set(
      `${balance.accountIndex}:${balance.mint}`,
      -(Number(balance.uiTokenAmount.uiAmountString ?? balance.uiTokenAmount.uiAmount ?? 0))
    );
  }
  for (const balance of tx.meta?.postTokenBalances ?? []) {
    const key = `${balance.accountIndex}:${balance.mint}`;
    deltas.set(
      key,
      (deltas.get(key) ?? 0) + Number(balance.uiTokenAmount.uiAmountString ?? balance.uiTokenAmount.uiAmount ?? 0)
    );
  }

  return [...deltas.values()]
    .filter((amount) => Number.isFinite(amount) && Math.abs(amount) > 0)
    .map((amount) => ({ amount }))
    .sort((left, right) => Math.abs(right.amount) - Math.abs(left.amount));
}

function pickLargestLamportDelta(tx: ParsedTransactionWithMeta): BalanceDelta | null {
  const preBalances = tx.meta?.preBalances ?? [];
  const postBalances = tx.meta?.postBalances ?? [];
  let best: BalanceDelta | null = null;

  for (let index = 0; index < Math.min(preBalances.length, postBalances.length); index++) {
    const amount = (postBalances[index] - preBalances[index]) / LAMPORTS_PER_SOL;
    if (!Number.isFinite(amount) || amount === 0) continue;
    if (!best || Math.abs(amount) > Math.abs(best.amount)) {
      best = { amount };
    }
  }

  return best;
}
