#!/usr/bin/env ts-node
/**
 * KOL Live Canary Attribution Report
 *
 * Wallet-truth 우선순위:
 *   1. sell.walletDeltaSol
 *   2. sell.dbPnlSol
 *   3. sell.receivedSol - sell.solSpentNominal
 *   4. sell.receivedSol - (buy.actualEntryPrice * buy.actualQuantity)
 *
 * 실행:
 *   npm run kol:live-canary-report -- --ledger-dir data/realtime --md reports/kol-live-canary.md
 */
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

interface CliArgs {
  ledgerDir: string;
  since?: Date;
  md?: string;
  json?: string;
  walletSol?: number;
  walletFloorSol: number;
  kolCanaryCapSol: number;
  kolTicketSol: number;
}

interface KolLiveBuyLedger {
  positionId?: string;
  txSignature?: string;
  strategy?: string;
  wallet?: string;
  pairAddress?: string;
  tokenSymbol?: string;
  plannedEntryPrice?: number;
  actualEntryPrice?: number;
  actualQuantity?: number;
  expectedInAmount?: string;
  actualInputAmount?: string;
  actualInputUiAmount?: number;
  actualOutUiAmount?: number;
  inputDecimals?: number;
  outputDecimals?: number;
  expectedOutAmount?: string;
  actualOutAmount?: string;
  entryFillOutputRatio?: number;
  swapQuoteEntryPrice?: number;
  swapQuoteEntryAdvantagePct?: number;
  referenceToSwapQuotePct?: number;
  referencePriceTimestampMs?: number;
  referenceResolvedAtMs?: number;
  referenceAgeMs?: number;
  signalToReferenceMs?: number;
  buyStartedAtMs?: number;
  buyCompletedAtMs?: number;
  buyExecutionMs?: number;
  slippageBps?: number;
  signalTimeSec?: number;
  recordedAt?: string;
  partialFillDataMissing?: boolean;
  partialFillDataReason?: string;
  kolScore?: number;
  independentKolCount?: number;
}

interface KolLiveSellLedger {
  positionId?: string;
  dbTradeId?: string;
  txSignature?: string;
  entryTxSignature?: string;
  strategy?: string;
  wallet?: string;
  pairAddress?: string;
  tokenSymbol?: string;
  exitReason?: string;
  receivedSol?: number;
  actualExitPrice?: number;
  slippageBps?: number;
  entryPrice?: number;
  holdSec?: number;
  recordedAt?: string;
  mfePctPeak?: number;
  // 2026-05-01 (Sprint Z M4 — Codex 권고): live canary report 도 token-only 측정 인식.
  //   live MFE/MAE/netPct 가 ATA rent inflation 으로 stop 정책 평가 시 보수적으로 보이는 문제.
  mfePctPeakTokenOnly?: number;
  mfePctPeakWalletBased?: number;
  maePctTokenOnly?: number;
  netPctTokenOnly?: number;
  netSolTokenOnly?: number;
  exitPriceTokenOnly?: number;
  entryPriceTokenOnly?: number;
  entryPriceWalletDelta?: number;
  ataRentSol?: number;
  swapInputSol?: number;
  peakPrice?: number;
  troughPrice?: number;
  marketReferencePrice?: number;
  t1VisitAtSec?: number | null;
  t2VisitAtSec?: number | null;
  t3VisitAtSec?: number | null;
  closeState?: string;
  dbPnlSol?: number;
  walletDeltaSol?: number;
  dbPnlDriftSol?: number;
  solSpentNominal?: number;
  kolScore?: number;
  independentKolCount?: number;
  armName?: string;
  parameterVersion?: string;
  kolEntryReason?: string;
  kolConvictionLevel?: string;
}

interface KolPaperTradeLedger {
  positionId?: string;
  strategy?: string;
  tokenMint?: string;
  netSol?: number;
  netPct?: number;
  mfePctPeak?: number;
  maePct?: number;
  holdSec?: number;
  exitReason?: string;
  t1VisitAtSec?: number | null;
  t2VisitAtSec?: number | null;
  t3VisitAtSec?: number | null;
  survivalFlags?: string[];
  closedAt?: string;
  armName?: string;
  parameterVersion?: string;
  independentKolCount?: number;
  kolScore?: number;
  isShadowKol?: boolean;
}

interface MissedAlphaProbeLedger {
  offsetSec?: number;
  firedAt?: string;
  observedPrice?: number | null;
  deltaPct?: number | null;
  quoteStatus?: string;
  quoteReason?: string | null;
}

interface MissedAlphaLedgerRecord {
  eventId?: string;
  tokenMint?: string;
  lane?: string;
  rejectCategory?: string;
  rejectReason?: string;
  rejectedAt?: string;
  extras?: Record<string, unknown> | null;
  probe?: MissedAlphaProbeLedger;
}

interface PairedKolLiveTrade {
  positionId: string;
  tokenMint?: string;
  entryTxSignature?: string;
  exitTxSignature?: string;
  exitReason: string;
  armName: string;
  parameterVersion: string;
  netSol: number;
  walletTruthSource: 'walletDeltaSol' | 'dbPnlSol' | 'solSpentNominal' | 'buyFillEstimate' | 'unknown';
  win: boolean;
  /** State-machine/reference 기준 MFE. Live 에서는 plannedEntryPrice 기준일 수 있다. */
  mfePctPeak: number;
  /** Wallet fill 기준 MFE. Live 실제 손익비 판단에는 이 값을 우선 본다. */
  actualMfePctPeak: number | null;
  /** State-machine/reference 기준 MAE. */
  maePct: number | null;
  /** Wallet fill 기준 MAE. */
  actualMaePct: number | null;
  /** actualEntryPrice / plannedEntryPrice - 1. 음수면 유리한 fill. */
  entryAdvantagePct: number | null;
  /** executeBuy 내부 Jupiter fresh quote 기준 actualEntryPrice / quoteEntryPrice - 1. */
  swapQuoteEntryAdvantagePct: number | null;
  /** executeBuy fresh quote 기준 SOL/token entry price. */
  swapQuoteEntryPrice: number | null;
  /** executeBuy fresh quote entry price / live reference price - 1. */
  referenceToSwapQuotePct: number | null;
  /** expectedOut 대비 actualOut 비율. 과거 ledger 에는 없을 수 있다. */
  entryFillOutputRatio: number | null;
  /** decimals/reference mismatch 로 보이는 극단 entryAdvantage row. */
  entryAdvantageArtifact: boolean;
  /** buy ledger recordedAt - signalTimeSec. Jupiter 429 등으로 live fill 이 늦어진 정도. */
  buyLagSec: number | null;
  /** executeBuy 시작부터 완료까지의 명시 실행 시간. 신규 ledger 에만 존재. */
  buyExecutionSec: number | null;
  /** live entry reference quote 를 사용할 때 cached tick 이 얼마나 오래됐는지. */
  referenceAgeSec: number | null;
  /** 첫 KOL tx 부터 live reference quote 확정까지 걸린 시간. */
  signalToReferenceSec: number | null;
  /** actual fill metrics 를 신뢰하지 못해 planned 값으로 복원한 entry. */
  partialFillDataMissing: boolean;
  partialFillDataReason?: string;
  holdSec?: number;
  t1Visited: boolean;
  t2Visited: boolean;
  t3Visited: boolean;
  actualT1Visited: boolean;
  actualT2Visited: boolean;
  actualT3Visited: boolean;
  entrySlippageBps?: number;
  exitSlippageBps?: number;
  independentKolCount?: number;
  kolScore?: number;
  recordedAtMs: number;
  orphanSell: boolean;
}

interface BucketSummary {
  bucket: string;
  trades: number;
  netSol: number;
  winRate: number;
  avgNetSol: number;
  avgMfePct: number;
  avgActualMfePct: number;
  avgEntryAdvantagePct: number;
  avgSwapQuoteEntryAdvantagePct: number;
  avgReferenceToSwapQuotePct: number;
  avgBuyLagSec: number;
  avgBuyExecutionSec: number;
  avgReferenceAgeSec: number;
  avgSignalToReferenceSec: number;
  partialFillDataMissingTrades: number;
  t1Visits: number;
  t2Visits: number;
  t3Visits: number;
  fiveXVisits: number;
  actualFiveXVisits: number;
  hardcuts: number;
}

interface PaperFallbackSummary {
  closedPaperFallbacks: number;
  netSol: number;
  winRate: number;
  avgNetSol: number;
  avgMfePct: number;
  t1Visits: number;
  t2Visits: number;
  t3Visits: number;
  fiveXVisits: number;
  hardcuts: number;
  byExitReason: BucketSummary[];
}

interface RunnerDiagnosticsSummary {
  actualT1Visits: number;
  actualT2Visits: number;
  actualFiveXVisits: number;
  maxActualMfePct: number;
  maxRefMfePct: number;
  nearActualT1Trades: number;
  referenceOnlyT1Trades: number;
  preT1Hardcuts: number;
  byExitReason: BucketSummary[];
  byActualMfeBucket: BucketSummary[];
}

interface RunnerlessCohortCandidate {
  dimension: string;
  bucket: string;
  trades: number;
  actualMfeKnownTrades: number;
  netSol: number;
  avgNetSol: number;
  winRate: number;
  avgActualMfePct: number;
  actualT1Visits: number;
  actualT2Visits: number;
  actualFiveXVisits: number;
  hardcuts: number;
  reason: string;
}

interface MissedAlphaEventGroup {
  eventId: string;
  tokenMint: string;
  positionId?: string;
  rejectReason: string;
  rejectedAt: string;
  rejectedAtMs: number;
  probes: MissedAlphaProbeLedger[];
}

interface PostCloseAlphaTradeSummary {
  positionId: string;
  tokenMint?: string;
  exitReason: string;
  netSol: number;
  actualMfePctPeak: number | null;
  matchedEventId: string;
  rejectedAt: string;
  maxDeltaPct: number | null;
  maxDeltaOffsetSec: number | null;
  okProbes: number;
  totalProbes: number;
  quoteStatuses: Record<string, number>;
}

interface PostCloseAlphaBucketSummary {
  bucket: string;
  trades: number;
  matchedTrades: number;
  okProbeTrades: number;
  postCloseT1Trades: number;
  postCloseT2Trades: number;
  netSol: number;
  avgMaxDeltaPct: number;
  maxDeltaPct: number;
}

interface PostCloseAlphaDiagnosticsSummary {
  matchedClosedTrades: number;
  unmatchedClosedTrades: number;
  okProbeTrades: number;
  postCloseT1Trades: number;
  postCloseT2Trades: number;
  maxPostCloseDeltaPct: number;
  probeStatusCounts: Record<string, number>;
  byExitReason: PostCloseAlphaBucketSummary[];
}

type KolLivePostCloseMissedAlphaRecord = MissedAlphaLedgerRecord & {
  eventId: string;
  tokenMint: string;
  rejectedAt: string;
  probe: MissedAlphaProbeLedger;
};

type Phase4GateVerdict = 'CONTINUE_SAMPLE' | 'PHASE5_READY' | 'HOLD_REVIEW' | 'PAUSE_REVIEW';
type CanaryBudgetProjectionVerdict = 'BLOCKED' | 'RESUME_POSSIBLE' | 'FLOOR_RISK';

interface CanaryBudgetProjectionInput {
  walletSol: number;
  walletFloorSol: number;
  kolCanaryCapSol: number;
  kolTicketSol: number;
}

interface CanaryBudgetProjection {
  walletSol: number;
  walletFloorSol: number;
  walletRoomSol: number;
  kolCanaryCapSol: number;
  cumulativeKolPnlSol: number;
  remainingKolBudgetSol: number;
  projectedWalletAtBudgetExhaustionSol: number;
  projectedFloorBufferSol: number;
  kolTicketSol: number;
  approxFullTicketLosers: number;
  capExhausted: boolean;
  verdict: CanaryBudgetProjectionVerdict;
  reason: string;
}

