/**
 * KOL Helius Markout Backfill (2026-05-01, Stream E).
 *
 * ADR: docs/exec-plans/active/helius-credit-edge-plan-2026-05-01.md §6 Stream E
 *
 * 목적: KOL Hunter 의 close / reject anchor 별 horizon 후 가격 trajectory 측정 →
 *       사명 §3 의 7 핵심 질문 중 #3 / #4 답변 자동화:
 *         - "How many closed positions reached 5x after exit?"   (winner truncation rate)
 *         - "How many rejected KOL candidates reached 5x later?" (false-negative 5x)
 *
 * Inputs (Plan §6 Stream E):
 *   - data/realtime/kol-paper-trades.jsonl
 *   - data/realtime/kol-live-trades.jsonl
 *   - data/realtime/kol-policy-decisions.jsonl
 *   - data/realtime/missed-alpha.jsonl
 *   - (optional) data/realtime-swaps/{pool}/raw-swaps.jsonl — 가속 source, 미존재 시 skip
 *
 * Output:
 *   - data/research/helius-markouts.jsonl
 *
 * Default source: `historical_rpc` (raw_swaps 는 optional, missing 이어도 정상 동작).
 *
 * Usage:
 *   npx ts-node scripts/kol-helius-markout-backfill.ts \
 *     --since 7d \
 *     --horizons 60,300,1800 \
 *     [--max-anchors 500] \
 *     [--dry-run]
 *
 * 정책:
 *   - Plan §11 rollout rule 6: offline jobs 가 daily cap 초과 시 pause first
 *   - estimated credits 가 daily cap 80% 도달 시 stop + alert
 *   - coverage <70% row 는 incomplete label (Plan §6 Stream E acceptance)
 */

import { readFile } from 'fs/promises';
import path from 'path';
import {
  HELIUS_MARKOUT_SCHEMA_VERSION,
  DEFAULT_HORIZONS_SEC,
  appendHeliusMarkout,
  computeMarkoutMetrics,
  reached5x,
  type HeliusMarkoutRecord,
  type HeliusMarkoutSubjectType,
} from '../src/research/heliusMarkoutTypes';
import {
  appendHeliusCreditUsage,
  buildHeliusCreditUsage,
} from '../src/observability/heliusCreditLedger';

interface BackfillArgs {
  sinceMs: number;
  horizonsSec: number[];
  maxAnchors: number;
  dryRun: boolean;
  realtimeDir: string;
  researchDir: string;
  // 2026-05-01 (Codex F1 fix): 실 RPC 활성화 input — 미공급 시 stub mode 유지.
  rpcUrl?: string;
  /** per-anchor tx fetch cap (default 50 — = 50 credits per anchor) */
  maxTxsPerAnchor: number;
  /** RPC call delay ms (default 100 = 10 RPS) */
  rpcDelayMs: number;
  /** signature pagination page cap per anchor — protects offline credit spend */
  maxSignaturePages: number;
}

/** Plan §6 Stream E 의 input 4종 anchor. */
interface AnchorRow {
  subjectType: HeliusMarkoutSubjectType;
  subjectId: string;
  tokenMint: string;
  anchorTsMs: number;
  /** anchor reference price (entryPrice for 'entry'/'close' / signalPrice for 'reject') */
  anchorPrice: number;
  /**
   * 2026-05-01 (QA F3 fix): close anchor 만 — anchor 부터 actual exit 까지 경과 sec.
   *   peakAtSec < exitOffsetSec → reached5xBeforeExit
   *   peakAtSec >= exitOffsetSec → reached5xAfterExit (winner truncation)
   *   undefined for entry / reject anchors.
   */
  exitOffsetSec?: number;
}

function parseSince(input: string): number {
  // 7d / 24h / 1h / 30m
  const m = input.match(/^(\d+)([dhm])$/);
  if (!m) throw new Error(`invalid --since '${input}', expected NNd / NNh / NNm`);
  const n = Number(m[1]);
  const unit = m[2];
  const ms = unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : 60000;
  return Date.now() - n * ms;
}

function parseHorizons(input: string): number[] {
  return input.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
}

