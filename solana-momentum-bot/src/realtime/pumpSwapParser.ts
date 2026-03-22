import bs58 from 'bs58';
import { ParsedTransactionWithMeta, PartiallyDecodedInstruction } from '@solana/web3.js';
import { ParsedSwap, RealtimePoolMetadata, SwapSide } from './types';

export const PUMP_SWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const PUMP_SWAP_DEX_IDS = ['pumpswap', 'pumpfun', 'pump-swap'] as const;

const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

interface PumpSwapParseContext {
  poolAddress: string;
  signature: string;
  slot: number;
  timestamp?: number;
  poolMetadata?: RealtimePoolMetadata;
}

export function isPumpSwapDexId(dexId?: string | null): boolean {
  if (!dexId) return false;
  return PUMP_SWAP_DEX_IDS.includes(dexId.toLowerCase() as typeof PUMP_SWAP_DEX_IDS[number]);
}

export function isPumpSwapPool(metadata?: RealtimePoolMetadata): boolean {
  if (!metadata) return false;
  return metadata.poolProgram === PUMP_SWAP_PROGRAM || isPumpSwapDexId(metadata.dexId);
}

export function parsePumpSwapFromLogs(
  logs: string[],
  context: PumpSwapParseContext
): ParsedSwap | null {
  if (!context.poolMetadata || !isPumpSwapPool(context.poolMetadata)) {
    return null;
  }

  const joined = logs.join('\n');
  const side = detectSide(joined);
  const amountBase = parseNumeric(joined, ['base_amount_out', 'base_amount_in', 'base_amount']);
  const amountQuote = parseNumeric(joined, ['quote_amount_out', 'quote_amount_in', 'quote_amount']);
  if (!side || amountBase == null || amountQuote == null || amountBase <= 0 || amountQuote <= 0) {
    return null;
  }

  return {
    pool: context.poolAddress,
    signature: context.signature,
    timestamp: context.timestamp ?? Math.floor(Date.now() / 1000),
    side,
    priceNative: amountQuote / amountBase,
    amountBase,
    amountQuote,
    slot: context.slot,
    dexProgram: PUMP_SWAP_PROGRAM,
    source: 'logs',
  };
}

export function parsePumpSwapFromTransaction(
  tx: ParsedTransactionWithMeta,
  context: PumpSwapParseContext
): ParsedSwap | null {
  if (!context.poolMetadata || !isPumpSwapPool(context.poolMetadata)) {
    return null;
  }

  const instructions = tx.transaction.message.instructions;
  for (const instruction of instructions) {
    const parsed = parsePumpSwapInstruction(instruction, context);
    if (parsed) {
      return {
        ...parsed,
        timestamp: tx.blockTime ?? context.timestamp ?? Math.floor(Date.now() / 1000),
        slot: context.slot,
        signature: context.signature,
        pool: context.poolAddress,
        dexProgram: PUMP_SWAP_PROGRAM,
        source: 'transaction',
      };
    }
  }

  return null;
}

function parsePumpSwapInstruction(
  instruction: ParsedTransactionWithMeta['transaction']['message']['instructions'][number],
  context: PumpSwapParseContext
): Omit<ParsedSwap, 'timestamp' | 'slot' | 'signature' | 'pool' | 'dexProgram' | 'source'> | null {
  if (!('programId' in instruction) || instruction.programId.toBase58() !== PUMP_SWAP_PROGRAM) {
    return null;
  }

  const accounts = (instruction as PartiallyDecodedInstruction).accounts?.map((account) => account.toBase58()) ?? [];
  if (!accounts.includes(context.poolAddress)) {
    return null;
  }

  const rawData = decodeInstructionData((instruction as PartiallyDecodedInstruction).data);
  if (!rawData || rawData.length < 24) {
    return null;
  }

  const side = decodeSide(rawData);
  if (!side) {
    return null;
  }

  const baseRaw = readU64LE(rawData, 8);
  const quoteRaw = readU64LE(rawData, 16);
  if (baseRaw == null || quoteRaw == null || baseRaw <= 0 || quoteRaw <= 0) {
    return null;
  }

  const baseDecimals = context.poolMetadata?.baseDecimals ?? 0;
  const quoteDecimals = context.poolMetadata?.quoteDecimals ?? 0;
  const amountBase = Number(baseRaw) / 10 ** baseDecimals;
  const amountQuote = Number(quoteRaw) / 10 ** quoteDecimals;
  if (!Number.isFinite(amountBase) || !Number.isFinite(amountQuote) || amountBase <= 0 || amountQuote <= 0) {
    return null;
  }

  return {
    side,
    priceNative: amountQuote / amountBase,
    amountBase,
    amountQuote,
  };
}

function decodeInstructionData(data: string): Buffer | null {
  try {
    return Buffer.from(bs58.decode(data));
  } catch {
    return null;
  }
}

function decodeSide(rawData: Buffer): SwapSide | null {
  const discriminator = rawData.subarray(0, 8);
  if (discriminator.equals(BUY_DISCRIMINATOR)) return 'buy';
  if (discriminator.equals(SELL_DISCRIMINATOR)) return 'sell';
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

function detectSide(text: string): SwapSide | null {
  if (/\bbuy\b/i.test(text)) return 'buy';
  if (/\bsell\b/i.test(text)) return 'sell';
  return null;
}

function readU64LE(buffer: Buffer, offset: number): number | null {
  if (buffer.length < offset + 8) return null;
  const value = buffer.readBigUInt64LE(offset);
  const asNumber = Number(value);
  return Number.isSafeInteger(asNumber) ? asNumber : null;
}