interface Phase4GateSummary {
  verdict: Phase4GateVerdict;
  minClosedTrades: number;
  closedTrades: number;
  hasActualRunner: boolean;
  dataQualityClear: boolean;
  guardCalibrationClear: boolean;
  partialFillDataMissingTrades: number;
  knownPartialFillDataMissingTrades: number;
  legacyPartialFillDataMissingTrades: number;
  entryAdvantageAnomalyTrades: number;
  entryAdvantageArtifactTrades: number;
  executionQualityCooldownPaperFallbacks: number;
  executionQualityCooldownT2Visits: number;
  executionQualityCooldownFiveXVisits: number;
  freshReferenceRejectPaperFallbacks: number;
  freshReferenceRejectT2Visits: number;
  freshReferenceRejectFiveXVisits: number;
  reasons: string[];
}

interface KolLiveCanaryReport {
  generatedAt: string;
  since?: string;
  closedTrades: number;
  openBuys: number;
  orphanSells: number;
  netSol: number;
  winRate: number;
  avgNetSol: number;
  avgMfePct: number;
  avgActualMfePct: number;
  avgEntryAdvantagePct: number;
  avgSwapQuoteEntryAdvantagePct: number;
  avgReferenceToSwapQuotePct: number;
  avgBuyLagSec: number;
  avgBuyExecutionSec: number;
  avgReferenceAgeSec: number;
  avgSignalToReferenceSec: number;
  partialFillDataMissingTrades: number;
  knownPartialFillDataMissingTrades: number;
  legacyPartialFillDataMissingTrades: number;
  entryAdvantageAnomalyTrades: number;
  entryAdvantageArtifactTrades: number;
  entryAdvantageAdverseTrades: number;
  entryAdvantageFavorableTrades: number;
  maxDrawdownSol: number;
  t1Visits: number;
  t2Visits: number;
  t3Visits: number;
  fiveXVisits: number;
  actualT1Visits: number;
  actualT2Visits: number;
  actualT3Visits: number;
  actualFiveXVisits: number;
  hardcuts: number;
  walletTruthSources: Record<string, number>;
  byExitReason: BucketSummary[];
  byIndependentKolCount: BucketSummary[];
  bySlippageBucket: BucketSummary[];
  byBuyLagBucket: BucketSummary[];
  byBuyExecutionBucket: BucketSummary[];
  byReferenceToSwapQuoteBucket: BucketSummary[];
  byFillDataQualityBucket: BucketSummary[];
  byFillFallbackReasonBucket: BucketSummary[];
  byEntryAdvantageBucket: BucketSummary[];
  byActualMfeBucket: BucketSummary[];
  byArm: BucketSummary[];
  worstTrades: PairedKolLiveTrade[];
  measurementMismatchTrades: PairedKolLiveTrade[];
  forcedPlannedFillTrades: PairedKolLiveTrade[];
  entryAdvantageAnomalies: PairedKolLiveTrade[];
  entryAdvantageArtifacts: PairedKolLiveTrade[];
  runnerDiagnostics: RunnerDiagnosticsSummary;
  runnerCandidateTrades: PairedKolLiveTrade[];
  runnerlessQuarantineCandidates: RunnerlessCohortCandidate[];
  postCloseAlphaDiagnostics: PostCloseAlphaDiagnosticsSummary;
  postCloseAlphaCandidateTrades: PostCloseAlphaTradeSummary[];
  executionQualityCooldown: PaperFallbackSummary;
  freshReferenceReject: PaperFallbackSummary;
  phase4Gate: Phase4GateSummary;
  canaryBudgetProjection?: CanaryBudgetProjection;
}

