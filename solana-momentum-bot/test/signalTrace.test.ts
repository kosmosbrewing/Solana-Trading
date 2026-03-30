import type { AttentionScore } from '../src/event/types';
import type { GateEvaluationResult } from '../src/gate';
import { buildSignalAuditBase } from '../src/orchestration/tradeExecution';
import { buildGateTraceSnapshot, buildPositionSignalData } from '../src/orchestration/signalTrace';
import type { Candle, Signal } from '../src/utils/types';

const attentionScore: AttentionScore = {
  tokenMint: 'mint-1',
  tokenSymbol: 'TEST',
  attentionScore: 78,
  components: {
    narrativeStrength: 15,
    sourceQuality: 16,
    timing: 17,
    tokenSpecificity: 14,
    historicalPattern: 16,
  },
  narrative: 'fresh catalyst',
  sources: ['dex_boost', 'community'],
  detectedAt: '2026-03-24T00:00:00.000Z',
  expiresAt: '2026-03-24T01:00:00.000Z',
  confidence: 'high',
};

const signal: Signal = {
  action: 'BUY',
  strategy: 'volume_spike',
  pairAddress: 'pair-1',
  price: 1.25,
  timestamp: new Date('2026-03-24T00:10:00.000Z'),
  sourceLabel: 'scanner_dex_boost',
  meta: { volumeRatio: 3, ticketSizeSol: 0.02 },
  breakoutScore: {
    volumeScore: 20,
    buyRatioScore: 18,
    multiTfScore: 12,
    whaleScore: 9,
    lpScore: 5,
    mcapVolumeScore: 8,
    totalScore: 72,
    grade: 'A',
  },
  poolTvl: 25_000,
  spreadPct: 0.012,
};

const candle: Candle = {
  pairAddress: 'pair-1',
  timestamp: new Date('2026-03-24T00:10:00.000Z'),
  intervalSec: 300,
  open: 1.2,
  high: 1.3,
  low: 1.18,
  close: 1.25,
  volume: 18_000,
  buyVolume: 12_000,
  sellVolume: 6_000,
  tradeCount: 42,
};

const gateResult: GateEvaluationResult = {
  breakoutScore: signal.breakoutScore!,
  gradeSizeMultiplier: 0.3,
  rejected: false,
  attentionScore,
  eventScore: attentionScore,
  executionViability: {
    effectiveRR: 1.8,
    roundTripCost: 0.035,
    sizeMultiplier: 0.5,
    rejected: false,
    riskPct: 0.04,
    rewardPct: 0.12,
    entryPriceImpactPct: 0.01,
    exitPriceImpactPct: 0.013,
    quantity: 0.24,
    notionalSol: 0.3,
  },
  securityGate: {
    approved: true,
    reason: 'Security flags: EXIT_LIQUIDITY_UNKNOWN',
    sizeMultiplier: 0.5,
    flags: ['EXIT_LIQUIDITY_UNKNOWN'],
  },
  quoteGate: {
    approved: true,
    priceImpactPct: 0.012,
    routeFound: true,
    outAmountLamports: 4_000_000n,
    sizeMultiplier: 0.5,
  },
  sellImpactPct: 0.02,
};

const postSizeExecution = {
  ...gateResult.executionViability,
  effectiveRR: 2.1,
  roundTripCost: 0.029,
  sizeMultiplier: 1,
  quantity: 0.12,
  notionalSol: 0.15,
};

describe('signal trace persistence helpers', () => {
  it('builds a gate trace snapshot with attention and gate details', () => {
    const trace = buildGateTraceSnapshot(gateResult, { postSizeExecution });

    expect(trace).toMatchObject({
      attentionScore: 78,
      attentionConfidence: 'high',
      attentionSources: ['dex_boost', 'community'],
      rejected: false,
      gradeSizeMultiplier: 0.3,
      security: {
        approved: true,
        sizeMultiplier: 0.5,
        flags: ['EXIT_LIQUIDITY_UNKNOWN'],
      },
      quote: {
        approved: true,
        routeFound: true,
        priceImpactPct: 0.012,
        sizeMultiplier: 0.5,
      },
      execution: {
        rejected: false,
        effectiveRR: 1.8,
        roundTripCost: 0.035,
        sizeMultiplier: 0.5,
        riskPct: 0.04,
        rewardPct: 0.12,
        entryPriceImpactPct: 0.01,
        exitPriceImpactPct: 0.013,
        quantity: 0.24,
        notionalSol: 0.3,
        preGate: {
          effectiveRR: 1.8,
          quantity: 0.24,
          notionalSol: 0.3,
        },
        postSize: {
          effectiveRR: 2.1,
          roundTripCost: 0.029,
          quantity: 0.12,
          notionalSol: 0.15,
        },
      },
      sellImpactPct: 0.02,
    });
  });

  it('embeds attention and gate trace into position signal data', () => {
    const signalData = buildPositionSignalData(signal, gateResult, 72, 'A', postSizeExecution);

    expect(signalData).toMatchObject({
      score: 72,
      grade: 'A',
      sourceLabel: 'scanner_dex_boost',
      attentionScore: 78,
      attentionConfidence: 'high',
      breakoutScore: {
        totalScore: 72,
        grade: 'A',
      },
      gateTrace: {
        gradeSizeMultiplier: 0.3,
        sellImpactPct: 0.02,
        execution: {
          postSize: {
            effectiveRR: 2.1,
          },
        },
      },
    });
  });

  it('adds attention and gate trace to audit base payloads', () => {
    const auditBase = buildSignalAuditBase(signal, candle, gateResult, postSizeExecution);

    expect(auditBase.attentionScore).toBe(78);
    expect(auditBase.attentionConfidence).toBe('high');
    expect(auditBase.effectiveRR).toBe(2.1);
    expect(auditBase.gateTrace).toMatchObject({
      attentionSources: ['dex_boost', 'community'],
      security: {
        flags: ['EXIT_LIQUIDITY_UNKNOWN'],
      },
      execution: {
        effectiveRR: 1.8,
        postSize: {
          effectiveRR: 2.1,
        },
      },
      sellImpactPct: 0.02,
    });
  });
});
