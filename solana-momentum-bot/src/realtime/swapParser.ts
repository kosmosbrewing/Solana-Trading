import { LAMPORTS_PER_SOL, ParsedTransactionWithMeta } from '@solana/web3.js';
import {
  METEORA_DAMM_V1_PROGRAM,
  METEORA_DAMM_V2_PROGRAM,
  METEORA_DLMM_PROGRAM,
} from './meteoraPrograms';
import {
  ORCA_WHIRLPOOL_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  parseRaydiumSwapFromLogs,
  RAYDIUM_CLMM_PROGRAM,
  RAYDIUM_ROUTER_PROGRAM,
  RAYDIUM_V4_PROGRAM,
} from './raydiumSwapLogParser';
import {
  isPumpSwapPool,
  PUMP_SWAP_PROGRAM,
} from './pumpSwapParser';
import { ParsedSwap, RealtimePoolMetadata, SwapSide } from './types';

export {
  METEORA_DAMM_V1_PROGRAM,
  METEORA_DAMM_V2_PROGRAM,
  METEORA_DLMM_PROGRAM,
  ORCA_WHIRLPOOL_PROGRAM,
  PUMP_SWAP_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  RAYDIUM_CLMM_PROGRAM,
  RAYDIUM_ROUTER_PROGRAM,
  RAYDIUM_V4_PROGRAM,
};

const SUPPORTED_PROGRAMS = [
  RAYDIUM_V4_PROGRAM,
  RAYDIUM_CLMM_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  ORCA_WHIRLPOOL_PROGRAM,
  PUMP_SWAP_PROGRAM,
  METEORA_DLMM_PROGRAM,
  METEORA_DAMM_V1_PROGRAM,
  METEORA_DAMM_V2_PROGRAM,
];
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
  /meteora/i,
  /dlmm/i,
  /damm/i,
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

interface MintDelta {
  amountRaw: bigint;
  decimals: number;
}

