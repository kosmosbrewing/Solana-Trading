import {
  buildBotflowCandidates,
  buildBotflowMarkouts,
  buildPureWsBotflowContext,
  parseBotflowEventsFromEnhancedTransactions,
  PURE_WS_BOTFLOW_CANDIDATE_SCHEMA_VERSION,
  PURE_WS_BOTFLOW_EVENT_SCHEMA_VERSION,
  PURE_WS_BOTFLOW_MARKOUT_SCHEMA_VERSION,
  type PureWsBotflowPricePoint,
  simulateBotflowPaperTrades,
} from '../src/observability/pureWsBotflow';
import {
  buildPureWsBotflowReport,
  renderPureWsBotflowMarkdown,
} from '../src/observability/pureWsBotflowReport';
import { renderPureWsBotflowTelegram } from '../src/observability/pureWsBotflowTelegram';
import { parseArgs } from '../scripts/pure-ws-botflow-report';

const FEE_PAYER = 'Gygj9QQby4j2jryqyqBHvLP7ctv2SaANgh4sCb69BUpA';
const MARKET = 'BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s';
const USER = 'Trader111111111111111111111111111111111111';
const MINT = 'Mint11111111111111111111111111111111111111';

function tx(signature: string, timestamp: number, transfer: {
  from: string;
  to: string;
  marketSol: number;
  userSol: number;
  tokenAmount: number;
}) {
  return {
    signature,
    timestamp,
    type: 'SWAP',
    source: 'PUMP_FUN',
    feePayer: FEE_PAYER,
    tokenTransfers: [{
      fromUserAccount: transfer.from,
      toUserAccount: transfer.to,
      tokenAmount: transfer.tokenAmount,
      mint: MINT,
    }],
    accountData: [
      { account: FEE_PAYER, nativeBalanceChange: -125000 },
      { account: MARKET, nativeBalanceChange: Math.round(transfer.marketSol * 1e9) },
      { account: USER, nativeBalanceChange: Math.round(transfer.userSol * 1e9) },
    ],
  };
}