interface BuildKolLiveCanaryReportOptions {
  canaryBudgetProjection?: CanaryBudgetProjectionInput;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const today = new Date().toISOString().slice(0, 10);
  return {
    ledgerDir: get('--ledger-dir') ?? path.resolve(process.cwd(), 'data/realtime'),
    since: resolveSinceArg(argv),
    md: get('--md') ?? path.resolve(process.cwd(), `reports/kol-live-canary-${today}.md`),
    json: get('--json') ?? path.resolve(process.cwd(), `reports/kol-live-canary-${today}.json`),
    walletSol: parseOptionalNumber(get('--wallet-sol')),
    walletFloorSol: parseOptionalNumber(get('--wallet-floor-sol')) ?? 0.7,
    kolCanaryCapSol: parseOptionalNumber(get('--kol-canary-cap-sol')) ?? 0.2,
    kolTicketSol: parseOptionalNumber(get('--kol-ticket-sol')) ?? 0.02,
  };
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveSinceArg(argv: string[], nowMs = Date.now()): Date | undefined {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const since = get('--since');
  if (since) return new Date(since);
  const sinceHours = get('--since-hours');
  if (!sinceHours) return undefined;
  const hours = Number(sinceHours);
  if (!Number.isFinite(hours) || hours <= 0) return undefined;
  return new Date(nowMs - hours * 60 * 60 * 1000);
}

function within(since: Date | undefined, recordedAt?: string): boolean {
  if (!since || !recordedAt) return true;
  const t = new Date(recordedAt).getTime();
  return Number.isFinite(t) && t >= since.getTime();
}

function isKolLivePositionId(positionId?: string): boolean {
  return typeof positionId === 'string' && positionId.startsWith('kolh-live-');
}

function isKolLiveBuy(row: KolLiveBuyLedger): boolean {
  return row.strategy === 'kol_hunter' &&
    (row.wallet === 'main' || isKolLivePositionId(row.positionId));
}

function isKolLiveSell(row: KolLiveSellLedger, liveEntryTx: Set<string>): boolean {
  return row.strategy === 'kol_hunter' &&
    (row.wallet === 'main' || isKolLivePositionId(row.positionId) ||
      (typeof row.entryTxSignature === 'string' && liveEntryTx.has(row.entryTxSignature)));
}

function parseJsonl<T>(text: string): T[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((row): row is T => row !== null);
}

async function readJsonlMaybe<T>(file: string): Promise<T[]> {
  try {
    return parseJsonl<T>(await readFile(file, 'utf8'));
  } catch {
    return [];
  }
}

function resolveNetSol(
  buy: KolLiveBuyLedger | undefined,
  sell: KolLiveSellLedger
): { netSol: number; source: PairedKolLiveTrade['walletTruthSource'] } {
  if (typeof sell.walletDeltaSol === 'number') return { netSol: sell.walletDeltaSol, source: 'walletDeltaSol' };
  if (typeof sell.dbPnlSol === 'number') return { netSol: sell.dbPnlSol, source: 'dbPnlSol' };
  if (typeof sell.receivedSol === 'number' && typeof sell.solSpentNominal === 'number') {
    return { netSol: sell.receivedSol - sell.solSpentNominal, source: 'solSpentNominal' };
  }
  if (
    buy &&
    typeof sell.receivedSol === 'number' &&
    typeof buy.actualEntryPrice === 'number' &&
    typeof buy.actualQuantity === 'number'
  ) {
    return {
      netSol: sell.receivedSol - buy.actualEntryPrice * buy.actualQuantity,
      source: 'buyFillEstimate',
    };
  }
  return { netSol: 0, source: 'unknown' };
}

function recordedAtMs(row: { recordedAt?: string; signalTimeSec?: number }): number {
  if (row.recordedAt) {
    const t = new Date(row.recordedAt).getTime();
    if (Number.isFinite(t)) return t;
  }
  if (typeof row.signalTimeSec === 'number') return row.signalTimeSec * 1000;
  return 0;
}

function ratioPct(numerator?: number, denominator?: number): number | null {
  if (typeof numerator !== 'number' || typeof denominator !== 'number' || denominator <= 0) return null;
  return numerator / denominator - 1;
}

function firstKnown(...values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function resolveEntryFillOutputRatio(buy: KolLiveBuyLedger | undefined): number | null {
  if (!buy) return null;
  if (typeof buy.entryFillOutputRatio === 'number' && Number.isFinite(buy.entryFillOutputRatio)) {
    return buy.entryFillOutputRatio;
  }
  if (typeof buy.actualOutUiAmount === 'number' && typeof buy.actualQuantity === 'number' && buy.actualQuantity > 0) {
    return buy.actualOutUiAmount / buy.actualQuantity;
  }
  return null;
}

function resolveBuyLagSec(buy: KolLiveBuyLedger | undefined): number | null {
  if (!buy || typeof buy.signalTimeSec !== 'number' || !buy.recordedAt) return null;
  const recordedMs = new Date(buy.recordedAt).getTime();
  if (!Number.isFinite(recordedMs)) return null;
  return (recordedMs - buy.signalTimeSec * 1000) / 1000;
}

function msToSec(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value / 1000 : null;
}

function rawAmountUi(raw: string | undefined, decimals: number | undefined): number | null {
  if (!raw || typeof decimals !== 'number' || !Number.isFinite(decimals) || decimals < 0) return null;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const ui = value / Math.pow(10, decimals);
  return ui > 0 ? ui : null;
}

function resolveSwapQuoteEntryPrice(buy: KolLiveBuyLedger | undefined): number | null {
  if (!buy) return null;
  if (typeof buy.swapQuoteEntryPrice === 'number' && Number.isFinite(buy.swapQuoteEntryPrice)) {
    return buy.swapQuoteEntryPrice;
  }
  const expectedInUi =
    rawAmountUi(buy.expectedInAmount, buy.inputDecimals) ??
    (typeof buy.actualInputUiAmount === 'number' && buy.actualInputUiAmount > 0 ? buy.actualInputUiAmount : null);
  const expectedOutUi = rawAmountUi(buy.expectedOutAmount, buy.outputDecimals);
  if (expectedInUi == null || expectedOutUi == null || expectedOutUi <= 0) return null;
  return expectedInUi / expectedOutUi;
}

function resolveSwapQuoteEntryAdvantagePct(buy: KolLiveBuyLedger | undefined): number | null {
  if (
    buy &&
    typeof buy.swapQuoteEntryAdvantagePct === 'number' &&
    Number.isFinite(buy.swapQuoteEntryAdvantagePct)
  ) {
    return buy.swapQuoteEntryAdvantagePct;
  }
  const quoteEntryPrice = resolveSwapQuoteEntryPrice(buy);
  if (!buy || quoteEntryPrice == null || typeof buy.actualEntryPrice !== 'number' || buy.actualEntryPrice <= 0) {
    return null;
  }
  return buy.actualEntryPrice / quoteEntryPrice - 1;
}

function resolveReferenceToSwapQuotePct(buy: KolLiveBuyLedger | undefined): number | null {
  if (
    buy &&
    typeof buy.referenceToSwapQuotePct === 'number' &&
    Number.isFinite(buy.referenceToSwapQuotePct)
  ) {
    return buy.referenceToSwapQuotePct;
  }
  const quoteEntryPrice = resolveSwapQuoteEntryPrice(buy);
  if (!buy || quoteEntryPrice == null || typeof buy.plannedEntryPrice !== 'number' || buy.plannedEntryPrice <= 0) {
    return null;
  }
  return quoteEntryPrice / buy.plannedEntryPrice - 1;
}

function pairKolLiveTrades(
  buys: KolLiveBuyLedger[],
  sells: KolLiveSellLedger[],
  since?: Date
): { trades: PairedKolLiveTrade[]; openBuys: number; orphanSells: number } {
  const allLiveBuys = buys.filter(isKolLiveBuy);
  const liveBuys = allLiveBuys.filter((b) => within(since, b.recordedAt));
  const liveEntryTx = new Set(allLiveBuys.map((b) => b.txSignature).filter((tx): tx is string => !!tx));
  const liveSells = sells.filter((s) => isKolLiveSell(s, liveEntryTx) && within(since, s.recordedAt));

  const buysByTx = new Map<string, KolLiveBuyLedger>();
  const buysByPositionId = new Map<string, KolLiveBuyLedger>();
  for (const buy of allLiveBuys) {
    if (buy.txSignature) buysByTx.set(buy.txSignature, buy);
    if (buy.positionId) buysByPositionId.set(buy.positionId, buy);
  }

  const consumedBuys = new Set<string>();
  let orphanSells = 0;
  const trades: PairedKolLiveTrade[] = [];
  for (const sell of liveSells) {
    const buy = (sell.entryTxSignature ? buysByTx.get(sell.entryTxSignature) : undefined) ??
      (sell.positionId ? buysByPositionId.get(sell.positionId) : undefined);
    if (buy?.txSignature) consumedBuys.add(buy.txSignature);
    if (!buy) orphanSells += 1;

    const net = resolveNetSol(buy, sell);
    // 2026-05-01 (Codex M3 fix): token-only metric 우선 사용 (사명 §3 5x judgement 정합).
    //   sell ledger 의 *_TokenOnly 필드 (Sprint Z 신규) 우선, 미존재 시 wallet-entry 기반 fallback.
    //   이전: actualMfePctPeak 가 wallet-delta entryPrice 기반 → ATA rent inflation 으로 5x missed.
    const referenceMfePctPeak = firstKnown(
      sell.mfePctPeak,
      ratioPct(sell.peakPrice, sell.marketReferencePrice)
    ) ?? 0;
    const referenceMaePct = ratioPct(sell.troughPrice, sell.marketReferencePrice);
    const actualEntryPrice = firstKnown(sell.entryPrice, buy?.actualEntryPrice);
    const actualMfePctPeak = firstKnown(
      sell.mfePctPeakTokenOnly,
      ratioPct(sell.peakPrice, actualEntryPrice ?? undefined)
    );
    const actualMaePct = firstKnown(
      sell.maePctTokenOnly,
      ratioPct(sell.troughPrice, actualEntryPrice ?? undefined)
    );
    const entryAdvantagePct = firstKnown(
      buy ? ratioPct(buy.actualEntryPrice, buy.plannedEntryPrice) : null,
      ratioPct(sell.entryPrice, sell.marketReferencePrice)
    );
    const swapQuoteEntryPrice = resolveSwapQuoteEntryPrice(buy);
    const swapQuoteEntryAdvantagePct = resolveSwapQuoteEntryAdvantagePct(buy);
    const referenceToSwapQuotePct = resolveReferenceToSwapQuotePct(buy);
    const entryFillOutputRatio = resolveEntryFillOutputRatio(buy);
    const entryAdvantageArtifact = isEntryAdvantageArtifactPct(entryAdvantagePct);
    const buyLagSec = resolveBuyLagSec(buy);
    trades.push({
      positionId: sell.positionId ?? buy?.positionId ?? 'unknown',
      tokenMint: sell.pairAddress ?? buy?.pairAddress,
      entryTxSignature: sell.entryTxSignature ?? buy?.txSignature,
      exitTxSignature: sell.txSignature,
      exitReason: sell.exitReason ?? 'unknown',
      armName: sell.armName ?? 'unknown',
      parameterVersion: sell.parameterVersion ?? 'unknown',
      netSol: net.netSol,
      walletTruthSource: net.source,
      win: net.netSol > 0,
      mfePctPeak: referenceMfePctPeak,
      actualMfePctPeak,
      maePct: referenceMaePct,
      actualMaePct,
      entryAdvantagePct,
      swapQuoteEntryAdvantagePct,
      swapQuoteEntryPrice,
      referenceToSwapQuotePct,
      entryFillOutputRatio,
      entryAdvantageArtifact,
      buyLagSec,
      buyExecutionSec: msToSec(buy?.buyExecutionMs),
      referenceAgeSec: msToSec(buy?.referenceAgeMs),
      signalToReferenceSec: msToSec(buy?.signalToReferenceMs),
      partialFillDataMissing: buy?.partialFillDataMissing === true,
      partialFillDataReason: buy?.partialFillDataReason,
      holdSec: sell.holdSec,
      t1Visited: sell.t1VisitAtSec != null || referenceMfePctPeak >= 0.5,
      t2Visited: sell.t2VisitAtSec != null || referenceMfePctPeak >= 4,
      t3Visited: sell.t3VisitAtSec != null || referenceMfePctPeak >= 9,
      actualT1Visited: actualMfePctPeak != null && actualMfePctPeak >= 0.5,
      actualT2Visited: actualMfePctPeak != null && actualMfePctPeak >= 4,
      actualT3Visited: actualMfePctPeak != null && actualMfePctPeak >= 9,
      entrySlippageBps: buy?.slippageBps,
      exitSlippageBps: sell.slippageBps,
      independentKolCount: sell.independentKolCount ?? buy?.independentKolCount,
      kolScore: sell.kolScore ?? buy?.kolScore,
      recordedAtMs: recordedAtMs(sell),
      orphanSell: !buy,
    });
  }

  let openBuys = 0;
  for (const buy of liveBuys) {
    if (buy.txSignature && !consumedBuys.has(buy.txSignature)) openBuys += 1;
  }

  return { trades, openBuys, orphanSells };
}

function isExecutionQualityCooldownPaperFallback(row: KolPaperTradeLedger): boolean {
  return row.strategy === 'kol_hunter' &&
    row.isShadowKol !== true &&
    Array.isArray(row.survivalFlags) &&
    row.survivalFlags.includes('LIVE_EXEC_QUALITY_COOLDOWN');
}

function isFreshReferenceRejectPaperFallback(row: KolPaperTradeLedger): boolean {
  return row.strategy === 'kol_hunter' &&
    row.isShadowKol !== true &&
    Array.isArray(row.survivalFlags) &&
    row.survivalFlags.includes('LIVE_FRESH_REFERENCE_REJECT');
}

function paperFallbackToTrade(row: KolPaperTradeLedger): PairedKolLiveTrade {
  const mfePctPeak = typeof row.mfePctPeak === 'number' ? row.mfePctPeak : 0;
  const netSol = typeof row.netSol === 'number' ? row.netSol : 0;
  const closedAtMs = row.closedAt ? new Date(row.closedAt).getTime() : NaN;
  return {
    positionId: row.positionId ?? 'unknown',
    tokenMint: row.tokenMint,
    exitReason: row.exitReason ?? 'unknown',
    armName: row.armName ?? 'unknown',
    parameterVersion: row.parameterVersion ?? 'unknown',
    netSol,
    walletTruthSource: 'unknown',
    win: netSol > 0,
    mfePctPeak,
    actualMfePctPeak: null,
    maePct: typeof row.maePct === 'number' ? row.maePct : null,
    actualMaePct: null,
    entryAdvantagePct: null,
    swapQuoteEntryAdvantagePct: null,
    swapQuoteEntryPrice: null,
    referenceToSwapQuotePct: null,
    entryFillOutputRatio: null,
    entryAdvantageArtifact: false,
    buyLagSec: null,
    buyExecutionSec: null,
    referenceAgeSec: null,
    signalToReferenceSec: null,
    partialFillDataMissing: false,
    partialFillDataReason: undefined,
    holdSec: row.holdSec,
    t1Visited: row.t1VisitAtSec != null || mfePctPeak >= 0.5,
    t2Visited: row.t2VisitAtSec != null || mfePctPeak >= 4,
    t3Visited: row.t3VisitAtSec != null || mfePctPeak >= 9,
    actualT1Visited: false,
    actualT2Visited: false,
    actualT3Visited: false,
    independentKolCount: row.independentKolCount,
    kolScore: row.kolScore,
    recordedAtMs: Number.isFinite(closedAtMs) ? closedAtMs : 0,
    orphanSell: false,
  };
}

function mean(xs: number[]): number {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function meanKnown(xs: Array<number | null>): number {
  return mean(xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)));
}

function maxKnown(xs: Array<number | null>): number {
  const known = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return known.length > 0 ? Math.max(...known) : 0;
}

function maxDrawdownSol(trades: PairedKolLiveTrade[]): number {
  const ordered = [...trades].sort((a, b) => a.recordedAtMs - b.recordedAtMs);
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of ordered) {
    cumulative += trade.netSol;
    if (cumulative > peak) peak = cumulative;
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  return maxDrawdown;
}

function summarizeBucket(bucket: string, trades: PairedKolLiveTrade[]): BucketSummary {
  const netSols = trades.map((trade) => trade.netSol);
  return {
    bucket,
    trades: trades.length,
    netSol: netSols.reduce((a, b) => a + b, 0),
    winRate: trades.length > 0 ? trades.filter((trade) => trade.win).length / trades.length : 0,
    avgNetSol: mean(netSols),
    avgMfePct: mean(trades.map((trade) => trade.mfePctPeak)),
    avgActualMfePct: meanKnown(trades.map((trade) => trade.actualMfePctPeak)),
    avgEntryAdvantagePct: meanKnown(trades
      .filter((trade) => !trade.entryAdvantageArtifact)
      .map((trade) => trade.entryAdvantagePct)),
    avgSwapQuoteEntryAdvantagePct: meanKnown(trades
      .filter((trade) => !trade.entryAdvantageArtifact)
      .map((trade) => trade.swapQuoteEntryAdvantagePct)),
    avgReferenceToSwapQuotePct: meanKnown(trades
      .filter((trade) => !trade.entryAdvantageArtifact)
      .map((trade) => trade.referenceToSwapQuotePct)),
    avgBuyLagSec: meanKnown(trades.map((trade) => trade.buyLagSec)),
    avgBuyExecutionSec: meanKnown(trades.map((trade) => trade.buyExecutionSec)),
    avgReferenceAgeSec: meanKnown(trades.map((trade) => trade.referenceAgeSec)),
    avgSignalToReferenceSec: meanKnown(trades.map((trade) => trade.signalToReferenceSec)),
    partialFillDataMissingTrades: trades.filter((trade) => trade.partialFillDataMissing).length,
    t1Visits: trades.filter((trade) => trade.t1Visited).length,
    t2Visits: trades.filter((trade) => trade.t2Visited).length,
    t3Visits: trades.filter((trade) => trade.t3Visited).length,
    fiveXVisits: trades.filter((trade) => trade.mfePctPeak >= 4).length,
    actualFiveXVisits: trades.filter((trade) => (trade.actualMfePctPeak ?? 0) >= 4).length,
    hardcuts: trades.filter((trade) => trade.exitReason === 'probe_hard_cut').length,
  };
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const arr = map.get(key) ?? [];
    arr.push(item);
    map.set(key, arr);
  }
  return map;
}

function summariesBy(trades: PairedKolLiveTrade[], keyOf: (item: PairedKolLiveTrade) => string): BucketSummary[] {
  return [...groupBy(trades, keyOf).entries()]
    .map(([bucket, rows]) => summarizeBucket(bucket, rows))
    .sort((a, b) => b.netSol - a.netSol || b.trades - a.trades || a.bucket.localeCompare(b.bucket));
}

function independentKolBucket(trade: PairedKolLiveTrade): string {
  if (typeof trade.independentKolCount !== 'number') return 'unknown';
  if (trade.independentKolCount >= 3) return '3+';
  return String(trade.independentKolCount);
}

function slippageBucket(trade: PairedKolLiveTrade): string {
  const bps = Math.max(
    Math.abs(trade.entrySlippageBps ?? 0),
    Math.abs(trade.exitSlippageBps ?? 0)
  );
  if (trade.entrySlippageBps == null && trade.exitSlippageBps == null) return 'unknown';
  if (bps < 100) return '<100bps';
  if (bps < 1000) return '100-999bps';
  return '>=1000bps';
}

function entryAdvantageBucket(trade: PairedKolLiveTrade): string {
  const v = trade.entryAdvantagePct;
  if (v == null) return 'unknown';
  if (trade.entryAdvantageArtifact) return 'artifact_abs>=1000%';
  if (v <= -0.5) return '<=-50% favorable';
  if (v <= -0.2) return '-50..-20% favorable';
  if (v < -0.05) return '-20..-5% favorable';
  if (v <= 0.05) return '-5..5% neutral';
  if (v <= 0.2) return '5..20% adverse';
  if (v <= 1) return '20..100% adverse';
  return '>100% adverse';
}

function buyLagBucket(trade: PairedKolLiveTrade): string {
  const v = trade.buyLagSec;
  if (v == null || !Number.isFinite(v)) return 'unknown';
  if (v < 0) return '<0s clock_skew';
  if (v <= 30) return '0-30s';
  if (v <= 90) return '31-90s';
  if (v <= 180) return '91-180s';
  return '>180s';
}

function buyExecutionBucket(trade: PairedKolLiveTrade): string {
  const v = trade.buyExecutionSec;
  if (v == null || !Number.isFinite(v)) return 'unknown';
  if (v <= 5) return '0-5s';
  if (v <= 15) return '5-15s';
  if (v <= 30) return '15-30s';
  if (v <= 90) return '30-90s';
  return '>90s';
}

function referenceToSwapQuoteBucket(trade: PairedKolLiveTrade): string {
  const v = trade.referenceToSwapQuotePct;
  if (v == null || !Number.isFinite(v)) return 'unknown';
  if (v <= -0.2) return '<=-20% fresh_better';
  if (v < -0.05) return '-20..-5% fresh_better';
  if (v <= 0.05) return '-5..5% aligned';
  if (v <= 0.2) return '5..20% fresh_worse';
  if (v <= 1) return '20..100% fresh_worse';
  return '>100% fresh_worse';
}

