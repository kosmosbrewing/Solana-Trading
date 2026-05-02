import { readFile } from 'fs/promises';
import type { PureWsBotflowMayhemLifecycle, PureWsBotflowPairContext } from './pureWsBotflowTypes';

export interface BotflowContextRow {
  tokenMint?: string;
  pairAddress?: string;
  poolAddress?: string;
  samplePair?: string;
  dexId?: string;
  pairCreatedAt?: number | string;
  pairCreatedAtMs?: number;
  observedAt?: string;
  recordedAt?: string;
  riskFlags?: string[];
  reason?: string;
  resolvedPairsCount?: number;
  admissionPairsCount?: number;
  creatorAddress?: string;
  devWallet?: string;
  firstLpProvider?: string;
  operatorDevStatus?: string;
  isMayhemMode?: boolean | string;
  mayhemMode?: boolean | string;
  mayhemEnabled?: boolean | string;
  mayhemAgentWalletSeen?: boolean | string;
  mayhemProgramSeen?: boolean | string;
  mayhemLifecycle?: PureWsBotflowMayhemLifecycle;
}

export interface PureWsBotflowContextMaps {
  pairContextByMint: Map<string, PureWsBotflowPairContext>;
  securityFlagsByMint: Map<string, string[]>;
  qualityFlagsByMint: Map<string, string[]>;
  sourceRowCounts: {
    pairRows: number;
    tokenQualityRows: number;
    admissionRows: number;
  };
}

export interface LoadPureWsBotflowContextOptions {
  pairContextFile?: string;
  tokenQualityFile?: string;
  admissionFile?: string;
}

export async function loadPureWsBotflowContext(
  options: LoadPureWsBotflowContextOptions,
): Promise<PureWsBotflowContextMaps> {
  const [pairRows, tokenQualityRows, admissionRows] = await Promise.all([
    readJsonlFile(options.pairContextFile),
    readJsonlFile(options.tokenQualityFile),
    readJsonlFile(options.admissionFile),
  ]);
  return buildPureWsBotflowContext({ pairRows, tokenQualityRows, admissionRows });
}

export function buildPureWsBotflowContext(input: {
  pairRows?: BotflowContextRow[];
  tokenQualityRows?: BotflowContextRow[];
  admissionRows?: BotflowContextRow[];
}): PureWsBotflowContextMaps {
  const pairContextByMint = new Map<string, PureWsBotflowPairContext>();
  const securityFlagsByMint = new Map<string, string[]>();
  const qualityFlagsByMint = new Map<string, string[]>();

  for (const row of input.pairRows ?? []) mergeContext(pairContextByMint, normalizePairContext(row, ['PAIR_CONTEXT_FILE']));
  for (const row of input.tokenQualityRows ?? []) {
    const flags = row.riskFlags ?? [];
    appendFlags(securityFlagsByMint, row.tokenMint, flags.filter(isSecurityFlag));
    appendFlags(qualityFlagsByMint, row.tokenMint, [
      ...flags.filter((flag) => !isSecurityFlag(flag)),
      ...devFlags(row),
      'TOKEN_QUALITY_CONTEXT',
    ]);
    mergeContext(pairContextByMint, normalizePairContext(row, ['TOKEN_QUALITY_CONTEXT']));
  }
  for (const row of input.admissionRows ?? []) {
    const reasonFlag = row.reason ? `ADMISSION_${flagSegment(row.reason)}` : 'ADMISSION_CONTEXT';
    appendFlags(qualityFlagsByMint, row.tokenMint, [reasonFlag]);
    mergeContext(pairContextByMint, normalizeAdmissionContext(row, reasonFlag));
  }

  return {
    pairContextByMint,
    securityFlagsByMint,
    qualityFlagsByMint,
    sourceRowCounts: {
      pairRows: input.pairRows?.length ?? 0,
      tokenQualityRows: input.tokenQualityRows?.length ?? 0,
      admissionRows: input.admissionRows?.length ?? 0,
    },
  };
}

async function readJsonlFile(filePath: string | undefined): Promise<BotflowContextRow[]> {
  if (!filePath) return [];
  try {
    const raw = await readFile(filePath, 'utf8');
    return raw.split('\n').map((line) => line.trim()).filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line) as BotflowContextRow];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function normalizePairContext(row: BotflowContextRow, flags: string[]): PureWsBotflowPairContext | null {
  if (!row.tokenMint) return null;
  const pairAddress = row.pairAddress ?? row.poolAddress ?? row.samplePair;
  return {
    tokenMint: row.tokenMint,
    pairAddress,
    poolAddress: row.poolAddress ?? pairAddress,
    dexId: row.dexId || undefined,
    pairCreatedAtMs: parseTimeMs(row.pairCreatedAtMs ?? row.pairCreatedAt),
    contextObservedAtMs: parseTimeMs(row.observedAt ?? row.recordedAt),
    knownPoolCount: pairAddress ? 1 : undefined,
    mayhemMode: parseOptionalBool(row.isMayhemMode ?? row.mayhemMode ?? row.mayhemEnabled),
    mayhemAgentWalletSeen: parseOptionalBool(row.mayhemAgentWalletSeen),
    mayhemProgramSeen: parseOptionalBool(row.mayhemProgramSeen),
    mayhemLifecycle: parseMayhemLifecycle(row.mayhemLifecycle),
    securityFlags: row.riskFlags?.filter(isSecurityFlag),
    qualityFlags: flags,
  };
}

