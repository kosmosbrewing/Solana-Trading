import { LAMPORTS_PER_SOL, ParsedTransactionWithMeta } from '@solana/web3.js';
import {
  ORCA_WHIRLPOOL_PROGRAM,
  parseRaydiumSwapFromLogs,
  RAYDIUM_CLMM_PROGRAM,
  RAYDIUM_ROUTER_PROGRAM,
  RAYDIUM_V4_PROGRAM,
} from './raydiumSwapLogParser';
import {
  isPumpSwapPool,
  parsePumpSwapFromLogs,
  parsePumpSwapFromTransaction,
  PUMP_SWAP_PROGRAM,
} from './pumpSwapParser';
import { ParsedSwap, RealtimePoolMetadata, SwapSide } from './types';

export {
  ORCA_WHIRLPOOL_PROGRAM,
  PUMP_SWAP_PROGRAM,
  RAYDIUM_CLMM_PROGRAM,
  RAYDIUM_ROUTER_PROGRAM,
  RAYDIUM_V4_PROGRAM,
};

const SUPPORTED_PROGRAMS = [RAYDIUM_V4_PROGRAM, RAYDIUM_CLMM_PROGRAM, ORCA_WHIRLPOOL_PROGRAM, PUMP_SWAP_PROGRAM];
const FALLBACK_PROGRAM_HINTS = [...SUPPORTED_PROGRAMS, RAYDIUM_ROUTER_PROGRAM];
const FALLBACK_SWAP_PATTERNS = [
  /process_swap_/i,
  /routeswapbase(?:in|out)args/i,
  /instruction:\s*swap/i,
  /instruction:\s*two_hop_swap/i,
  /ray_log:/i,
  /swap event/i,
  /pumpswap/i,
  /pumpfun/i,
];
const PUMP_SWAP_FALLBACK_NOISE_PATTERNS = [
  /no arbitrage/i,
  /is_cashback_coin=false/i,
];
const PUMP_SWAP_FALLBACK_HINT_PATTERNS = [
  /program log:\s*pi:/i,
  /instruction:\s*swap/i,
  /swap event/i,
  /pumpswap/i,
  /pumpfun/i,
];
const PUMP_SWAP_FALLBACK_HINT_PROGRAMS = [
  PUMP_SWAP_PROGRAM,
  'DDsnwb7dxKSjzTYDFjU8F6rpYNZa1sp7Fmfb2nGDAMEo',
  'FsU1rcaEC361jBr9JE5wm7bpWRSTYeAMN4R2MCs11rNF',
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
  const parsedPump = parsePumpSwapFromLogs(logs, context);
  if (parsedPump) return parsedPump;

  const parsedRaydium = parseRaydiumSwapFromLogs(logs, context);
  if (parsedRaydium) return parsedRaydium;

  const joined = logs.join('\n');
  const side = parseSide(joined);
  const priceNative = parseNumeric(joined, ['price_native', 'price', 'execution_price']);

  // Why: amount_in/amount_out은 트레이더 관점 레이블 (내가 넣는 것/받는 것).
  //   BUY:  amount_in = SOL(quote), amount_out = tokens(base)
  //   SELL: amount_in = tokens(base), amount_out = SOL(quote)
  // base_amount / amount_base 등 명시적 레이블은 방향 무관하게 그대로 사용.
  const amountIn  = parseNumeric(joined, ['amount_in',  'token_in']);
  const amountOut = parseNumeric(joined, ['amount_out', 'token_out']);
  const amountBase = parseNumeric(joined, ['base_amount', 'amount_base'])
    ?? (side === 'buy' ? amountOut : amountIn);
  const amountQuote = parseNumeric(joined, ['quote_amount', 'amount_quote'])
    ?? (side === 'buy' ? amountIn : amountOut);

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
  const parsedPump = parsePumpSwapFromTransaction(tx, context);
  if (parsedPump) return parsedPump;

  const meta = tx.meta;
  if (!meta) return null;

  const metadataAware = parseFromPoolMetadata(tx, context);
  if (metadataAware) return metadataAware;

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

export function shouldForceFallbackToTransaction(poolMetadata?: RealtimePoolMetadata): boolean {
  return isPumpSwapPool(poolMetadata);
}

export function isLikelyPumpSwapFallbackLog(logs: string[]): boolean {
  const joined = logs.join('\n');
  if (PUMP_SWAP_FALLBACK_NOISE_PATTERNS.some((pattern) => pattern.test(joined))) {
    return false;
  }
  return PUMP_SWAP_FALLBACK_HINT_PATTERNS.some((pattern) => pattern.test(joined))
    || PUMP_SWAP_FALLBACK_HINT_PROGRAMS.some((program) => joined.includes(program));
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

function parseFromPoolMetadata(
  tx: ParsedTransactionWithMeta,
  context: SwapParseContext
): ParsedSwap | null {
  const metadata = context.poolMetadata;
  if (!metadata) return null;

  const baseDelta = sumMintDelta(tx, metadata.baseMint);
  const quoteDelta = sumMintDelta(tx, metadata.quoteMint);
  if (baseDelta == null || quoteDelta == null) return null;

  const epsilon = 1e-12;
  if (Math.abs(baseDelta) <= epsilon || Math.abs(quoteDelta) <= epsilon) return null;

  let side: SwapSide | null = null;
  if (baseDelta > epsilon && quoteDelta < -epsilon) {
    side = 'buy';
  } else if (baseDelta < -epsilon && quoteDelta > epsilon) {
    side = 'sell';
  } else {
    return null;
  }

  const amountBase = Math.abs(baseDelta);
  const amountQuote = Math.abs(quoteDelta);
  if (amountBase <= 0 || amountQuote <= 0) return null;

  return {
    pool: context.poolAddress,
    signature: context.signature,
    timestamp: tx.blockTime ?? context.timestamp ?? Math.floor(Date.now() / 1000),
    side,
    priceNative: amountQuote / amountBase,
    amountBase,
    amountQuote,
    slot: context.slot,
    dexProgram: metadata.poolProgram ?? detectProgram(tx.meta?.logMessages ?? []),
    source: 'transaction',
  };
}

function sumMintDelta(tx: ParsedTransactionWithMeta, mint: string): number | null {
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  let total = 0;
  let found = false;

  for (const balance of pre) {
    if (balance.mint !== mint) continue;
    total -= Number(balance.uiTokenAmount.uiAmountString ?? balance.uiTokenAmount.uiAmount ?? 0);
    found = true;
  }
  for (const balance of post) {
    if (balance.mint !== mint) continue;
    total += Number(balance.uiTokenAmount.uiAmountString ?? balance.uiTokenAmount.uiAmount ?? 0);
    found = true;
  }

  return found ? total : null;
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