function fillDataQualityBucket(trade: PairedKolLiveTrade): string {
  if (trade.partialFillDataMissing) return 'forced_planned_fill_metrics';
  return 'measured_fill_metrics';
}

function fillFallbackReasonBucket(trade: PairedKolLiveTrade): string {
  if (!trade.partialFillDataMissing) return 'measured_fill_metrics';
  return trade.partialFillDataReason ?? 'legacy_unknown_reason';
}

function actualMfeBucket(trade: PairedKolLiveTrade): string {
  const v = trade.actualMfePctPeak;
  if (v == null) return 'unknown';
  if (v >= 4) return '>=5x';
  if (v >= 1) return '>=2x';
  if (v >= 0.5) return '>=50%';
  return '<50%';
}

function armBucket(trade: PairedKolLiveTrade): string {
  return `${trade.armName}/${trade.parameterVersion}`;
}

const ENTRY_ADVANTAGE_ANOMALY_ABS_PCT = 0.5;
const ENTRY_ADVANTAGE_ARTIFACT_ABS_PCT = 10;

function isEntryAdvantageArtifactPct(entryAdvantagePct: number | null): boolean {
  return entryAdvantagePct != null && Math.abs(entryAdvantagePct) >= ENTRY_ADVANTAGE_ARTIFACT_ABS_PCT;
}

function isEntryAdvantageArtifact(trade: PairedKolLiveTrade): boolean {
  return !trade.partialFillDataMissing && trade.entryAdvantageArtifact;
}

function isEntryAdvantageAnomaly(trade: PairedKolLiveTrade): boolean {
  return !trade.partialFillDataMissing &&
    !trade.entryAdvantageArtifact &&
    trade.entryAdvantagePct != null &&
    Math.abs(trade.entryAdvantagePct) >= ENTRY_ADVANTAGE_ANOMALY_ABS_PCT;
}

function isEntryAdvantageAdverse(trade: PairedKolLiveTrade): boolean {
  return isEntryAdvantageAnomaly(trade) && (trade.entryAdvantagePct ?? 0) > 0;
}

function isEntryAdvantageFavorable(trade: PairedKolLiveTrade): boolean {
  return isEntryAdvantageAnomaly(trade) && (trade.entryAdvantagePct ?? 0) < 0;
}

function isLegacyPartialFillDataMissing(trade: PairedKolLiveTrade): boolean {
  return trade.partialFillDataMissing && !trade.partialFillDataReason;
}

function isKolLivePostCloseMissedAlpha(row: MissedAlphaLedgerRecord): row is KolLivePostCloseMissedAlphaRecord {
  if (row.lane !== 'kol_hunter' || !row.eventId || !row.tokenMint || !row.rejectedAt || !row.probe) return false;
  if (row.extras?.isLive !== true) return false;
  return row.rejectCategory === 'kol_close' || typeof row.extras?.elapsedSecAtClose === 'number';
}

function groupPostCloseMissedAlpha(
  records: MissedAlphaLedgerRecord[],
  since?: Date
): MissedAlphaEventGroup[] {
  const groups = new Map<string, MissedAlphaEventGroup>();
  for (const row of records) {
    if (!isKolLivePostCloseMissedAlpha(row) || !within(since, row.rejectedAt)) continue;
    const rejectedAtMs = new Date(row.rejectedAt).getTime();
    if (!Number.isFinite(rejectedAtMs)) continue;
    const key = row.eventId;
    let group = groups.get(key);
    if (!group) {
      const positionId = typeof row.extras?.positionId === 'string' ? row.extras.positionId : undefined;
      group = {
        eventId: key,
        tokenMint: row.tokenMint,
        positionId,
        rejectReason: row.rejectReason ?? 'unknown',
        rejectedAt: row.rejectedAt,
        rejectedAtMs,
        probes: [],
      };
      groups.set(key, group);
    }
    group.probes.push(row.probe);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    probes: group.probes.sort((a, b) => (a.offsetSec ?? 0) - (b.offsetSec ?? 0)),
  }));
}

function findPostCloseMissedAlphaGroup(
  trade: PairedKolLiveTrade,
  groups: MissedAlphaEventGroup[]
): MissedAlphaEventGroup | undefined {
  if (!trade.tokenMint) return undefined;
  const maxSkewMs = 15 * 60 * 1000;
  const exactPositionGroups = groups
    .filter((group) =>
      group.positionId === trade.positionId &&
      group.tokenMint === trade.tokenMint &&
      group.rejectReason === trade.exitReason
    )
    .sort((a, b) => Math.abs(a.rejectedAtMs - trade.recordedAtMs) - Math.abs(b.rejectedAtMs - trade.recordedAtMs));
  if (exactPositionGroups[0]) return exactPositionGroups[0];
  const fallbackGroups = groups
    .filter((group) =>
      group.tokenMint === trade.tokenMint &&
      group.rejectReason === trade.exitReason &&
      Math.abs(group.rejectedAtMs - trade.recordedAtMs) <= maxSkewMs
    )
    .sort((a, b) => Math.abs(a.rejectedAtMs - trade.recordedAtMs) - Math.abs(b.rejectedAtMs - trade.recordedAtMs));
  return fallbackGroups[0];
}

function probeStatusCounts(probes: MissedAlphaProbeLedger[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const probe of probes) {
    const key = probe.quoteStatus ?? 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function realPostCloseProbes(probes: MissedAlphaProbeLedger[]): MissedAlphaProbeLedger[] {
  return probes.filter((probe) => probe.quoteStatus !== 'scheduled' && (probe.offsetSec ?? 0) > 0);
}

function mergeCountMaps(maps: Array<Record<string, number>>): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const map of maps) {
    for (const [key, value] of Object.entries(map)) {
      merged[key] = (merged[key] ?? 0) + value;
    }
  }
  return merged;
}

function summarizePostCloseAlphaTrade(
  trade: PairedKolLiveTrade,
  group: MissedAlphaEventGroup
): PostCloseAlphaTradeSummary {
  const realProbes = realPostCloseProbes(group.probes);
  const knownDeltaProbes = realProbes
    .filter((probe) => typeof probe.deltaPct === 'number' && Number.isFinite(probe.deltaPct));
  const maxProbe = knownDeltaProbes
    .sort((a, b) => (b.deltaPct ?? Number.NEGATIVE_INFINITY) - (a.deltaPct ?? Number.NEGATIVE_INFINITY))
    [0];
  return {
    positionId: trade.positionId,
    tokenMint: trade.tokenMint,
    exitReason: trade.exitReason,
    netSol: trade.netSol,
    actualMfePctPeak: trade.actualMfePctPeak,
    matchedEventId: group.eventId,
    rejectedAt: group.rejectedAt,
    maxDeltaPct: maxProbe?.deltaPct ?? null,
    maxDeltaOffsetSec: maxProbe?.offsetSec ?? null,
    okProbes: realProbes.filter((probe) => probe.quoteStatus === 'ok').length,
    totalProbes: realProbes.length,
    quoteStatuses: probeStatusCounts(group.probes),
  };
}

function summarizePostCloseAlphaBucket(
  bucket: string,
  trades: PairedKolLiveTrade[],
  summaries: PostCloseAlphaTradeSummary[]
): PostCloseAlphaBucketSummary {
  const byPosition = new Map(summaries.map((summary) => [summary.positionId, summary]));
  const bucketSummaries = trades
    .map((trade) => byPosition.get(trade.positionId))
    .filter((summary): summary is PostCloseAlphaTradeSummary => summary != null);
  return {
    bucket,
    trades: trades.length,
    matchedTrades: bucketSummaries.length,
    okProbeTrades: bucketSummaries.filter((summary) => summary.okProbes > 0).length,
    postCloseT1Trades: bucketSummaries.filter((summary) => (summary.maxDeltaPct ?? 0) >= 0.5).length,
    postCloseT2Trades: bucketSummaries.filter((summary) => (summary.maxDeltaPct ?? 0) >= 4).length,
    netSol: trades.reduce((acc, trade) => acc + trade.netSol, 0),
    avgMaxDeltaPct: meanKnown(bucketSummaries.map((summary) => summary.maxDeltaPct)),
    maxDeltaPct: maxKnown(bucketSummaries.map((summary) => summary.maxDeltaPct)),
  };
}

function summarizePostCloseAlphaDiagnostics(
  trades: PairedKolLiveTrade[],
  records: MissedAlphaLedgerRecord[],
  since?: Date
): { summary: PostCloseAlphaDiagnosticsSummary; candidates: PostCloseAlphaTradeSummary[] } {
  const groups = groupPostCloseMissedAlpha(records, since);
  const matched = trades
    .map((trade) => {
      const group = findPostCloseMissedAlphaGroup(trade, groups);
      return group ? summarizePostCloseAlphaTrade(trade, group) : null;
    })
    .filter((summary): summary is PostCloseAlphaTradeSummary => summary != null);
  const statusCounts = mergeCountMaps(matched.map((summary) => summary.quoteStatuses));
  const byExitReason = [...groupBy(trades, (trade) => trade.exitReason).entries()]
    .map(([bucket, rows]) => summarizePostCloseAlphaBucket(bucket, rows, matched))
    .sort((a, b) => b.maxDeltaPct - a.maxDeltaPct || b.matchedTrades - a.matchedTrades || a.bucket.localeCompare(b.bucket));
  const candidates = [...matched]
    .filter((summary) => summary.maxDeltaPct != null)
    .sort((a, b) =>
      (b.maxDeltaPct ?? Number.NEGATIVE_INFINITY) - (a.maxDeltaPct ?? Number.NEGATIVE_INFINITY) ||
      b.netSol - a.netSol ||
      a.positionId.localeCompare(b.positionId)
    )
    .slice(0, 5);

  return {
    summary: {
      matchedClosedTrades: matched.length,
      unmatchedClosedTrades: trades.length - matched.length,
      okProbeTrades: matched.filter((summary) => summary.okProbes > 0).length,
      postCloseT1Trades: matched.filter((summary) => (summary.maxDeltaPct ?? 0) >= 0.5).length,
      postCloseT2Trades: matched.filter((summary) => (summary.maxDeltaPct ?? 0) >= 4).length,
      maxPostCloseDeltaPct: maxKnown(matched.map((summary) => summary.maxDeltaPct)),
      probeStatusCounts: statusCounts,
      byExitReason,
    },
    candidates,
  };
}

function runnerCandidateScore(trade: PairedKolLiveTrade): number {
  return trade.actualMfePctPeak ?? trade.mfePctPeak;
}

function summarizeRunnerDiagnostics(trades: PairedKolLiveTrade[]): RunnerDiagnosticsSummary {
  return {
    actualT1Visits: trades.filter((trade) => trade.actualT1Visited).length,
    actualT2Visits: trades.filter((trade) => trade.actualT2Visited).length,
    actualFiveXVisits: trades.filter((trade) => (trade.actualMfePctPeak ?? 0) >= 4).length,
    maxActualMfePct: maxKnown(trades.map((trade) => trade.actualMfePctPeak)),
    maxRefMfePct: maxKnown(trades.map((trade) => trade.mfePctPeak)),
    nearActualT1Trades: trades.filter((trade) =>
      trade.actualMfePctPeak != null &&
      trade.actualMfePctPeak >= 0.25 &&
      trade.actualMfePctPeak < 0.5
    ).length,
    referenceOnlyT1Trades: trades.filter((trade) => trade.t1Visited && !trade.actualT1Visited).length,
    preT1Hardcuts: trades.filter((trade) =>
      trade.exitReason === 'probe_hard_cut' &&
      (trade.actualMfePctPeak == null || trade.actualMfePctPeak < 0.5)
    ).length,
    byExitReason: summariesBy(trades, (trade) => trade.exitReason),
    byActualMfeBucket: summariesBy(trades, actualMfeBucket),
  };
}

const RUNNERLESS_COHORT_MIN_TRADES = 10;

