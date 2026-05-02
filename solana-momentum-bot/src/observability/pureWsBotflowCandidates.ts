import {
  PURE_WS_BOTFLOW_CANDIDATE_SCHEMA_VERSION,
  type BotflowCandidateThresholds,
  type BuildBotflowCandidatesOptions,
  type PureWsBotflowCandidate,
  type PureWsBotflowEvent,
  type PureWsBotflowPairContext,
  type PureWsBotflowSide,
} from './pureWsBotflowTypes';

interface WindowSummary {
  startMs: number;
  endMs: number;
  events: PureWsBotflowEvent[];
}

export function buildBotflowCandidates(
  events: PureWsBotflowEvent[],
  options: BuildBotflowCandidatesOptions,
): PureWsBotflowCandidate[] {
  const source = options.source ?? 'helius_enhanced_fee_payer';
  const byMint = groupBy(events, (event) => event.tokenMint);
  const candidates: PureWsBotflowCandidate[] = [];
  for (const [tokenMint, mintEvents] of byMint.entries()) {
    const sorted = [...mintEvents].sort((a, b) => a.timestampMs - b.timestampMs);
    const buyStarts = sorted.filter((event) => event.side === 'buy');
    for (const windowSec of [...new Set(options.windowSecs)].sort((a, b) => a - b)) {
      const rows = collectWindows(sorted, buyStarts, windowSec).map((summary) =>
        toCandidate(tokenMint, summary, windowSec, source, options)
      );
      const observed = rows.filter((candidate) => candidate.decision === 'observe');
      const selected = selectBestCandidate(observed.length > 0 ? observed : rows);
      if (selected) candidates.push(selected);
    }
  }
  return candidates.sort((a, b) =>
    a.windowStartMs - b.windowStartMs ||
    a.tokenMint.localeCompare(b.tokenMint) ||
    a.windowSec - b.windowSec
  );
}

function collectWindows(
  allEvents: PureWsBotflowEvent[],
  buyStarts: PureWsBotflowEvent[],
  windowSec: number,
): WindowSummary[] {
  return buyStarts.map((start) => {
    const startMs = start.timestampMs;
    const endMs = startMs + windowSec * 1000;
    return { startMs, endMs, events: allEvents.filter((event) => event.timestampMs >= startMs && event.timestampMs <= endMs) };
  });
}

function selectBestCandidate(candidates: PureWsBotflowCandidate[]): PureWsBotflowCandidate | null {
  return [...candidates].sort((a, b) =>
    b.netFlowSol - a.netFlowSol ||
    b.buySol - a.buySol ||
    b.buyCount - a.buyCount ||
    a.windowStartMs - b.windowStartMs
  )[0] ?? null;
}

function toCandidate(
  tokenMint: string,
  summary: WindowSummary,
  windowSec: number,
  source: string,
  options: BuildBotflowCandidatesOptions,
): PureWsBotflowCandidate {
  const buys = summary.events.filter((event) => event.side === 'buy');
  const sells = summary.events.filter((event) => event.side === 'sell');
  const buySol = flowSol(summary.events, 'buy');
  const sellSol = flowSol(summary.events, 'sell');
  const pairContext = options.pairContextByMint?.get(tokenMint);
  const pairAgeSec = computePairAgeSec(summary.endMs, pairContext?.pairCreatedAtMs, options.pairAgeByMint?.get(tokenMint));
  const securityFlags = dedupe([
    ...(options.securityFlagsByMint?.get(tokenMint) ?? []),
    ...(pairContext?.securityFlags ?? []),
  ]);
  const qualityFlags = withPairContextFlags(dedupe([
    ...(options.qualityFlagsByMint?.get(tokenMint) ?? []),
    ...(pairContext?.qualityFlags ?? []),
  ]), pairContext, pairAgeSec);
  const mayhemLifecycle = resolveMayhemLifecycle(pairContext, pairAgeSec);
  const rejectReasons = rejectReasonsFor({ buys, sells, buySol, sellSol, securityFlags }, options.thresholds);
  const anchor = [...summary.events].sort((a, b) => b.timestampMs - a.timestampMs)[0];
  return {
    schemaVersion: PURE_WS_BOTFLOW_CANDIDATE_SCHEMA_VERSION,
    candidateId: `pwbf:${tokenMint}:${summary.startMs}:${windowSec}`,
    observedAt: new Date(summary.endMs).toISOString(),
    tokenMint,
    pairAddress: pairContext?.pairAddress,
    poolAddress: pairContext?.poolAddress ?? pairContext?.pairAddress,
    dexId: pairContext?.dexId,
    pairAgeSec,
    pairContextObservedAt: pairContext?.contextObservedAtMs ? new Date(pairContext.contextObservedAtMs).toISOString() : undefined,
    pairContextAgeSec: pairContext?.contextObservedAtMs ? Math.max(0, (summary.endMs - pairContext.contextObservedAtMs) / 1000) : undefined,
    knownPoolCount: pairContext?.knownPoolCount,
    poolPrewarmSuccess: pairContext?.poolPrewarmSuccess,
    poolPrewarmSkipReason: pairContext?.poolPrewarmSkipReason,
    botProfile: options.botProfile,
    walletRole: options.walletRole,
    provenanceConfidence: options.provenanceConfidence,
    mayhemMode: pairContext?.mayhemMode,
    mayhemLifecycle,
    source,
    windowSec,
    windowStartMs: summary.startMs,
    windowEndMs: summary.endMs,
    buyCount: buys.length,
    sellCount: sells.length,
    buySol,
    sellSol,
    netFlowSol: buySol - sellSol,
    buySellRatio: sells.length === 0 ? buys.length : buys.length / sells.length,
    smallBuyCount: buys.filter((event) => event.solAmount <= options.thresholds.smallBuyMaxSol).length,
    topupCount: Math.max(0, buys.length - new Set(buys.map((event) => event.tradingUser)).size),
    uniqueFeePayers: new Set(summary.events.map((event) => event.feePayer).filter(Boolean)).size,
    uniqueSubAccounts: new Set(summary.events.map((event) => event.tradingUser).filter(Boolean)).size,
    sameFeePayerRepetition: maxCount(summary.events.map((event) => event.feePayer).filter(Boolean)),
    lastBuyAgeMs: lastAge(summary.endMs, buys),
    lastSellAgeMs: lastAge(summary.endMs, sells),
    flowAnchorPriceSol: anchor?.flowPriceSolPerToken,
    securityFlags,
    qualityFlags,
    estimatedRoundTripCostPct: options.estimatedRoundTripCostPct,
    decision: rejectReasons.length === 0 ? 'observe' : 'reject',
    rejectReason: rejectReasons.length === 0 ? undefined : rejectReasons.join(','),
  };
}