function normalizeAdmissionContext(row: BotflowContextRow, reasonFlag: string): PureWsBotflowPairContext | null {
  const ctx = normalizePairContext(row, [reasonFlag]);
  if (!ctx) return null;
  const knownPoolCount = row.admissionPairsCount ?? row.resolvedPairsCount ?? ctx.knownPoolCount ?? 0;
  return {
    ...ctx,
    knownPoolCount,
    poolPrewarmSuccess: knownPoolCount > 0 && row.reason !== 'no_pairs' && row.reason !== 'no_pair',
    poolPrewarmSkipReason: row.reason,
  };
}

function mergeContext(target: Map<string, PureWsBotflowPairContext>, next: PureWsBotflowPairContext | null): void {
  if (!next) return;
  const prev = target.get(next.tokenMint);
  target.set(next.tokenMint, {
    tokenMint: next.tokenMint,
    pairAddress: next.pairAddress ?? prev?.pairAddress,
    poolAddress: next.poolAddress ?? prev?.poolAddress,
    dexId: next.dexId ?? prev?.dexId,
    pairCreatedAtMs: minDefined(prev?.pairCreatedAtMs, next.pairCreatedAtMs),
    contextObservedAtMs: maxDefined(prev?.contextObservedAtMs, next.contextObservedAtMs),
    knownPoolCount: Math.max(prev?.knownPoolCount ?? 0, next.knownPoolCount ?? 0),
    poolPrewarmSuccess: next.poolPrewarmSuccess ?? prev?.poolPrewarmSuccess,
    poolPrewarmSkipReason: next.poolPrewarmSkipReason ?? prev?.poolPrewarmSkipReason,
    mayhemMode: next.mayhemMode ?? prev?.mayhemMode,
    mayhemAgentWalletSeen: Boolean(prev?.mayhemAgentWalletSeen || next.mayhemAgentWalletSeen),
    mayhemProgramSeen: Boolean(prev?.mayhemProgramSeen || next.mayhemProgramSeen),
    mayhemLifecycle: preferMayhemLifecycle(prev?.mayhemLifecycle, next.mayhemLifecycle),
    securityFlags: dedupe([...(prev?.securityFlags ?? []), ...(next.securityFlags ?? [])]),
    qualityFlags: dedupe([...(prev?.qualityFlags ?? []), ...(next.qualityFlags ?? [])]),
  });
}

function appendFlags(map: Map<string, string[]>, tokenMint: string | undefined, flags: string[]): void {
  if (!tokenMint || flags.length === 0) return;
  map.set(tokenMint, dedupe([...(map.get(tokenMint) ?? []), ...flags]));
}

function devFlags(row: BotflowContextRow): string[] {
  const flags: string[] = [];
  if (row.creatorAddress || row.devWallet || row.firstLpProvider) flags.push('DEV_ATTRIBUTION_PRESENT');
  if (row.operatorDevStatus) flags.push(`DEV_STATUS_${flagSegment(row.operatorDevStatus)}`);
  return flags;
}

function isSecurityFlag(flag: string): boolean {
  return flag === 'HARD_REJECT' || flag === 'NO_SECURITY_DATA' || flag.startsWith('SECURITY_');
}

function parseTimeMs(value: string | number | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseOptionalBool(value: boolean | string | undefined): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  return undefined;
}

function parseMayhemLifecycle(value: string | undefined): PureWsBotflowMayhemLifecycle | undefined {
  return value === 'active_lt_24h' || value === 'completed' || value === 'unknown' ? value : undefined;
}

function preferMayhemLifecycle(
  prev: PureWsBotflowMayhemLifecycle | undefined,
  next: PureWsBotflowMayhemLifecycle | undefined,
): PureWsBotflowMayhemLifecycle | undefined {
  if (!prev || prev === 'unknown') return next ?? prev;
  if (!next || next === 'unknown') return prev;
  return next;
}

function minDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left == null) return right;
  if (right == null) return left;
  return Math.min(left, right);
}

function maxDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left == null) return right;
  if (right == null) return left;
  return Math.max(left, right);
}

function flagSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