function summarizeRunnerlessCohortCandidate(
  dimension: string,
  bucket: string,
  trades: PairedKolLiveTrade[]
): RunnerlessCohortCandidate | null {
  const summary = summarizeBucket(bucket, trades);
  const actualMfeKnownTrades = trades.filter((trade) => trade.actualMfePctPeak != null).length;
  const actualT1Visits = trades.filter((trade) => trade.actualT1Visited).length;
  const actualT2Visits = trades.filter((trade) => trade.actualT2Visited).length;
  const actualFiveXVisits = trades.filter((trade) => (trade.actualMfePctPeak ?? 0) >= 4).length;
  if (
    actualMfeKnownTrades < RUNNERLESS_COHORT_MIN_TRADES ||
    summary.netSol >= 0 ||
    actualT2Visits > 0 ||
    actualFiveXVisits > 0
  ) {
    return null;
  }
  return {
    dimension,
    bucket,
    trades: summary.trades,
    actualMfeKnownTrades,
    netSol: summary.netSol,
    avgNetSol: summary.avgNetSol,
    winRate: summary.winRate,
    avgActualMfePct: summary.avgActualMfePct,
    actualT1Visits,
    actualT2Visits,
    actualFiveXVisits,
    hardcuts: summary.hardcuts,
    reason: `net_negative_no_actual_runner_min${RUNNERLESS_COHORT_MIN_TRADES}`,
  };
}