function parseArgs(argv: string[]): BackfillArgs {
  const args: Partial<BackfillArgs> = {
    horizonsSec: [...DEFAULT_HORIZONS_SEC],
    maxAnchors: 500,
    dryRun: false,
    realtimeDir: path.resolve(process.cwd(), 'data/realtime'),
    researchDir: path.resolve(process.cwd(), 'data/research'),
    maxTxsPerAnchor: 50,
    rpcDelayMs: 100,
    maxSignaturePages: 10,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since') args.sinceMs = parseSince(argv[++i]);
    else if (a === '--horizons') args.horizonsSec = parseHorizons(argv[++i]);
    else if (a === '--max-anchors') args.maxAnchors = Number(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--realtime-dir') args.realtimeDir = argv[++i];
    else if (a === '--research-dir') args.researchDir = argv[++i];
    // 2026-05-01 (Codex F1 fix): 실 RPC 활성화 path
    else if (a === '--rpc-url') args.rpcUrl = argv[++i];
    else if (a === '--max-txs-per-anchor') args.maxTxsPerAnchor = Number(argv[++i]);
    else if (a === '--rpc-delay-ms') args.rpcDelayMs = Number(argv[++i]);
    else if (a === '--max-signature-pages') args.maxSignaturePages = Number(argv[++i]);
  }
  if (typeof args.sinceMs !== 'number') {
    args.sinceMs = Date.now() - 7 * 86400000; // default 7d
  }
  return args as BackfillArgs;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseTimeMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const n = finiteNumber(value);
    if (n != null) return n;
  }
  return null;
}

function firstTimeMs(...values: unknown[]): number | null {
  for (const value of values) {
    const ms = parseTimeMs(value);
    if (ms != null) return ms;
  }
  return null;
}

