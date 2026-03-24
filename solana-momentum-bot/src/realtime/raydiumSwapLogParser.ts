import { createHash } from 'crypto';
import { PublicKey } from '@solana/web3.js';
import { SOL_MINT } from '../utils/constants';
import { ParsedSwap, RealtimePoolMetadata, SwapSide } from './types';

export const RAYDIUM_V4_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
export const RAYDIUM_CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
export const RAYDIUM_CPMM_PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
export const ORCA_WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
export const RAYDIUM_ROUTER_PROGRAM = 'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS';

const CLMM_SWAP_EVENT_DISCRIMINATOR = createHash('sha256')
  .update('event:SwapEvent')
  .digest()
  .subarray(0, 8);

interface RaydiumSwapParseContext {
  poolAddress: string;
  signature: string;
  slot: number;
  timestamp?: number;
  poolMetadata?: RealtimePoolMetadata;
}

export function parseRaydiumSwapFromLogs(
  logs: string[],
  context: RaydiumSwapParseContext
): ParsedSwap | null {
  const poolProgram = context.poolMetadata?.poolProgram;
  if (poolProgram === RAYDIUM_V4_PROGRAM) {
    return parseV4SwapFromLogs(logs, context);
  }
  if (poolProgram === RAYDIUM_CLMM_PROGRAM) {
    return parseClmmSwapFromLogs(logs, context);
  }
  return null;
}

function parseV4SwapFromLogs(
  logs: string[],
  context: RaydiumSwapParseContext
): ParsedSwap | null {
  const rayLog = [...logs].reverse().find((line) => line.includes('ray_log:'));
  const encoded = rayLog?.match(/ray_log:\s*([A-Za-z0-9+/=]+)/)?.[1];
  const decoded = encoded ? decodeV4SwapLog(encoded) : null;
  if (!decoded || !context.poolMetadata) return null;

  const baseDecimals = context.poolMetadata.baseDecimals;
  const quoteDecimals = context.poolMetadata.quoteDecimals
    ?? (context.poolMetadata.quoteMint === SOL_MINT ? 9 : undefined);
  if (baseDecimals == null || quoteDecimals == null) return null;

  let side: SwapSide;
  let amountBaseRaw: number;
  let amountQuoteRaw: number;
  if (decoded.direction === 1) {
    side = 'buy';
    amountBaseRaw = decoded.amountOut;
    amountQuoteRaw = decoded.amountIn;
  } else if (decoded.direction === 2) {
    side = 'sell';
    amountBaseRaw = decoded.amountIn;
    amountQuoteRaw = decoded.amountOut;
  } else {
    return null;
  }

  return buildParsedSwap(context, side, amountBaseRaw / (10 ** baseDecimals), amountQuoteRaw / (10 ** quoteDecimals), RAYDIUM_V4_PROGRAM);
}

function parseClmmSwapFromLogs(
  logs: string[],
  context: RaydiumSwapParseContext
): ParsedSwap | null {
  const metadata = context.poolMetadata;
  if (!metadata) return null;

  const encoded = [...logs]
    .reverse()
    .find((line) => line.startsWith('Program data: '))
    ?.slice('Program data: '.length);
  const event = encoded ? decodeClmmSwapEvent(encoded) : null;
  if (!event) return null;

  const tokenMints = sortMints(metadata.baseMint, metadata.quoteMint);
  if (!tokenMints) return null;

  const token0Mint = tokenMints[0];
  const token1Mint = tokenMints[1];
  const token0Decimals = token0Mint === metadata.baseMint
    ? metadata.baseDecimals
    : metadata.quoteDecimals ?? (metadata.quoteMint === SOL_MINT ? 9 : undefined);
  const token1Decimals = token1Mint === metadata.baseMint
    ? metadata.baseDecimals
    : metadata.quoteDecimals ?? (metadata.quoteMint === SOL_MINT ? 9 : undefined);
  if (token0Decimals == null || token1Decimals == null) return null;

  const inputMint = event.zeroForOne ? token0Mint : token1Mint;
  const outputMint = event.zeroForOne ? token1Mint : token0Mint;
  const inputAmount = event.zeroForOne ? event.amount0 : event.amount1;
  const outputAmount = event.zeroForOne ? event.amount1 : event.amount0;

  if (inputMint === metadata.quoteMint && outputMint === metadata.baseMint) {
    return buildParsedSwap(
      context,
      'buy',
      outputAmount / (10 ** metadata.baseDecimals!),
      inputAmount / (10 ** (metadata.quoteDecimals ?? 9)),
      RAYDIUM_CLMM_PROGRAM
    );
  }
  if (inputMint === metadata.baseMint && outputMint === metadata.quoteMint) {
    return buildParsedSwap(
      context,
      'sell',
      inputAmount / (10 ** metadata.baseDecimals!),
      outputAmount / (10 ** (metadata.quoteDecimals ?? 9)),
      RAYDIUM_CLMM_PROGRAM
    );
  }

  return null;
}

function buildParsedSwap(
  context: RaydiumSwapParseContext,
  side: SwapSide,
  amountBase: number,
  amountQuote: number,
  dexProgram: string
): ParsedSwap | null {
  const priceNative = amountQuote / amountBase;
  if (!Number.isFinite(amountBase) || !Number.isFinite(amountQuote) || !Number.isFinite(priceNative)) {
    return null;
  }
  if (amountBase <= 0 || amountQuote <= 0 || priceNative <= 0) return null;

  return {
    pool: context.poolAddress,
    signature: context.signature,
    timestamp: context.timestamp ?? Math.floor(Date.now() / 1000),
    side,
    priceNative,
    amountBase,
    amountQuote,
    slot: context.slot,
    dexProgram,
    source: 'logs',
  };
}

function decodeV4SwapLog(encoded: string): { amountIn: number; amountOut: number; direction: number } | null {
  try {
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length !== 57) return null;
    const logType = bytes.readUInt8(0);
    if (logType === 3) {
      return { amountIn: Number(bytes.readBigUInt64LE(1)), direction: Number(bytes.readBigUInt64LE(17)), amountOut: Number(bytes.readBigUInt64LE(49)) };
    }
    if (logType === 4) {
      return { amountIn: Number(bytes.readBigUInt64LE(49)), direction: Number(bytes.readBigUInt64LE(17)), amountOut: Number(bytes.readBigUInt64LE(9)) };
    }
    return null;
  } catch {
    return null;
  }
}

function decodeClmmSwapEvent(encoded: string): { amount0: number; amount1: number; zeroForOne: boolean } | null {
  try {
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length < 169) return null;
    if (!bytes.subarray(0, 8).equals(CLMM_SWAP_EVENT_DISCRIMINATOR)) return null;
    return {
      amount0: Number(bytes.readBigUInt64LE(136)),
      amount1: Number(bytes.readBigUInt64LE(152)),
      zeroForOne: bytes.readUInt8(168) === 1,
    };
  } catch {
    return null;
  }
}

function sortMints(firstMint: string, secondMint: string): [string, string] | null {
  try {
    const first = new PublicKey(firstMint).toBuffer();
    const second = new PublicKey(secondMint).toBuffer();
    return Buffer.compare(first, second) <= 0
      ? [firstMint, secondMint]
      : [secondMint, firstMint];
  } catch {
    return null;
  }
}