function summarizeRunnerlessQuarantineCandidates(trades: PairedKolLiveTrade[]): RunnerlessCohortCandidate[] {
  const dimensions: Array<{
    dimension: string;
    keyOf: (trade: PairedKolLiveTrade) => string;
    include?: (trade: PairedKolLiveTrade) => boolean;
    includeUnknown?: boolean;
  }> = [
    { dimension: 'arm', keyOf: armBucket, includeUnknown: true },
    { dimension: 'independent_kol_count', keyOf: independentKolBucket, includeUnknown: true },
    { dimension: 'slippage', keyOf: slippageBucket, includeUnknown: true },
    { dimension: 'buy_lag', keyOf: buyLagBucket, includeUnknown: true },
    { dimension: 'buy_execution', keyOf: buyExecutionBucket },
    { dimension: 'reference_to_fresh_quote', keyOf: referenceToSwapQuoteBucket },
    { dimension: 'entry_advantage', keyOf: entryAdvantageBucket, includeUnknown: true },
    { dimension: 'fill_data_quality', keyOf: fillDataQualityBucket, includeUnknown: true },
    {
      dimension: 'fill_fallback_reason',
      keyOf: fillFallbackReasonBucket,
      include: (trade) => trade.partialFillDataMissing,
      includeUnknown: true,
    },
  ];
  const candidates: RunnerlessCohortCandidate[] = [];
  for (const definition of dimensions) {
    const rowsForDimension = definition.include ? trades.filter(definition.include) : trades;
    for (const [bucket, rows] of groupBy(rowsForDimension, definition.keyOf).entries()) {
      if (!definition.includeUnknown && bucket === 'unknown') continue;
      const candidate = summarizeRunnerlessCohortCandidate(definition.dimension, bucket, rows);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates
    .sort((a, b) =>
      a.netSol - b.netSol ||
      b.trades - a.trades ||
      a.dimension.localeCompare(b.dimension) ||
      a.bucket.localeCompare(b.bucket)
    )
    .slice(0, 10);
}

function summarizePaperFallbacks(
  paperTrades: KolPaperTradeLedger[],
  predicate: (row: KolPaperTradeLedger) => boolean,
  since?: Date
): PaperFallbackSummary {
  const trades = paperTrades
    .filter((row) => predicate(row) && within(since, row.closedAt))
    .map(paperFallbackToTrade);
  const netSols = trades.map((trade) => trade.netSol);
  return {
    closedPaperFallbacks: trades.length,
    netSol: netSols.reduce((a, b) => a + b, 0),
    winRate: trades.length > 0 ? trades.filter((trade) => trade.win).length / trades.length : 0,
    avgNetSol: mean(netSols),
    avgMfePct: mean(trades.map((trade) => trade.mfePctPeak)),
    t1Visits: trades.filter((trade) => trade.t1Visited).length,
    t2Visits: trades.filter((trade) => trade.t2Visited).length,
    t3Visits: trades.filter((trade) => trade.t3Visited).length,
    fiveXVisits: trades.filter((trade) => trade.mfePctPeak >= 4).length,
    hardcuts: trades.filter((trade) => trade.exitReason === 'probe_hard_cut').length,
    byExitReason: summariesBy(trades, (trade) => trade.exitReason),
  };
}

function summarizeExecutionQualityCooldownFallbacks(
  paperTrades: KolPaperTradeLedger[],
  since?: Date
): PaperFallbackSummary {
  return summarizePaperFallbacks(paperTrades, isExecutionQualityCooldownPaperFallback, since);
}

function summarizeFreshReferenceRejectFallbacks(
  paperTrades: KolPaperTradeLedger[],
  since?: Date
): PaperFallbackSummary {
  return summarizePaperFallbacks(paperTrades, isFreshReferenceRejectPaperFallback, since);
}

const PHASE4_MIN_CLOSED_LIVE_TRADES = 50;

function evaluatePhase4Gate(metrics: {
  closedTrades: number;
  netSol: number;
  actualT2Visits: number;
  actualFiveXVisits: number;
  partialFillDataMissingTrades: number;
  knownPartialFillDataMissingTrades: number;
  legacyPartialFillDataMissingTrades: number;
  orphanSells: number;
  entryAdvantageAnomalyTrades: number;
  entryAdvantageArtifactTrades: number;
  executionQualityCooldown: PaperFallbackSummary;
  freshReferenceReject: PaperFallbackSummary;
}): Phase4GateSummary {
  const hasActualRunner = metrics.actualT2Visits > 0 || metrics.actualFiveXVisits > 0;
  const executionQualityCooldownBlockedRunner =
    metrics.executionQualityCooldown.t2Visits > 0 ||
    metrics.executionQualityCooldown.fiveXVisits > 0;
  const freshReferenceRejectBlockedRunner =
    metrics.freshReferenceReject.t2Visits > 0 ||
    metrics.freshReferenceReject.fiveXVisits > 0;
  const dataQualityClear = metrics.partialFillDataMissingTrades === 0 &&
    metrics.orphanSells === 0 &&
    metrics.entryAdvantageAnomalyTrades === 0 &&
    metrics.entryAdvantageArtifactTrades === 0;
  const guardCalibrationClear = !executionQualityCooldownBlockedRunner && !freshReferenceRejectBlockedRunner;
  const reasons: string[] = [];

  reasons.push(`${metrics.closedTrades}/${PHASE4_MIN_CLOSED_LIVE_TRADES} closed live trades sampled`);
  if (hasActualRunner) {
    reasons.push(`actual runner observed: T2=${metrics.actualT2Visits}, 5x=${metrics.actualFiveXVisits}`);
  } else {
    reasons.push('no actual live T2/5x runner observed');
  }

  reasons.push(`netSol=${metrics.netSol.toFixed(6)}`);

  if (!dataQualityClear) {
    reasons.push(
      `manual reconciliation required: forced planned fill metrics=${metrics.partialFillDataMissingTrades} ` +
      `(known_reason=${metrics.knownPartialFillDataMissingTrades}, ` +
      `legacy_unknown=${metrics.legacyPartialFillDataMissingTrades}), ` +
      `orphan sells=${metrics.orphanSells}, ` +
      `entry advantage anomalies=${metrics.entryAdvantageAnomalyTrades}, ` +
      `entry advantage artifacts=${metrics.entryAdvantageArtifactTrades}`
    );
  }

  if (executionQualityCooldownBlockedRunner) {
    reasons.push(
      `execution quality cooldown guard calibration review required: ` +
      `fallbacks=${metrics.executionQualityCooldown.closedPaperFallbacks}, ` +
      `T2=${metrics.executionQualityCooldown.t2Visits}, ` +
      `5x=${metrics.executionQualityCooldown.fiveXVisits}, ` +
      `netSol=${metrics.executionQualityCooldown.netSol.toFixed(6)}`
    );
  }

  if (!guardCalibrationClear) {
    if (freshReferenceRejectBlockedRunner) {
      reasons.push(
        `fresh reference guard calibration review required: ` +
        `fallbacks=${metrics.freshReferenceReject.closedPaperFallbacks}, ` +
        `T2=${metrics.freshReferenceReject.t2Visits}, ` +
        `5x=${metrics.freshReferenceReject.fiveXVisits}, ` +
        `netSol=${metrics.freshReferenceReject.netSol.toFixed(6)}`
      );
    }
  }

  let verdict: Phase4GateVerdict;
  if (metrics.closedTrades < PHASE4_MIN_CLOSED_LIVE_TRADES) {
    verdict = 'CONTINUE_SAMPLE';
  } else if (hasActualRunner && metrics.netSol > 0 && dataQualityClear && guardCalibrationClear) {
    verdict = 'PHASE5_READY';
  } else if (hasActualRunner || metrics.netSol > 0 || !guardCalibrationClear) {
    verdict = 'HOLD_REVIEW';
  } else {
    verdict = 'PAUSE_REVIEW';
  }

  return {
    verdict,
    minClosedTrades: PHASE4_MIN_CLOSED_LIVE_TRADES,
    closedTrades: metrics.closedTrades,
    hasActualRunner,
    dataQualityClear,
    guardCalibrationClear,
    partialFillDataMissingTrades: metrics.partialFillDataMissingTrades,
    knownPartialFillDataMissingTrades: metrics.knownPartialFillDataMissingTrades,
    legacyPartialFillDataMissingTrades: metrics.legacyPartialFillDataMissingTrades,
    entryAdvantageAnomalyTrades: metrics.entryAdvantageAnomalyTrades,
    entryAdvantageArtifactTrades: metrics.entryAdvantageArtifactTrades,
    executionQualityCooldownPaperFallbacks: metrics.executionQualityCooldown.closedPaperFallbacks,
    executionQualityCooldownT2Visits: metrics.executionQualityCooldown.t2Visits,
    executionQualityCooldownFiveXVisits: metrics.executionQualityCooldown.fiveXVisits,
    freshReferenceRejectPaperFallbacks: metrics.freshReferenceReject.closedPaperFallbacks,
    freshReferenceRejectT2Visits: metrics.freshReferenceReject.t2Visits,
    freshReferenceRejectFiveXVisits: metrics.freshReferenceReject.fiveXVisits,
    reasons,
  };
}

function buildCanaryBudgetProjection(
  allKolLiveTrades: PairedKolLiveTrade[],
  input: CanaryBudgetProjectionInput
): CanaryBudgetProjection {
  const cumulativeKolPnlSol = allKolLiveTrades.reduce((acc, trade) => acc + trade.netSol, 0);
  const walletRoomSol = Math.max(0, input.walletSol - input.walletFloorSol);
  const remainingKolBudgetSol = Math.max(0, input.kolCanaryCapSol + cumulativeKolPnlSol);
  const projectedWalletAtBudgetExhaustionSol = input.walletSol - remainingKolBudgetSol;
  const projectedFloorBufferSol = projectedWalletAtBudgetExhaustionSol - input.walletFloorSol;
  const approxFullTicketLosers = input.kolTicketSol > 0
    ? Math.floor(remainingKolBudgetSol / input.kolTicketSol)
    : 0;
  const capExhausted = cumulativeKolPnlSol <= -input.kolCanaryCapSol;
  const minFloorBufferSol = Math.max(0.02, input.kolTicketSol);

  let verdict: CanaryBudgetProjectionVerdict;
  let reason: string;
  if (capExhausted) {
    verdict = 'BLOCKED';
    reason = `KOL canary cumulative PnL ${sol(cumulativeKolPnlSol)} is at or below cap -${sol(input.kolCanaryCapSol)}.`;
  } else if (projectedFloorBufferSol < minFloorBufferSol) {
    verdict = 'FLOOR_RISK';
    reason = `Projected floor buffer ${sol(projectedFloorBufferSol)} is below minimum buffer ${sol(minFloorBufferSol)}.`;
  } else {
    verdict = 'RESUME_POSSIBLE';
    reason = `Projected floor buffer ${sol(projectedFloorBufferSol)} remains above minimum buffer ${sol(minFloorBufferSol)}.`;
  }

  return {
    walletSol: input.walletSol,
    walletFloorSol: input.walletFloorSol,
    walletRoomSol,
    kolCanaryCapSol: input.kolCanaryCapSol,
    cumulativeKolPnlSol,
    remainingKolBudgetSol,
    projectedWalletAtBudgetExhaustionSol,
    projectedFloorBufferSol,
    kolTicketSol: input.kolTicketSol,
    approxFullTicketLosers,
    capExhausted,
    verdict,
    reason,
  };
}

function buildKolLiveCanaryReport(
  buys: KolLiveBuyLedger[],
  sells: KolLiveSellLedger[],
  since?: Date,
  paperTrades: KolPaperTradeLedger[] = [],
  missedAlphaRecords: MissedAlphaLedgerRecord[] = [],
  options: BuildKolLiveCanaryReportOptions = {}
): KolLiveCanaryReport {
  const { trades, openBuys, orphanSells } = pairKolLiveTrades(buys, sells, since);
  const allKolLiveTrades = options.canaryBudgetProjection
    ? pairKolLiveTrades(buys, sells).trades
    : [];
  const executionQualityCooldown = summarizeExecutionQualityCooldownFallbacks(paperTrades, since);
  const freshReferenceReject = summarizeFreshReferenceRejectFallbacks(paperTrades, since);
  const postCloseAlpha = summarizePostCloseAlphaDiagnostics(trades, missedAlphaRecords, since);
  const walletTruthSources: Record<string, number> = {};
  for (const trade of trades) {
    walletTruthSources[trade.walletTruthSource] = (walletTruthSources[trade.walletTruthSource] ?? 0) + 1;
  }
  const netSols = trades.map((trade) => trade.netSol);
  const measurementMismatchTrades = [...trades]
    .filter((trade) => trade.actualMfePctPeak != null)
    .sort((a, b) =>
      Math.abs((b.actualMfePctPeak ?? 0) - b.mfePctPeak) -
      Math.abs((a.actualMfePctPeak ?? 0) - a.mfePctPeak)
    )
    .slice(0, 5);
  const entryAdvantageAnomalies = [...trades]
    .filter(isEntryAdvantageAnomaly)
    .sort((a, b) => Math.abs(b.entryAdvantagePct ?? 0) - Math.abs(a.entryAdvantagePct ?? 0))
    .slice(0, 5);
  const entryAdvantageArtifacts = [...trades]
    .filter(isEntryAdvantageArtifact)
    .sort((a, b) => Math.abs(b.entryAdvantagePct ?? 0) - Math.abs(a.entryAdvantagePct ?? 0))
    .slice(0, 5);
  const forcedPlannedFillTrades = [...trades]
    .filter((trade) => trade.partialFillDataMissing)
    .sort((a, b) => b.recordedAtMs - a.recordedAtMs || a.positionId.localeCompare(b.positionId))
    .slice(0, 5);
  const runnerCandidateTrades = [...trades]
    .filter((trade) =>
      trade.actualMfePctPeak != null ||
      (typeof trade.mfePctPeak === 'number' && Number.isFinite(trade.mfePctPeak))
    )
    .sort((a, b) =>
      runnerCandidateScore(b) - runnerCandidateScore(a) ||
      b.netSol - a.netSol ||
      a.positionId.localeCompare(b.positionId)
    )
    .slice(0, 5);
  const closedTrades = trades.length;
  const netSol = netSols.reduce((a, b) => a + b, 0);
  const actualT1Visits = trades.filter((trade) => trade.actualT1Visited).length;
  const actualT2Visits = trades.filter((trade) => trade.actualT2Visited).length;
  const actualT3Visits = trades.filter((trade) => trade.actualT3Visited).length;
  const actualFiveXVisits = trades.filter((trade) => (trade.actualMfePctPeak ?? 0) >= 4).length;
  const partialFillDataMissingTrades = trades.filter((trade) => trade.partialFillDataMissing).length;
  const legacyPartialFillDataMissingTrades = trades.filter(isLegacyPartialFillDataMissing).length;
  const knownPartialFillDataMissingTrades = partialFillDataMissingTrades - legacyPartialFillDataMissingTrades;
  const entryAdvantageAnomalyTrades = trades.filter(isEntryAdvantageAnomaly).length;
  const entryAdvantageArtifactTrades = trades.filter(isEntryAdvantageArtifact).length;
  const entryAdvantageAdverseTrades = trades.filter(isEntryAdvantageAdverse).length;
  const entryAdvantageFavorableTrades = trades.filter(isEntryAdvantageFavorable).length;
  const runnerDiagnostics = summarizeRunnerDiagnostics(trades);
  const runnerlessQuarantineCandidates = summarizeRunnerlessQuarantineCandidates(trades);
  const phase4Gate = evaluatePhase4Gate({
    closedTrades,
    netSol,
    actualT2Visits,
    actualFiveXVisits,
    partialFillDataMissingTrades,
    knownPartialFillDataMissingTrades,
    legacyPartialFillDataMissingTrades,
    orphanSells,
    entryAdvantageAnomalyTrades,
    entryAdvantageArtifactTrades,
    executionQualityCooldown,
    freshReferenceReject,
  });

  return {
    generatedAt: new Date().toISOString(),
    since: since?.toISOString(),
    closedTrades,
    openBuys,
    orphanSells,
    netSol,
    winRate: trades.length > 0 ? trades.filter((trade) => trade.win).length / trades.length : 0,
    avgNetSol: mean(netSols),
    avgMfePct: mean(trades.map((trade) => trade.mfePctPeak)),
    avgActualMfePct: meanKnown(trades.map((trade) => trade.actualMfePctPeak)),
    avgEntryAdvantagePct: meanKnown(trades
      .filter((trade) => !trade.entryAdvantageArtifact)
      .map((trade) => trade.entryAdvantagePct)),
    avgSwapQuoteEntryAdvantagePct: meanKnown(trades
      .filter((trade) => !trade.entryAdvantageArtifact)
      .map((trade) => trade.swapQuoteEntryAdvantagePct)),
    avgReferenceToSwapQuotePct: meanKnown(trades
      .filter((trade) => !trade.entryAdvantageArtifact)
      .map((trade) => trade.referenceToSwapQuotePct)),
    avgBuyLagSec: meanKnown(trades.map((trade) => trade.buyLagSec)),
    avgBuyExecutionSec: meanKnown(trades.map((trade) => trade.buyExecutionSec)),
    avgReferenceAgeSec: meanKnown(trades.map((trade) => trade.referenceAgeSec)),
    avgSignalToReferenceSec: meanKnown(trades.map((trade) => trade.signalToReferenceSec)),
    partialFillDataMissingTrades,
    knownPartialFillDataMissingTrades,
    legacyPartialFillDataMissingTrades,
    entryAdvantageAnomalyTrades,
    entryAdvantageArtifactTrades,
    entryAdvantageAdverseTrades,
    entryAdvantageFavorableTrades,
    maxDrawdownSol: maxDrawdownSol(trades),
    t1Visits: trades.filter((trade) => trade.t1Visited).length,
    t2Visits: trades.filter((trade) => trade.t2Visited).length,
    t3Visits: trades.filter((trade) => trade.t3Visited).length,
    fiveXVisits: trades.filter((trade) => trade.mfePctPeak >= 4).length,
    actualT1Visits,
    actualT2Visits,
    actualT3Visits,
    actualFiveXVisits,
    hardcuts: trades.filter((trade) => trade.exitReason === 'probe_hard_cut').length,
    walletTruthSources,
    byExitReason: summariesBy(trades, (trade) => trade.exitReason),
    byIndependentKolCount: summariesBy(trades, independentKolBucket),
    bySlippageBucket: summariesBy(trades, slippageBucket),
    byBuyLagBucket: summariesBy(trades, buyLagBucket),
    byBuyExecutionBucket: summariesBy(trades, buyExecutionBucket),
    byReferenceToSwapQuoteBucket: summariesBy(trades, referenceToSwapQuoteBucket),
    byFillDataQualityBucket: summariesBy(trades, fillDataQualityBucket),
    byFillFallbackReasonBucket: summariesBy(trades, fillFallbackReasonBucket),
    byEntryAdvantageBucket: summariesBy(trades, entryAdvantageBucket),
    byActualMfeBucket: summariesBy(trades, actualMfeBucket),
    byArm: summariesBy(trades, armBucket),
    worstTrades: [...trades].sort((a, b) => a.netSol - b.netSol).slice(0, 5),
    measurementMismatchTrades,
    forcedPlannedFillTrades,
    entryAdvantageAnomalies,
    entryAdvantageArtifacts,
    runnerDiagnostics,
    runnerCandidateTrades,
    runnerlessQuarantineCandidates,
    postCloseAlphaDiagnostics: postCloseAlpha.summary,
    postCloseAlphaCandidateTrades: postCloseAlpha.candidates,
    executionQualityCooldown,
    freshReferenceReject,
    phase4Gate,
    canaryBudgetProjection: options.canaryBudgetProjection
      ? buildCanaryBudgetProjection(allKolLiveTrades, options.canaryBudgetProjection)
      : undefined,
  };
}

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

function sol(v: number): string {
  return v.toFixed(6);
}

function formatBucketTable(summaries: BucketSummary[]): string {
  const lines = [
    '| Bucket | Trades | Net SOL | Win Rate | Avg Net | Avg Ref MFE | Avg Actual MFE | Avg Entry Adv | Avg Fresh Quote Adv | Avg Ref→Fresh | Avg Buy Lag | Avg Buy Exec | Forced Planned | T1 | T2 | T3 | Ref 5x | Actual 5x | Hardcuts |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const s of summaries) {
    lines.push(
      `| ${s.bucket} | ${s.trades} | ${sol(s.netSol)} | ${pct(s.winRate)} | ${sol(s.avgNetSol)} | ` +
      `${pct(s.avgMfePct)} | ${pct(s.avgActualMfePct)} | ${pct(s.avgEntryAdvantagePct)} | ` +
      `${pct(s.avgSwapQuoteEntryAdvantagePct)} | ${pct(s.avgReferenceToSwapQuotePct)} | ` +
      `${s.avgBuyLagSec.toFixed(1)}s | ${s.avgBuyExecutionSec.toFixed(1)}s | ${s.partialFillDataMissingTrades} | ` +
      `${s.t1Visits} | ${s.t2Visits} | ${s.t3Visits} | ` +
      `${s.fiveXVisits} | ${s.actualFiveXVisits} | ${s.hardcuts} |`
    );
  }
  return lines.join('\n');
}

function formatPaperFallbackSection(
  title: string,
  description: string,
  exitReasonHeading: string,
  summary: PaperFallbackSummary
): string[] {
  return [
    `## ${title}`,
    '',
    `> ${description}`,
    '',
    `- Closed paper fallbacks: ${summary.closedPaperFallbacks}`,
    `- Net SOL proxy: ${sol(summary.netSol)}`,
    `- Avg net SOL proxy: ${sol(summary.avgNetSol)}`,
    `- Win rate: ${pct(summary.winRate)}`,
    `- Avg MFE: ${pct(summary.avgMfePct)}`,
    `- T1/T2/T3 visits: ${summary.t1Visits}/${summary.t2Visits}/${summary.t3Visits}`,
    `- 5x visits: ${summary.fiveXVisits}`,
    `- Hardcuts: ${summary.hardcuts}`,
    '',
    `### ${exitReasonHeading}`,
    '',
    formatBucketTable(summary.byExitReason),
    '',
  ];
}

function formatExecutionQualityCooldownSection(summary: PaperFallbackSummary): string[] {
  return formatPaperFallbackSection(
    'Execution Quality Cooldown Fallbacks',
    'Closed paper outcomes that were forced by LIVE_EXEC_QUALITY_COOLDOWN. This estimates whether cooldown blocked bad or good live candidates.',
    'By Cooldown Fallback Exit Reason',
    summary
  );
}

function formatFreshReferenceRejectSection(summary: PaperFallbackSummary): string[] {
  return formatPaperFallbackSection(
    'Fresh Reference Reject Fallbacks',
    'Closed paper outcomes that were forced by LIVE_FRESH_REFERENCE_REJECT. This estimates whether the fresh-reference guard blocked bad or good live candidates.',
    'By Fresh Reference Reject Exit Reason',
    summary
  );
}

function formatPhase4GateSection(gate: Phase4GateSummary): string[] {
  return [
    '## Phase 4 Gate',
    '',
    `- Verdict: ${gate.verdict}`,
    `- Closed live trades: ${gate.closedTrades}/${gate.minClosedTrades}`,
    `- Actual runner observed: ${gate.hasActualRunner ? 'yes' : 'no'}`,
    `- Data quality clear: ${gate.dataQualityClear ? 'yes' : 'no'}`,
    `- Guard calibration clear: ${gate.guardCalibrationClear ? 'yes' : 'no'}`,
    `- Forced planned fill metrics: ${gate.partialFillDataMissingTrades}`,
    `- Forced planned fill known/legacy: ${gate.knownPartialFillDataMissingTrades}/${gate.legacyPartialFillDataMissingTrades}`,
    `- Entry advantage anomalies: ${gate.entryAdvantageAnomalyTrades}`,
    `- Entry advantage artifacts: ${gate.entryAdvantageArtifactTrades}`,
    `- Execution-quality cooldown fallbacks: ${gate.executionQualityCooldownPaperFallbacks}`,
    `- Execution-quality cooldown T2/5x: ${gate.executionQualityCooldownT2Visits}/${gate.executionQualityCooldownFiveXVisits}`,
    `- Fresh-reference reject fallbacks: ${gate.freshReferenceRejectPaperFallbacks}`,
    `- Fresh-reference reject T2/5x: ${gate.freshReferenceRejectT2Visits}/${gate.freshReferenceRejectFiveXVisits}`,
    '- Reasons:',
    ...gate.reasons.map((reason) => `  - ${reason}`),
    '',
  ];
}

function formatCanaryBudgetProjectionSection(projection: CanaryBudgetProjection | undefined): string[] {
  if (!projection) return [];
  return [
    '## Canary Budget Projection',
    '',
    '> Uses all KOL live closed ledger rows, not only the `--since` window, because canary hydrate restores cumulative lane PnL from the ledger.',
    '',
    `- Verdict: ${projection.verdict}`,
    `- Wallet / floor / room: ${sol(projection.walletSol)} / ${sol(projection.walletFloorSol)} / ${sol(projection.walletRoomSol)} SOL`,
    `- KOL canary cap: ${sol(projection.kolCanaryCapSol)} SOL`,
    `- KOL cumulative PnL: ${sol(projection.cumulativeKolPnlSol)} SOL`,
    `- Remaining KOL budget: ${sol(projection.remainingKolBudgetSol)} SOL`,
    `- Ticket / approx full-ticket losers left: ${sol(projection.kolTicketSol)} SOL / ${projection.approxFullTicketLosers}`,
    `- Projected wallet at KOL budget exhaustion: ${sol(projection.projectedWalletAtBudgetExhaustionSol)} SOL`,
    `- Projected floor buffer: ${sol(projection.projectedFloorBufferSol)} SOL`,
    `- Cap exhausted at this cap: ${projection.capExhausted ? 'yes' : 'no'}`,
    `- Reason: ${projection.reason}`,
    '- Restart note: after changing canary cap or wallet floor env, restart the bot with updated env so the hydrated canary and in-memory entry halt are rebuilt.',
    '',
  ];
}

function formatRunnerDiagnosticsSection(
  summary: RunnerDiagnosticsSummary,
  candidates: PairedKolLiveTrade[]
): string[] {
  const candidateLines = candidates.length > 0
    ? candidates
        .map((trade) =>
          `- ${trade.positionId} ${trade.exitReason} net=${sol(trade.netSol)} ` +
          `actualMfe=${trade.actualMfePctPeak == null ? 'unknown' : pct(trade.actualMfePctPeak)} ` +
          `refMfe=${pct(trade.mfePctPeak)} ` +
          `actualMae=${trade.actualMaePct == null ? 'unknown' : pct(trade.actualMaePct)} ` +
          `entryAdv=${trade.entryAdvantagePct == null ? 'unknown' : pct(trade.entryAdvantagePct)} ` +
          `artifact=${trade.entryAdvantageArtifact ? 'yes' : 'no'} ` +
          `kols=${trade.independentKolCount ?? 'unknown'} ` +
          `fillData=${trade.partialFillDataMissing ? 'forced_planned' : 'measured'}`
        )
        .join('\n')
    : '_none_';

  return [
    '## Runner Diagnostics',
    '',
    `- Max actual MFE: ${pct(summary.maxActualMfePct)}`,
    `- Max ref MFE: ${pct(summary.maxRefMfePct)}`,
    `- Actual T1/T2/5x visits: ${summary.actualT1Visits}/${summary.actualT2Visits}/${summary.actualFiveXVisits}`,
    `- Near actual T1 trades (25-50% MFE): ${summary.nearActualT1Trades}`,
    `- Reference-only T1 trades: ${summary.referenceOnlyT1Trades}`,
    `- Pre-T1 hardcuts: ${summary.preT1Hardcuts}`,
    '',
    '### Top Runner Candidate Trades',
    '',
    candidateLines,
    '',
    '### Runner Diagnostics By Exit Reason',
    '',
    formatBucketTable(summary.byExitReason),
    '',
    '### Runner Diagnostics By Actual MFE',
    '',
    formatBucketTable(summary.byActualMfeBucket),
    '',
  ];
}

function formatRunnerlessQuarantineCandidatesSection(candidates: RunnerlessCohortCandidate[]): string[] {
  const table = candidates.length > 0
    ? [
        '| Dimension | Bucket | Trades | Known Actual MFE | Net SOL | Avg Net | Win Rate | Avg Actual MFE | Actual T1 | Actual T2 | Actual 5x | Hardcuts | Reason |',
        '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
        ...candidates.map((candidate) =>
          `| ${candidate.dimension} | ${candidate.bucket} | ${candidate.trades} | ` +
          `${candidate.actualMfeKnownTrades} | ${sol(candidate.netSol)} | ${sol(candidate.avgNetSol)} | ${pct(candidate.winRate)} | ` +
          `${pct(candidate.avgActualMfePct)} | ${candidate.actualT1Visits} | ${candidate.actualT2Visits} | ` +
          `${candidate.actualFiveXVisits} | ${candidate.hardcuts} | ${candidate.reason} |`
        ),
      ].join('\n')
    : '_none_';
  return [
    '## Runnerless Cohort Quarantine Candidates',
    '',
    `> Report-only candidates with >=${RUNNERLESS_COHORT_MIN_TRADES} live trades, negative net SOL, and zero actual T2/5x evidence. This does not change live routing by itself.`,
    '',
    table,
    '',
  ];
}

function formatCountMap(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, value]) => `${key}=${value}`)
    .join(', ') || 'none';
}