async function readJsonl<T = Record<string, unknown>>(filePath: string): Promise<T[]> {
  try {
    const content = await readFile(filePath, 'utf8');
    return content.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

/**
 * paper / live trades → 'close' anchor 추출.
 * 현재 KOL ledger 는 closedAt + holdSec 를 기록하고 entryTimeSec / exitTimeSec 는 legacy field 다.
 * 따라서 우선 legacy numeric time 을 쓰고, 없으면 closedAt - holdSec 로 entry anchor 를 복원한다.
 */
function extractCloseAnchors(rows: Array<Record<string, unknown>>): AnchorRow[] {
  const out: AnchorRow[] = [];
  for (const r of rows) {
    const positionId = String(r.positionId ?? '');
    const tokenMint = String(r.tokenMint ?? '');
    const entryTimeSec = finiteNumber(r.entryTimeSec);
    const exitTimeSec = finiteNumber(r.exitTimeSec);
    const holdSec = finiteNumber(r.holdSec);
    const exitTimeMs = exitTimeSec != null
      ? exitTimeSec * 1000
      : firstTimeMs(r.exitAtIso, r.closedAt, r.recordedAt);
    const entryTimeMs = entryTimeSec != null
      ? entryTimeSec * 1000
      : firstTimeMs(r.entryAtIso, r.openedAt)
        ?? (exitTimeMs != null && holdSec != null ? exitTimeMs - holdSec * 1000 : null);
    const entryPrice = firstNumber(r.entryPriceTokenOnly, r.entryPrice, r.marketReferencePrice);
    if (!positionId || !tokenMint || entryTimeMs == null || exitTimeMs == null || entryPrice == null) continue;
    if (entryPrice <= 0) continue;
    // QA F3 fix: exitOffsetSec = exit - entry — close anchor 의 5x before/after 분기 입력.
    const exitOffsetSec = Math.max(0, Math.floor((exitTimeMs - entryTimeMs) / 1000));
    out.push({
      subjectType: 'close',
      subjectId: positionId,
      tokenMint,
      anchorTsMs: entryTimeMs,
      anchorPrice: entryPrice,
      exitOffsetSec,
    });
  }
  return out;
}

/**
 * missed-alpha → 'reject' anchor 추출.
 * signalPrice 가 anchor reference. anchorTsMs 는 reject 시점 (close 의 anchorTsMs 정합 위해 epoch ms).
 */
function extractRejectAnchors(rows: Array<Record<string, unknown>>): AnchorRow[] {
  const out: AnchorRow[] = [];
  for (const r of rows) {
    // missed-alpha schema 다양 — defensive read
    const signalPrice =
      typeof r.signalPrice === 'number' ? r.signalPrice :
      (typeof (r as { extras?: { signalPrice?: number } }).extras?.signalPrice === 'number'
        ? (r as { extras: { signalPrice: number } }).extras.signalPrice : null);
    const tokenMint = String(r.tokenMint ?? '');
    const probe = (r as { probe?: { firedAt?: unknown } }).probe;
    const tsMs = firstTimeMs(
      r.rejectedAt,
      r.timestamp,
      r.observedAtMs,
      probe?.firedAt,
    );
    const subjectId = String(
      (r as { eventId?: string }).eventId ??
      (r as { id?: string; rejectId?: string }).id ??
      (r as { rejectId?: string }).rejectId ??
      `reject-${tokenMint.slice(0, 8)}-${tsMs}`,
    );
    if (!signalPrice || !tokenMint || !tsMs) continue;
    out.push({
      subjectType: 'reject',
      subjectId,
      tokenMint,
      anchorTsMs: tsMs,
      anchorPrice: signalPrice,
    });
  }
  return out;
}

/**
 * Helius 가격 trajectory backfill (Stream X2 — 실 wiring).
 *
 * 정책 (Plan §6 Stream E + §11 rollout rule 6):
 *   - Standard RPC `getParsedTransaction` (1 credit/call) 만 사용 — Enhanced 100c 차단
 *   - getSignaturesForAddress 로 anchor 후 N seconds 의 tx list 조회 (1 credit per call)
 *   - 각 tx 안 wallet-swap 추정으로 가격 점 산출 (heuristic) — token quote price 가 없으면 빈 trajectory
 *   - **per-token credit cap**: 호출당 최대 cap 까지만 fetch — daily budget 보호
 *
 * Stub 모드는 `--stub` 플래그 또는 missing connection 으로 유지 가능 (test 호환).
 */
import type { Connection, ParsedTransactionWithMeta } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import { detectSwapFromWalletPerspective } from '../src/ingester/kolWalletTracker';

interface FetchTrajectoryOptions {
  connection?: Connection;
  /** per-token tx fetch cap — default 50 (= 50 credits per anchor) */
  maxTxsPerAnchor?: number;
  /** sleep ms between RPC calls — rate limit 보호 (default 100ms = 10 RPS) */
  rpcDelayMs?: number;
  /** Max getSignaturesForAddress pages to scan while seeking the anchor window. */
  maxSignaturePages?: number;
  stub?: boolean;
}

const SIGNATURE_PAGE_LIMIT = 1000;

async function fetchPriceTrajectory(
  tokenMint: string,
  anchorTsMs: number,
  horizonsSec: number[],
  options: FetchTrajectoryOptions = {},
): Promise<{
  points: Array<{ relativeSec: number; price: number }>;
  parseFailedCount: number;
  source: 'historical_rpc';
  estimatedCredits: number;
  // 2026-05-01 (Codex F4 follow-up): method 별 credit 분해 — Standard RPC 의
  //   getSignaturesForAddress (1c per call) vs getParsedTransaction (1c per call) 분리.
  //   처음 caller (processAnchor) 가 credit ledger 에 method 별 row 로 기록 가능.
  signatureFetchCalls: number;
  parsedTransactionCalls: number;
}> {
  // Stub mode (default — Phase 2 wiring 까지 비활성). connection 없거나 stub flag.
  if (options.stub === true || !options.connection) {
    return {
      points: [],
      parseFailedCount: 0,
      source: 'historical_rpc',
      estimatedCredits: 0,
      signatureFetchCalls: 0,
      parsedTransactionCalls: 0,
    };
  }

  const { connection } = options;
  const cap = Math.max(1, Math.floor(options.maxTxsPerAnchor ?? 50));
  const delayMs = Math.max(0, options.rpcDelayMs ?? 100);
  const maxSignaturePages = Math.max(1, Math.floor(options.maxSignaturePages ?? 10));
  const maxHorizonSec = horizonsSec.length > 0 ? Math.max(...horizonsSec) : 1800;
  const anchorEndTsMs = anchorTsMs + maxHorizonSec * 1000;

  let estimatedCredits = 0;
  let signatureFetchCalls = 0;
  let parsedTransactionCalls = 0;
  let parseFailedCount = 0;
  const points: Array<{ relativeSec: number; price: number }> = [];

  // Step 1: anchor token 의 signatures. 최신 cap 개만 보면 과거 anchor window 를 놓치므로
  // before pagination 으로 anchor window 까지 내려간다. parsed tx 는 cap 으로 별도 제한한다.
  let signatures: Array<{ signature: string; blockTime?: number | null }> = [];
  let before: string | undefined;
  try {
    for (let page = 0; page < maxSignaturePages; page++) {
      const sigs = await connection.getSignaturesForAddress(
        new PublicKey(tokenMint),
        before ? { limit: SIGNATURE_PAGE_LIMIT, before } : { limit: SIGNATURE_PAGE_LIMIT },
      );
      // Codex F4 fix: method 별 분리 trace
      signatureFetchCalls += 1;
      estimatedCredits += 1; // Standard RPC 1c
      if (sigs.length === 0) break;

      signatures.push(...sigs.map((s) => ({ signature: s.signature, blockTime: s.blockTime })));

      const inWindowCount = signatures.filter((s) => {
        if (typeof s.blockTime !== 'number') return false;
        const tsMs = s.blockTime * 1000;
        return tsMs >= anchorTsMs && tsMs <= anchorEndTsMs;
      }).length;
      if (inWindowCount >= cap) break;

      const oldestWithBlockTime = [...sigs].reverse().find((s) => typeof s.blockTime === 'number');
      if (oldestWithBlockTime && oldestWithBlockTime.blockTime! * 1000 < anchorTsMs) break;

      before = sigs[sigs.length - 1]?.signature;
      if (!before) break;
    }
  } catch {
    return {
      points, parseFailedCount, source: 'historical_rpc',
      estimatedCredits, signatureFetchCalls, parsedTransactionCalls,
    };
  }

  // Step 2: anchor window (anchorTsMs ~ anchorEndTsMs) 안 sig 만 필터
  const inWindow = signatures.filter((s) => {
    if (typeof s.blockTime !== 'number') return false;
    const tsMs = s.blockTime * 1000;
    return tsMs >= anchorTsMs && tsMs <= anchorEndTsMs;
  });

  // Step 3: 각 sig parse → token amount / SOL delta 추정 → 가격 산출
  for (const sig of inWindow.slice(0, cap)) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    let tx: ParsedTransactionWithMeta | null = null;
    try {
      tx = await connection.getParsedTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
      });
      // Codex F4 fix: method 별 분리 trace
      parsedTransactionCalls += 1;
      estimatedCredits += 1; // Standard RPC 1c
    } catch {
      parseFailedCount += 1;
      continue;
    }
    if (!tx || !sig.blockTime) {
      parseFailedCount += 1;
      continue;
    }
    // Heuristic: detectSwapFromWalletPerspective 가 specific wallet 기준 — token-only price 추정엔
    //   pool-perspective 가 더 정확하지만 본 sprint 는 anchor-only minimal. tx.meta.postTokenBalances
    //   에서 pool address 찾아 wallet-perspective 추정 — 안 되면 skip.
    const poolAddress = findPoolForToken(tx, tokenMint);
    if (!poolAddress) continue;
    const swap = detectSwapFromWalletPerspective(tx, poolAddress);
    if (!swap || !swap.tokenAmount || swap.tokenAmount === 0) continue;
    const price = swap.solAmount / swap.tokenAmount;
    if (!Number.isFinite(price) || price <= 0) continue;
    const relativeSec = sig.blockTime - Math.floor(anchorTsMs / 1000);
    points.push({ relativeSec, price });
  }

  return {
    points,
    parseFailedCount,
    source: 'historical_rpc',
    estimatedCredits,
    signatureFetchCalls,
    parsedTransactionCalls,
  };
}