describe('pureWsBotflow', () => {
  it('keeps bot profiles explicit and does not imply Mayhem market counterparties', () => {
    expect(() => parseArgs(['--api-key', 'test', '--bot-profile', 'mayhem_current']))
      .toThrow(/market-accounts/);

    const mayhem = parseArgs(['--api-key', 'test', '--bot-profile', 'mayhem_current', '--market-accounts', MARKET]);
    expect(mayhem.trackedAddress).toBe(MARKET);
    expect(mayhem.feePayerFilter).toBeUndefined();
    expect(mayhem.walletRole).toBe('official_mayhem_agent');

    const legacy = parseArgs(['--api-key', 'test', '--bot-profile', 'gygj_legacy', '--market-accounts', MARKET]);
    expect(legacy.trackedAddress).toBe(FEE_PAYER);
    expect(legacy.feePayerFilter).toBe(FEE_PAYER);
    expect(legacy.provenanceConfidence).toBe('community_claim_unverified');
  });

  it('parses fee-payer bot-flow buys and sells from enhanced transactions', () => {
    const events = parseBotflowEventsFromEnhancedTransactions([
      tx('buy1', 1000, { from: MARKET, to: USER, marketSol: 0.5, userSol: -0.5, tokenAmount: 100 }),
      tx('sell1', 1004, { from: USER, to: MARKET, marketSol: -0.55, userSol: 0.55, tokenAmount: 100 }),
    ], { feePayerAddress: FEE_PAYER, marketAccounts: [MARKET] });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      schemaVersion: PURE_WS_BOTFLOW_EVENT_SCHEMA_VERSION,
      side: 'buy',
      tradingUser: USER,
      counterparty: MARKET,
      solAmount: 0.5,
    });
    expect(events[1]).toMatchObject({
      side: 'sell',
      tradingUser: USER,
      counterparty: MARKET,
      solAmount: 0.55,
    });
  });

  it('requires known market accounts and target fee payer for side classification', () => {
    const eventsWithImplicitMarket = parseBotflowEventsFromEnhancedTransactions([
      tx('buy1', 1000, { from: MARKET, to: USER, marketSol: 0.5, userSol: -0.5, tokenAmount: 100 }),
    ], { feePayerAddress: FEE_PAYER });
    const eventsWithoutMarket = parseBotflowEventsFromEnhancedTransactions([
      tx('sell1', 1004, { from: USER, to: MARKET, marketSol: -0.55, userSol: 0.55, tokenAmount: 100 }),
    ], { feePayerAddress: FEE_PAYER, marketAccounts: [] });
    const wrongFeePayerEvents = parseBotflowEventsFromEnhancedTransactions([
      { ...tx('buy1', 1000, { from: MARKET, to: USER, marketSol: 0.5, userSol: -0.5, tokenAmount: 100 }), feePayer: 'OtherFeePayer' },
    ], { feePayerAddress: FEE_PAYER, marketAccounts: [MARKET], requireFeePayerMatch: true });

    expect(eventsWithImplicitMarket).toHaveLength(0);
    expect(eventsWithoutMarket).toHaveLength(0);
    expect(wrongFeePayerEvents).toHaveLength(0);
  });

  it('builds net-flow candidates and post-cost markouts', () => {
    const events = parseBotflowEventsFromEnhancedTransactions([
      tx('buy1', 1000, { from: MARKET, to: USER, marketSol: 0.25, userSol: -0.25, tokenAmount: 100 }),
      tx('buy2', 1003, { from: MARKET, to: USER, marketSol: 0.30, userSol: -0.30, tokenAmount: 100 }),
      tx('buy3', 1006, { from: MARKET, to: USER, marketSol: 0.55, userSol: -0.55, tokenAmount: 100 }),
      tx('sell1', 1009, { from: USER, to: MARKET, marketSol: -0.20, userSol: 0.20, tokenAmount: 50 }),
      tx('buy4', 1016, { from: MARKET, to: USER, marketSol: 0.70, userSol: -0.70, tokenAmount: 100 }),
      tx('buy5', 1019, { from: MARKET, to: USER, marketSol: 0.80, userSol: -0.80, tokenAmount: 100 }),
      tx('buy6', 1022, { from: MARKET, to: USER, marketSol: 0.90, userSol: -0.90, tokenAmount: 100 }),
    ], { feePayerAddress: FEE_PAYER, marketAccounts: [MARKET] });
    const context = buildPureWsBotflowContext({
      pairRows: [{
        tokenMint: MINT,
        pairAddress: 'Pool111',
        dexId: 'pumpswap',
        pairCreatedAt: 999,
        observedAt: '1970-01-01T00:16:39.000Z',
        isMayhemMode: true,
        mayhemAgentWalletSeen: true,
      }],
      tokenQualityRows: [{
        tokenMint: MINT,
        riskFlags: ['NO_HELIUS_PROVENANCE'],
        operatorDevStatus: 'watchlist',
      }],
    });

    const candidates = buildBotflowCandidates(events, {
      windowSecs: [15],
      botProfile: 'gygj_legacy',
      walletRole: 'legacy_community_sample',
      provenanceConfidence: 'community_claim_unverified',
      pairContextByMint: context.pairContextByMint,
      securityFlagsByMint: context.securityFlagsByMint,
      qualityFlagsByMint: context.qualityFlagsByMint,
      estimatedRoundTripCostPct: 0.005,
      thresholds: {
        minBuyCount: 3,
        minSmallBuyCount: 2,
        minGrossBuySol: 1,
        minNetFlowSol: 0,
        minBuySellRatio: 1,
        smallBuyMaxSol: 0.6,
      },
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      schemaVersion: PURE_WS_BOTFLOW_CANDIDATE_SCHEMA_VERSION,
      decision: 'observe',
      buyCount: 3,
      sellCount: 1,
      buySol: 1.55,
      sellSol: 0.2,
      smallBuyCount: 2,
      topupCount: 2,
      pairAddress: 'Pool111',
      dexId: 'pumpswap',
      botProfile: 'gygj_legacy',
      walletRole: 'legacy_community_sample',
      mayhemMode: true,
      mayhemLifecycle: 'active_lt_24h',
    });
    expect(candidates[0].pairAgeSec).toBe(19);
    expect(candidates[0].qualityFlags).toEqual(expect.arrayContaining([
      'FRESH_PAIR_AGE_LE_180S',
      'TOKEN_QUALITY_CONTEXT',
      'DEV_STATUS_WATCHLIST',
      'MAYHEM_MODE_TRUE',
      'MAYHEM_ACTIVE_LT_24H',
      'MAYHEM_AGENT_FLOW_PRESENT',
    ]));

    const pricePoints: PureWsBotflowPricePoint[] = [
      { tokenMint: MINT, timestampMs: 1018_000, priceSol: 0.005, source: 'test_price' },
      { tokenMint: MINT, timestampMs: 1022_000, priceSol: 0.006, source: 'test_price' },
    ];
    const markouts = buildBotflowMarkouts(events, candidates, {
      horizonsSec: [3, 15],
      roundTripCostPct: 0.005,
      pricePoints,
    });

    expect(markouts).toHaveLength(2);
    expect(markouts[0].schemaVersion).toBe(PURE_WS_BOTFLOW_MARKOUT_SCHEMA_VERSION);
    expect(markouts[0].quoteStatus).toBe('ok');
    expect(markouts[0].markoutLagMs).toBe(1000);
    expect(markouts[0].postCostDeltaPct).toBeGreaterThan(0);
    expect(markouts[1].quoteStatus).toBe('missing_price_trajectory');
    const paper = simulateBotflowPaperTrades(candidates, markouts, { ticketSol: 0.005 });
    expect(paper).toHaveLength(1);
    expect(paper[0].entryPriceSol).toBe(0.005);
    expect(paper[0].exitPriceSol).toBe(0.006);
    expect(paper[0].exitReason).toBe('t2_take_profit');
    expect(paper[0].simulatedNetSol).toBeGreaterThan(0);

    const report = buildPureWsBotflowReport(
      {
        trackedAddress: FEE_PAYER,
        feePayerFilter: FEE_PAYER,
        botProfile: 'gygj_legacy',
        walletRole: 'legacy_community_sample',
        provenanceConfidence: 'community_claim_unverified',
        profileNotes: ['test profile'],
        horizonsSec: [3, 15],
      },
      7,
      events,
      candidates,
      markouts,
      paper,
    );
    expect(report.observedCandidates).toBe(1);
    expect(report.contextKnownCandidates).toBe(1);
    expect(report.freshPairCandidates).toBe(1);
    expect(report.byCohort.find((row) => row.cohort === 'mayhem_only')?.candidates).toBe(1);
    expect(report.byHorizon[0].positivePostCostRows).toBe(1);
    expect(report.paper.resolvedTrades).toBe(1);
    expect(report.paper.totalNetSol).toBeGreaterThan(0);
    expect(renderPureWsBotflowMarkdown(report)).toContain('Bot profile: `gygj_legacy`');
    const telegram = renderPureWsBotflowTelegram(report);
    expect(telegram).toContain('Pure WS paper');
    expect(telegram).toContain('profile: gygj_legacy');
    expect(telegram).toContain('paper: resolved 1/1');
    expect(telegram).toContain('postCostDelta');
    expect(telegram).not.toMatch(/[<>]/);
    expect(telegram.length).toBeLessThan(1000);
  });

  it('does not treat agent-flow-only flags as Mayhem mode truth', () => {
    const context = buildPureWsBotflowContext({
      pairRows: [{
        tokenMint: MINT,
        pairAddress: 'Pool111',
        dexId: 'pumpswap',
        pairCreatedAt: 1000,
        mayhemAgentWalletSeen: true,
      }],
    });
    const events = parseBotflowEventsFromEnhancedTransactions([
      tx('buy1', 1000, { from: MARKET, to: USER, marketSol: 0.25, userSol: -0.25, tokenAmount: 100 }),
      tx('buy2', 1003, { from: MARKET, to: USER, marketSol: 0.30, userSol: -0.30, tokenAmount: 100 }),
      tx('buy3', 1006, { from: MARKET, to: USER, marketSol: 0.55, userSol: -0.55, tokenAmount: 100 }),
    ], { feePayerAddress: FEE_PAYER, marketAccounts: [MARKET] });
    const candidates = buildBotflowCandidates(events, {
      windowSecs: [10],
      pairContextByMint: context.pairContextByMint,
      thresholds: {
        minBuyCount: 3,
        minSmallBuyCount: 2,
        minGrossBuySol: 1,
        minNetFlowSol: 0,
        minBuySellRatio: 1,
        smallBuyMaxSol: 0.6,
      },
    });
    const report = buildPureWsBotflowReport({
      trackedAddress: FEE_PAYER,
      botProfile: 'custom',
      walletRole: 'custom_research',
      provenanceConfidence: 'user_supplied',
      horizonsSec: [10],
    }, 3, events, candidates, [], []);

    expect(candidates[0].qualityFlags).toContain('MAYHEM_AGENT_FLOW_PRESENT');
    expect(report.byCohort.find((row) => row.cohort === 'mayhem_only')?.candidates).toBe(0);
    expect(report.byCohort.find((row) => row.cohort === 'non_mayhem_new_pair')?.candidates).toBe(1);
  });

  it('does not count distant future events as short-horizon markouts', () => {
    const events = parseBotflowEventsFromEnhancedTransactions([
      tx('buy1', 1000, { from: MARKET, to: USER, marketSol: 0.25, userSol: -0.25, tokenAmount: 100 }),
      tx('buy2', 1003, { from: MARKET, to: USER, marketSol: 0.30, userSol: -0.30, tokenAmount: 100 }),
      tx('buy3', 1006, { from: MARKET, to: USER, marketSol: 0.55, userSol: -0.55, tokenAmount: 100 }),
      tx('late', 1060, { from: MARKET, to: USER, marketSol: 1.20, userSol: -1.20, tokenAmount: 100 }),
    ], { feePayerAddress: FEE_PAYER, marketAccounts: [MARKET] });

    const candidates = buildBotflowCandidates(events, {
      windowSecs: [10],
      thresholds: {
        minBuyCount: 3,
        minSmallBuyCount: 2,
        minGrossBuySol: 1,
        minNetFlowSol: 0,
        minBuySellRatio: 1,
        smallBuyMaxSol: 0.6,
      },
    });
    const markouts = buildBotflowMarkouts(events, candidates, {
      horizonsSec: [15],
      roundTripCostPct: 0.005,
      maxMarkoutLagMs: 2000,
    });

    expect(markouts[0].quoteStatus).toBe('bad_entry_price');
    expect(markouts[0].priceSource).toBeUndefined();
  });
});