function formatPostCloseAlphaBucketTable(summaries: PostCloseAlphaBucketSummary[]): string {
  const lines = [
    '| Exit Reason | Trades | Matched | OK Probe Trades | Post-Close T1 | Post-Close T2 | Net SOL | Avg Max Delta | Max Delta |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const summary of summaries) {
    lines.push(
      `| ${summary.bucket} | ${summary.trades} | ${summary.matchedTrades} | ${summary.okProbeTrades} | ` +
      `${summary.postCloseT1Trades} | ${summary.postCloseT2Trades} | ${sol(summary.netSol)} | ` +
      `${pct(summary.avgMaxDeltaPct)} | ${pct(summary.maxDeltaPct)} |`
    );
  }
  return lines.join('\n');
}

function formatPostCloseAlphaDiagnosticsSection(
  summary: PostCloseAlphaDiagnosticsSummary,
  candidates: PostCloseAlphaTradeSummary[]
): string[] {
  const candidateLines = candidates.length > 0
    ? candidates
        .map((trade) =>
          `- ${trade.positionId} ${trade.exitReason} net=${sol(trade.netSol)} ` +
          `actualMfe=${trade.actualMfePctPeak == null ? 'unknown' : pct(trade.actualMfePctPeak)} ` +
          `postCloseMax=${trade.maxDeltaPct == null ? 'unknown' : pct(trade.maxDeltaPct)} ` +
          `offset=${trade.maxDeltaOffsetSec == null ? 'unknown' : `${trade.maxDeltaOffsetSec}s`} ` +
          `okProbes=${trade.okProbes}/${trade.totalProbes} statuses=${formatCountMap(trade.quoteStatuses)}`
        )
        .join('\n')
    : '_none_';

  return [
    '## Post-Close Alpha Diagnostics',
    '',
    `- Matched closed trades: ${summary.matchedClosedTrades}`,
    `- Unmatched closed trades: ${summary.unmatchedClosedTrades}`,
    `- OK-probed trades: ${summary.okProbeTrades}`,
    `- Post-close T1/T2 trades: ${summary.postCloseT1Trades}/${summary.postCloseT2Trades}`,
    `- Max post-close delta: ${pct(summary.maxPostCloseDeltaPct)}`,
    `- Probe statuses: ${formatCountMap(summary.probeStatusCounts)}`,
    '',
    '### Top Post-Close Alpha Trades',
    '',
    candidateLines,
    '',
    '### Post-Close Alpha By Exit Reason',
    '',
    formatPostCloseAlphaBucketTable(summary.byExitReason),
    '',
  ];
}