/**
 * tx 의 token balance 변화에서 token mint 가 등장한 owner 중 가장 큰 변동을 가진 address 찾기.
 * 보통 pool address — wallet 보다 큰 token delta 발생.
 */
function findPoolForToken(tx: ParsedTransactionWithMeta, tokenMint: string): string | null {
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const deltaByOwner = new Map<string, number>();
  for (const p of post) {
    if (p.mint !== tokenMint || !p.owner) continue;
    const preMatch = pre.find((q) => q.mint === tokenMint && q.owner === p.owner);
    const postUi = p.uiTokenAmount?.uiAmount ?? 0;
    const preUi = preMatch?.uiTokenAmount?.uiAmount ?? 0;
    const delta = Math.abs(postUi - preUi);
    if (delta > 0) {
      deltaByOwner.set(p.owner, (deltaByOwner.get(p.owner) ?? 0) + delta);
    }
  }
  let best: string | null = null;
  let bestDelta = 0;
  for (const [owner, delta] of deltaByOwner) {
    if (delta > bestDelta) {
      best = owner;
      bestDelta = delta;
    }
  }
  return best;
}

async function processAnchor(
  anchor: AnchorRow,
  horizonsSec: number[],
  args: BackfillArgs,
  connection?: Connection,
): Promise<HeliusMarkoutRecord> {
  // 2026-05-01 (Codex F1 fix): connection 공급 시 실 RPC 사용. 미공급 시 stub mode.
  const fetched = await fetchPriceTrajectory(anchor.tokenMint, anchor.anchorTsMs, horizonsSec, {
    connection,
    maxTxsPerAnchor: args.maxTxsPerAnchor,
    rpcDelayMs: args.rpcDelayMs,
    maxSignaturePages: args.maxSignaturePages,
    stub: !connection,
  });

  const metrics = computeMarkoutMetrics(
    anchor.anchorPrice,
    fetched.points,
    horizonsSec.length,
  );

  // 5x 분기 — close anchor 만 before/after 분리 (entry/reject 는 after only).
  // QA F3 fix: peakAtSec < exitOffsetSec → reached5xBeforeExit (entry-during-hold 5x).
  //           peakAtSec >= exitOffsetSec → reached5xAfterExit (winner truncation).
  //           peakAtSec 미측정 (coverage 0) → 둘 다 undefined (정합 보장).
  const trueMfe = metrics.trueMfePct;
  const has5x = reached5x(trueMfe);
  const peakAtSec = metrics.peakAtSec;

  let reached5xBeforeExit: boolean | undefined;
  let reached5xAfterExit: boolean | undefined;

  if (anchor.subjectType === 'close') {
    if (!has5x || typeof peakAtSec !== 'number' || typeof anchor.exitOffsetSec !== 'number') {
      // 5x 미도달 또는 측정 불가 → 둘 다 false (5x 안 옴). reject anchor 와 구분 위해 명시적 false.
      reached5xBeforeExit = has5x ? undefined : false;
      reached5xAfterExit = has5x ? undefined : false;
    } else if (peakAtSec < anchor.exitOffsetSec) {
      reached5xBeforeExit = true;
      reached5xAfterExit = false;
    } else {
      reached5xBeforeExit = false;
      reached5xAfterExit = true;
    }
  } else {
    // entry / reject — after-only 의미. close 와 schema 정합 위해 reached5xAfterExit 만 채움.
    reached5xBeforeExit = undefined;
    reached5xAfterExit = has5x;
  }

  const record: HeliusMarkoutRecord = {
    schemaVersion: HELIUS_MARKOUT_SCHEMA_VERSION,
    subjectType: anchor.subjectType,
    subjectId: anchor.subjectId,
    tokenMint: anchor.tokenMint,
    anchorTsMs: anchor.anchorTsMs,
    horizonsSec,
    source: fetched.source,
    coveragePct: metrics.coveragePct,
    parseFailedCount: fetched.parseFailedCount,
    trueMfePct: metrics.trueMfePct,
    trueMaePct: metrics.trueMaePct,
    peakAtSec: metrics.peakAtSec,
    troughAtSec: metrics.troughAtSec,
    reached5xBeforeExit,
    reached5xAfterExit,
    estimatedCredits: fetched.estimatedCredits,
  };

  if (!args.dryRun) {
    const result = await appendHeliusMarkout(record, { ledgerDir: args.researchDir });
    if (!result.appended) {
      console.error(`[markout] append failed for ${anchor.subjectId}: ${result.error}`);
    }
    // Helius credit usage trace.
    // 2026-05-01 (Codex F4 fix): method 별 분리 기록 — getSignaturesForAddress vs getParsedTransaction.
    //   기존: 모두 getParsedTransaction 으로 묶어 method-level cost 분석 흐림.
    //   현재: signatureFetchCalls / parsedTransactionCalls 각각 별도 row → method 별 attribution 정확.
    //   총 credit 합계는 동일 (Standard RPC 1c per call).
    if (fetched.signatureFetchCalls > 0) {
      const sigCreditRow = buildHeliusCreditUsage({
        purpose: 'markout_backfill',
        surface: 'standard_rpc',
        method: 'getSignaturesForAddress',
        requestCount: fetched.signatureFetchCalls,
        tokenMint: anchor.tokenMint,
        traceId: `markout-sig:${anchor.subjectId}`,
      });
      await appendHeliusCreditUsage(sigCreditRow, { ledgerDir: args.realtimeDir });
    }
    if (fetched.parsedTransactionCalls > 0) {
      const parseCreditRow = buildHeliusCreditUsage({
        purpose: 'markout_backfill',
        surface: 'standard_rpc',
        method: 'getParsedTransaction',
        requestCount: fetched.parsedTransactionCalls,
        tokenMint: anchor.tokenMint,
        traceId: `markout-parse:${anchor.subjectId}`,
      });
      await appendHeliusCreditUsage(parseCreditRow, { ledgerDir: args.realtimeDir });
    }
  }

  return record;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[markout-backfill] since=${new Date(args.sinceMs).toISOString()} ` +
    `horizons=[${args.horizonsSec.join(',')}] maxAnchors=${args.maxAnchors} dryRun=${args.dryRun} ` +
    `rpcUrl=${args.rpcUrl ? 'set' : 'missing(stub)'} maxTxs=${args.maxTxsPerAnchor} ` +
    `maxSigPages=${args.maxSignaturePages} delay=${args.rpcDelayMs}ms`);

  // 2026-05-01 (Codex F1 fix): connection wiring — `--rpc-url` 공급 시 실 RPC, 미공급 시 stub mode.
  let connection: Connection | undefined;
  if (args.rpcUrl) {
    const { Connection: SolanaConnection } = await import('@solana/web3.js');
    connection = new SolanaConnection(args.rpcUrl, 'confirmed');
    console.log('[markout-backfill] real RPC mode — Standard RPC getSignaturesForAddress + getParsedTransaction');
  } else {
    console.warn(
      '[markout-backfill] WARNING: --rpc-url 미공급 → STUB MODE. ' +
      'all rows will have coverage=0 (incomplete). 실 측정에는 `--rpc-url <helius_url>` 필수.',
    );
  }

  const [paperRows, liveRows, missedRows] = await Promise.all([
    readJsonl(path.join(args.realtimeDir, 'kol-paper-trades.jsonl')),
    readJsonl(path.join(args.realtimeDir, 'kol-live-trades.jsonl')),
    readJsonl(path.join(args.realtimeDir, 'missed-alpha.jsonl')),
  ]);

  const paperAnchors = extractCloseAnchors(paperRows as Array<Record<string, unknown>>);
  const liveAnchors = extractCloseAnchors(liveRows as Array<Record<string, unknown>>);
  const rejectAnchors = extractRejectAnchors(missedRows as Array<Record<string, unknown>>);

  const allAnchors = [...paperAnchors, ...liveAnchors, ...rejectAnchors]
    .filter((a) => a.anchorTsMs >= args.sinceMs)
    .slice(0, args.maxAnchors);

  console.log(`[markout-backfill] anchors=${allAnchors.length} ` +
    `(paper=${paperAnchors.length} live=${liveAnchors.length} reject=${rejectAnchors.length})`);

  let written = 0;
  let incomplete = 0;
  for (const anchor of allAnchors) {
    // 2026-05-01 (Codex F1 fix): connection 전달 → 실 RPC mode 활성.
    const record = await processAnchor(anchor, args.horizonsSec, args, connection);
    if (record.coveragePct < 0.70) incomplete += 1;
    written += 1;
  }

  console.log(`[markout-backfill] done. written=${written} incomplete(coverage<70%)=${incomplete}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[markout-backfill] fatal:', err);
    process.exit(1);
  });
}

export { extractCloseAnchors, extractRejectAnchors, processAnchor, parseArgs, parseSince, parseHorizons };