export function tryParseSwapFromLogs(logs: string[], context: SwapParseContext): ParsedSwap | null {
  // Why: PumpSwap log amount fields are raw integer-ish values without reliable decimal context.
  //   runtime에서는 tx instruction decode를 강제해 price/volume 오염을 막는다.
  if (isPumpSwapPool(context.poolMetadata)) {
    return null;
  }

  const parsedRaydium = parseRaydiumSwapFromLogs(logs, context);
  if (parsedRaydium) return parsedRaydium;

  // Why: 메타데이터가 있는 지원 풀은 전용 parser 또는 tx fallback만 신뢰한다.
  // generic log parser는 raw integer 로그를 decimal 보정 없이 읽어 price 오염을 만들 수 있다.
  if (context.poolMetadata) {
    return null;
  }

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
  const meta = tx.meta;
  const metadataAware = meta ? parseFromPoolMetadata(tx, context) : null;
  if (isPumpSwapPool(context.poolMetadata)) {
    // Why: PumpSwap `buy(base_amount_out, max_quote_amount_in, ...)` instruction payload는
    //   user intent (slippage 상/하한)이지 실제 fill 가격이 아니다. offset 8/16에서
    //   priceNative를 만들면 worst-case ≈ expected × (1+s)/(1-s) 로 5×~30× 부풀어
    //   PRICE_ANOMALY_BLOCK 100% 발생 (docs/audits/price-anomaly-ratio-2026-04-08.md).
    //   pre/postTokenBalances delta 기반 parseFromPoolMetadata만 신뢰하고, metadataAware가
    //   null이면 swap을 drop한다 (잘못된 가격으로 ledger를 오염시키는 것보다 누락이 안전).
    return metadataAware;
  }

  if (!meta) return null;
  if (metadataAware) return metadataAware;

  // Why: 추적 대상 풀의 mint 메타데이터가 있는데도 정확한 mint delta를 못 맞춘 경우,
  // largest-delta heuristic은 라우터/부가 transfer를 swap으로 오인할 가능성이 높다.
  if (context.poolMetadata) return null;

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
  return isPumpSwapPool(poolMetadata)
    || poolMetadata?.dexId === 'meteora'
    || poolMetadata?.poolProgram === METEORA_DLMM_PROGRAM
    || poolMetadata?.poolProgram === METEORA_DAMM_V1_PROGRAM
    || poolMetadata?.poolProgram === METEORA_DAMM_V2_PROGRAM
    || poolMetadata?.poolProgram === RAYDIUM_CPMM_PROGRAM;
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

  // Why: PumpSwap (및 유사 SPL-token AMM)에서 한 트랜잭션의 pre/postTokenBalances는
  //   user token ATA와 pool vault 양쪽을 모두 포함한다. 두 side의 delta가 동일 mint 기준
  //   정확히 반대 부호라 전체 합이 0이 되어 sumMintDelta가 null을 반환해왔다 (iter10 초안의
  //   회귀 버그). pool vault만 필터링해 pool 관점 net flow를 구한 뒤, 부호를 뒤집어 user 관점
  //   delta로 변환하면 기존 side 판정 로직을 그대로 재사용할 수 있다. user의 wSOL은 임시
  //   ATA(tx 내 생성/폐쇄)로 tokenBalances에 나타나지 않고 lamports로 처리되므로 pool-owner
  //   filter는 SOL 쪽에서도 (pool vault 단독 → 부호 반전) 일관된 결과를 준다.
  //   non-PumpSwap 풀은 지금까지 log 파서 경로로 커버됐으므로 이 filter를 적용하지 않아
  //   기존 동작을 유지한다.
  const isPumpSwap = isPumpSwapPool(metadata);
  const ownerFilter = isPumpSwap ? context.poolAddress : undefined;

  const baseDelta = sumMintDelta(tx, metadata.baseMint, ownerFilter);
  const quoteDelta = sumMintDelta(tx, metadata.quoteMint, ownerFilter);
  if (baseDelta == null || quoteDelta == null) return null;

  if (baseDelta.amountRaw === 0n || quoteDelta.amountRaw === 0n) return null;

  // pool 관점 → user 관점: owner filter가 적용된 경우에만 부호 반전.
  const baseAmountRaw = isPumpSwap ? -baseDelta.amountRaw : baseDelta.amountRaw;
  const quoteAmountRaw = isPumpSwap ? -quoteDelta.amountRaw : quoteDelta.amountRaw;

  let side: SwapSide | null = null;
  if (baseAmountRaw > 0n && quoteAmountRaw < 0n) {
    side = 'buy';
  } else if (baseAmountRaw < 0n && quoteAmountRaw > 0n) {
    side = 'sell';
  } else {
    return null;
  }

  const baseDecimals = metadata.baseDecimals ?? baseDelta.decimals;
  const quoteDecimals = metadata.quoteDecimals ?? quoteDelta.decimals;
  const amountBase = toUiAmount(absBigInt(baseAmountRaw), baseDecimals);
  const amountQuote = toUiAmount(absBigInt(quoteAmountRaw), quoteDecimals);
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

function sumMintDelta(
  tx: ParsedTransactionWithMeta,
  mint: string,
  ownerFilter?: string
): MintDelta | null {
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  let total = 0n;
  let found = false;
  let decimals: number | null = null;

  for (const balance of pre) {
    if (balance.mint !== mint) continue;
    if (ownerFilter && balance.owner !== ownerFilter) continue;
    const amountRaw = parseRawAmount(balance.uiTokenAmount.amount);
    if (amountRaw == null) continue;
    total -= amountRaw;
    if (decimals == null && Number.isInteger(balance.uiTokenAmount.decimals)) {
      decimals = balance.uiTokenAmount.decimals;
    }
    found = true;
  }
  for (const balance of post) {
    if (balance.mint !== mint) continue;
    if (ownerFilter && balance.owner !== ownerFilter) continue;
    const amountRaw = parseRawAmount(balance.uiTokenAmount.amount);
    if (amountRaw == null) continue;
    total += amountRaw;
    if (decimals == null && Number.isInteger(balance.uiTokenAmount.decimals)) {
      decimals = balance.uiTokenAmount.decimals;
    }
    found = true;
  }

  if (!found || decimals == null) return null;
  return { amountRaw: total, decimals };
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

function parseRawAmount(value: string | undefined): bigint | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function toUiAmount(value: bigint, decimals: number): number {
  return Number(value) / (10 ** decimals);
}