function formatKolLiveCanaryMarkdown(report: KolLiveCanaryReport): string {
  const walletTruth = Object.entries(report.walletTruthSources)
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => `${source}=${count}`)
    .join(', ') || 'none';
  const worst = report.worstTrades.length > 0
    ? report.worstTrades
        .map((trade) =>
          `- ${trade.positionId} ${trade.exitReason} net=${sol(trade.netSol)} ` +
          `refMfe=${pct(trade.mfePctPeak)} actualMfe=${trade.actualMfePctPeak == null ? 'unknown' : pct(trade.actualMfePctPeak)} ` +
          `entryAdv=${trade.entryAdvantagePct == null ? 'unknown' : pct(trade.entryAdvantagePct)} ` +
          `refFresh=${trade.referenceToSwapQuotePct == null ? 'unknown' : pct(trade.referenceToSwapQuotePct)} ` +
          `buyLag=${trade.buyLagSec == null ? 'unknown' : `${trade.buyLagSec.toFixed(1)}s`} ` +
          `buyExec=${trade.buyExecutionSec == null ? 'unknown' : `${trade.buyExecutionSec.toFixed(1)}s`} ` +
          `fillData=${trade.partialFillDataMissing ? 'forced_planned' : 'measured'} ` +
          `fillReason=${trade.partialFillDataReason ?? 'none'} ` +
          `kols=${trade.independentKolCount ?? 'unknown'} ` +
          `source=${trade.walletTruthSource}`
        )
        .join('\n')
    : '_none_';
  const mismatches = report.measurementMismatchTrades.length > 0
    ? report.measurementMismatchTrades
        .map((trade) =>
          `- ${trade.positionId} ${trade.exitReason} net=${sol(trade.netSol)} ` +
          `refMfe=${pct(trade.mfePctPeak)} actualMfe=${trade.actualMfePctPeak == null ? 'unknown' : pct(trade.actualMfePctPeak)} ` +
          `refMae=${trade.maePct == null ? 'unknown' : pct(trade.maePct)} actualMae=${trade.actualMaePct == null ? 'unknown' : pct(trade.actualMaePct)} ` +
          `entryAdv=${trade.entryAdvantagePct == null ? 'unknown' : pct(trade.entryAdvantagePct)} ` +
          `refFresh=${trade.referenceToSwapQuotePct == null ? 'unknown' : pct(trade.referenceToSwapQuotePct)} ` +
          `artifact=${trade.entryAdvantageArtifact ? 'yes' : 'no'} ` +
          `buyLag=${trade.buyLagSec == null ? 'unknown' : `${trade.buyLagSec.toFixed(1)}s`} ` +
          `buyExec=${trade.buyExecutionSec == null ? 'unknown' : `${trade.buyExecutionSec.toFixed(1)}s`} ` +
          `fillData=${trade.partialFillDataMissing ? 'forced_planned' : 'measured'} ` +
          `fillReason=${trade.partialFillDataReason ?? 'none'}`
        )
        .join('\n')
    : '_none_';
  const entryAdvantageAnomalies = report.entryAdvantageAnomalies.length > 0
    ? report.entryAdvantageAnomalies
        .map((trade) =>
          `- ${trade.positionId} ${trade.exitReason} net=${sol(trade.netSol)} ` +
          `entryAdv=${trade.entryAdvantagePct == null ? 'unknown' : pct(trade.entryAdvantagePct)} ` +
          `freshAdv=${trade.swapQuoteEntryAdvantagePct == null ? 'unknown' : pct(trade.swapQuoteEntryAdvantagePct)} ` +
          `refFresh=${trade.referenceToSwapQuotePct == null ? 'unknown' : pct(trade.referenceToSwapQuotePct)} ` +
          `refMfe=${pct(trade.mfePctPeak)} actualMfe=${trade.actualMfePctPeak == null ? 'unknown' : pct(trade.actualMfePctPeak)} ` +
          `buyLag=${trade.buyLagSec == null ? 'unknown' : `${trade.buyLagSec.toFixed(1)}s`} ` +
          `buyExec=${trade.buyExecutionSec == null ? 'unknown' : `${trade.buyExecutionSec.toFixed(1)}s`} ` +
          `outputRatio=${trade.entryFillOutputRatio == null ? 'unknown' : trade.entryFillOutputRatio.toFixed(4)} ` +
          `fillReason=${trade.partialFillDataReason ?? 'none'} ` +
          `source=${trade.walletTruthSource}`
        )
        .join('\n')
    : '_none_';
  const forcedPlannedFillTrades = report.forcedPlannedFillTrades.length > 0
    ? report.forcedPlannedFillTrades
        .map((trade) =>
          `- ${trade.positionId} ${trade.exitReason} net=${sol(trade.netSol)} ` +
          `fillReason=${trade.partialFillDataReason ?? 'legacy_unknown_reason'} ` +
          `buyLag=${trade.buyLagSec == null ? 'unknown' : `${trade.buyLagSec.toFixed(1)}s`} ` +
          `buyExec=${trade.buyExecutionSec == null ? 'unknown' : `${trade.buyExecutionSec.toFixed(1)}s`} ` +
          `entryAdv=${trade.entryAdvantagePct == null ? 'unknown' : pct(trade.entryAdvantagePct)} ` +
          `refFresh=${trade.referenceToSwapQuotePct == null ? 'unknown' : pct(trade.referenceToSwapQuotePct)} ` +
          `refMfe=${pct(trade.mfePctPeak)} actualMfe=${trade.actualMfePctPeak == null ? 'unknown' : pct(trade.actualMfePctPeak)} ` +
          `kols=${trade.independentKolCount ?? 'unknown'} ` +
          `source=${trade.walletTruthSource}`
        )
        .join('\n')
    : '_none_';
  const entryAdvantageArtifacts = report.entryAdvantageArtifacts.length > 0
    ? report.entryAdvantageArtifacts
        .map((trade) =>
          `- ${trade.positionId} ${trade.exitReason} net=${sol(trade.netSol)} ` +
          `entryAdv=${trade.entryAdvantagePct == null ? 'unknown' : pct(trade.entryAdvantagePct)} ` +
          `freshAdv=${trade.swapQuoteEntryAdvantagePct == null ? 'unknown' : pct(trade.swapQuoteEntryAdvantagePct)} ` +
          `refFresh=${trade.referenceToSwapQuotePct == null ? 'unknown' : pct(trade.referenceToSwapQuotePct)} ` +
          `outputRatio=${trade.entryFillOutputRatio == null ? 'unknown' : trade.entryFillOutputRatio.toFixed(4)} ` +
          `refMfe=${pct(trade.mfePctPeak)} actualMfe=${trade.actualMfePctPeak == null ? 'unknown' : pct(trade.actualMfePctPeak)} ` +
          `buyLag=${trade.buyLagSec == null ? 'unknown' : `${trade.buyLagSec.toFixed(1)}s`} ` +
          `buyExec=${trade.buyExecutionSec == null ? 'unknown' : `${trade.buyExecutionSec.toFixed(1)}s`} ` +
          `source=${trade.walletTruthSource}`
        )
        .join('\n')
    : '_none_';

  return [
    `# KOL Live Canary Report - ${new Date().toISOString().slice(0, 10)}`,
    '',
    '> Live canary only. Paper and shadow outcomes are intentionally excluded.',
    '',
    '## Summary',
    '',
    `- Since: ${report.since ?? 'all time'}`,
    `- Closed trades: ${report.closedTrades}`,
    `- Open buys: ${report.openBuys}`,
    `- Orphan sells: ${report.orphanSells}`,
    `- Net SOL: ${sol(report.netSol)}`,
    `- Avg net SOL: ${sol(report.avgNetSol)}`,
    `- Win rate: ${pct(report.winRate)}`,
    `- Avg ref MFE: ${pct(report.avgMfePct)}`,
    `- Avg actual MFE: ${pct(report.avgActualMfePct)}`,
    `- Avg non-artifact entry advantage: ${pct(report.avgEntryAdvantagePct)}`,
    `- Avg fresh quote entry advantage: ${pct(report.avgSwapQuoteEntryAdvantagePct)}`,
    `- Avg reference→fresh quote drift: ${pct(report.avgReferenceToSwapQuotePct)}`,
    `- Avg buy lag: ${report.avgBuyLagSec.toFixed(1)}s`,
    `- Avg buy execution: ${report.avgBuyExecutionSec.toFixed(1)}s`,
    `- Avg reference age: ${report.avgReferenceAgeSec.toFixed(1)}s`,
    `- Avg signal→reference: ${report.avgSignalToReferenceSec.toFixed(1)}s`,
    `- Forced planned fill metrics: ${report.partialFillDataMissingTrades}`,
    `- Forced planned fill known/legacy: ${report.knownPartialFillDataMissingTrades}/${report.legacyPartialFillDataMissingTrades}`,
    `- Entry advantage anomalies: ${report.entryAdvantageAnomalyTrades}`,
    `- Entry advantage adverse/favorable: ${report.entryAdvantageAdverseTrades}/${report.entryAdvantageFavorableTrades}`,
    `- Entry advantage artifacts: ${report.entryAdvantageArtifactTrades}`,
    `- Max drawdown SOL: ${sol(report.maxDrawdownSol)}`,
    `- Ref T1/T2/T3 visits: ${report.t1Visits}/${report.t2Visits}/${report.t3Visits}`,
    `- Actual T1/T2/T3 visits: ${report.actualT1Visits}/${report.actualT2Visits}/${report.actualT3Visits}`,
    `- Ref 5x visits: ${report.fiveXVisits}`,
    `- Actual 5x visits: ${report.actualFiveXVisits}`,
    `- Max actual MFE: ${pct(report.runnerDiagnostics.maxActualMfePct)}`,
    `- Runnerless quarantine candidates: ${report.runnerlessQuarantineCandidates.length}`,
    `- Post-close T1/T2 trades: ${report.postCloseAlphaDiagnostics.postCloseT1Trades}/${report.postCloseAlphaDiagnostics.postCloseT2Trades}`,
    `- Hardcuts: ${report.hardcuts}`,
    `- Wallet-truth sources: ${walletTruth}`,
    `- Execution-quality cooldown paper fallbacks: ${report.executionQualityCooldown.closedPaperFallbacks}`,
    `- Fresh-reference reject paper fallbacks: ${report.freshReferenceReject.closedPaperFallbacks}`,
    `- Phase 4 gate: ${report.phase4Gate.verdict}`,
    ...(report.canaryBudgetProjection
      ? [`- Canary budget projection: ${report.canaryBudgetProjection.verdict}`]
      : []),
    '',
    ...formatCanaryBudgetProjectionSection(report.canaryBudgetProjection),
    ...formatPhase4GateSection(report.phase4Gate),
    ...formatRunnerDiagnosticsSection(report.runnerDiagnostics, report.runnerCandidateTrades),
    ...formatRunnerlessQuarantineCandidatesSection(report.runnerlessQuarantineCandidates),
    ...formatPostCloseAlphaDiagnosticsSection(
      report.postCloseAlphaDiagnostics,
      report.postCloseAlphaCandidateTrades
    ),
    ...formatExecutionQualityCooldownSection(report.executionQualityCooldown),
    ...formatFreshReferenceRejectSection(report.freshReferenceReject),
    '## By Exit Reason',
    '',
    formatBucketTable(report.byExitReason),
    '',
    '## By Independent KOL Count',
    '',
    formatBucketTable(report.byIndependentKolCount),
    '',
    '## By Slippage Bucket',
    '',
    formatBucketTable(report.bySlippageBucket),
    '',
    '## By Buy Lag Bucket',
    '',
    formatBucketTable(report.byBuyLagBucket),
    '',
    '## By Buy Execution Bucket',
    '',
    formatBucketTable(report.byBuyExecutionBucket),
    '',
    '## By Reference To Fresh Quote Bucket',
    '',
    formatBucketTable(report.byReferenceToSwapQuoteBucket),
    '',
    '## By Fill Data Quality',
    '',
    formatBucketTable(report.byFillDataQualityBucket),
    '',
    '## By Fill Fallback Reason',
    '',
    formatBucketTable(report.byFillFallbackReasonBucket),
    '',
    '## By Entry Advantage Bucket',
    '',
    formatBucketTable(report.byEntryAdvantageBucket),
    '',
    '## By Actual MFE Bucket',
    '',
    formatBucketTable(report.byActualMfeBucket),
    '',
    '## By Arm',
    '',
    formatBucketTable(report.byArm),
    '',
    '## Worst Trades',
    '',
    worst,
    '',
    '## Measurement Mismatch Trades',
    '',
    mismatches,
    '',
    '## Forced Planned Fill Trades',
    '',
    forcedPlannedFillTrades,
    '',
    '## Entry Advantage Anomaly Trades',
    '',
    entryAdvantageAnomalies,
    '',
    '## Entry Advantage Artifact Trades',
    '',
    entryAdvantageArtifacts,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs();
  const buys = await readJsonlMaybe<KolLiveBuyLedger>(path.join(args.ledgerDir, 'executed-buys.jsonl'));
  const sells = await readJsonlMaybe<KolLiveSellLedger>(path.join(args.ledgerDir, 'executed-sells.jsonl'));
  const paperTrades = await readJsonlMaybe<KolPaperTradeLedger>(path.join(args.ledgerDir, 'kol-paper-trades.jsonl'));
  const missedAlphaRecords = await readJsonlMaybe<MissedAlphaLedgerRecord>(path.join(args.ledgerDir, 'missed-alpha.jsonl'));
  const report = buildKolLiveCanaryReport(buys, sells, args.since, paperTrades, missedAlphaRecords, {
    canaryBudgetProjection: args.walletSol == null
      ? undefined
      : {
          walletSol: args.walletSol,
          walletFloorSol: args.walletFloorSol,
          kolCanaryCapSol: args.kolCanaryCapSol,
          kolTicketSol: args.kolTicketSol,
        },
  });

  if (args.md) {
    await mkdir(path.dirname(args.md), { recursive: true });
    await writeFile(args.md, formatKolLiveCanaryMarkdown(report), 'utf8');
  }
  if (args.json) {
    await mkdir(path.dirname(args.json), { recursive: true });
    await writeFile(args.json, JSON.stringify(report, null, 2), 'utf8');
  }

  console.log(
    `[kol-live-canary-report] closed=${report.closedTrades} open=${report.openBuys} ` +
    `orphan=${report.orphanSells} net=${sol(report.netSol)}SOL ` +
    `ref5x=${report.fiveXVisits} actual5x=${report.actualFiveXVisits} ` +
    `eqCooldownFallbacks=${report.executionQualityCooldown.closedPaperFallbacks} ` +
    `freshReferenceRejectFallbacks=${report.freshReferenceReject.closedPaperFallbacks} ` +
    `phase4=${report.phase4Gate.verdict}` +
    (report.canaryBudgetProjection ? ` canaryBudget=${report.canaryBudgetProjection.verdict}` : '')
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[kol-live-canary-report] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

export {
  parseJsonl,
  resolveSinceArg,
  pairKolLiveTrades,
  buildKolLiveCanaryReport,
  formatKolLiveCanaryMarkdown,
  type KolLiveBuyLedger,
  type KolLiveSellLedger,
  type KolPaperTradeLedger,
  type MissedAlphaLedgerRecord,
  type KolLiveCanaryReport,
  type PairedKolLiveTrade,
  type Phase4GateSummary,
  type Phase4GateVerdict,
  type CanaryBudgetProjection,
  type CanaryBudgetProjectionInput,
  type CanaryBudgetProjectionVerdict,
};