function computePairAgeSec(endMs: number, pairCreatedAtMs: number | undefined, fallbackAgeSec: number | undefined): number | undefined {
  if (typeof pairCreatedAtMs === 'number' && Number.isFinite(pairCreatedAtMs)) {
    return Math.max(0, (endMs - pairCreatedAtMs) / 1000);
  }
  return fallbackAgeSec;
}

function withPairContextFlags(
  flags: string[],
  pairContext: PureWsBotflowPairContext | undefined,
  pairAgeSec: number | undefined,
): string[] {
  const out = [...flags];
  if (!pairContext) out.push('PAIR_CONTEXT_MISSING');
  else {
    if (!pairContext.pairCreatedAtMs) out.push('PAIR_CREATED_AT_UNKNOWN');
    if ((pairContext.knownPoolCount ?? 0) <= 0) out.push('POOL_CONTEXT_MISSING');
  }
  if (typeof pairAgeSec === 'number') {
    out.push(pairAgeSec <= 180 ? 'FRESH_PAIR_AGE_LE_180S' : 'PAIR_AGE_GT_180S');
  }
  if (pairContext?.mayhemMode === true) {
    out.push('MAYHEM_MODE_TRUE');
    const lifecycle = resolveMayhemLifecycle(pairContext, pairAgeSec);
    if (lifecycle === 'active_lt_24h') out.push('MAYHEM_ACTIVE_LT_24H');
    else if (lifecycle === 'completed') out.push('MAYHEM_COMPLETED');
  } else if (pairContext?.mayhemMode === false) {
    out.push('MAYHEM_MODE_FALSE');
  }
  if (pairContext?.mayhemAgentWalletSeen) out.push('MAYHEM_AGENT_FLOW_PRESENT');
  if (pairContext?.mayhemProgramSeen) out.push('MAYHEM_PROGRAM_SEEN');
  return dedupe(out);
}

function resolveMayhemLifecycle(
  pairContext: PureWsBotflowPairContext | undefined,
  pairAgeSec: number | undefined,
): NonNullable<PureWsBotflowPairContext['mayhemLifecycle']> {
  if (pairContext?.mayhemLifecycle) return pairContext.mayhemLifecycle;
  if (pairContext?.mayhemMode === true && typeof pairAgeSec === 'number') {
    return pairAgeSec <= 24 * 60 * 60 ? 'active_lt_24h' : 'completed';
  }
  return 'unknown';
}

function rejectReasonsFor(
  input: { buys: PureWsBotflowEvent[]; sells: PureWsBotflowEvent[]; buySol: number; sellSol: number; securityFlags: string[] },
  thresholds: BotflowCandidateThresholds,
): string[] {
  const reasons: string[] = [];
  if (input.securityFlags.some((flag) => flag === 'HARD_REJECT' || flag === 'NO_SECURITY_DATA')) reasons.push('security_hard_reject');
  if (input.buys.length < thresholds.minBuyCount) reasons.push('insufficient_buy_count');
  if (input.buys.filter((event) => event.solAmount <= thresholds.smallBuyMaxSol).length < thresholds.minSmallBuyCount) {
    reasons.push('insufficient_small_buys');
  }
  if (input.buySol < thresholds.minGrossBuySol) reasons.push('insufficient_gross_buy_sol');
  if (input.buySol - input.sellSol < thresholds.minNetFlowSol) reasons.push('insufficient_net_flow');
  const buySellRatio = input.sells.length === 0 ? input.buys.length : input.buys.length / input.sells.length;
  if (buySellRatio < thresholds.minBuySellRatio) reasons.push('weak_buy_sell_ratio');
  return reasons;
}

function flowSol(events: PureWsBotflowEvent[], side: PureWsBotflowSide): number {
  return events.filter((event) => event.side === side).reduce((sum, event) => sum + event.solAmount, 0);
}

function lastAge(nowMs: number, events: PureWsBotflowEvent[]): number | undefined {
  if (events.length === 0) return undefined;
  return nowMs - Math.max(...events.map((event) => event.timestampMs));
}

function maxCount(values: string[]): number {
  const counts = new Map<string, number>();
  let max = 0;
  for (const value of values) {
    const next = (counts.get(value) ?? 0) + 1;
    counts.set(value, next);
    max = Math.max(max, next);
  }
  return max;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    out.set(key, [...(out.get(key) ?? []), item]);
  }
  return out;
}
