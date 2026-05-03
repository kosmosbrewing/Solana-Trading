// pure_ws paper-only parameter arms.
// Same accepted signal, different paper state-machine parameters. No live buy, DB write, or canary slot.

import { config } from '../../utils/config';
import type { Signal } from '../../utils/types';
import { activePositions } from './positionState';
import type { PureWsPosition } from './types';
import { trackPureWsPaperMarkout } from './markout';
import { log } from './constants';

interface OpenPaperParamArmsInput {
  signal: Signal;
  primaryPositionId: string;
  primaryEntryPrice: number;
  primaryQuantity: number;
  marketReferencePrice: number;
  buyRatioAtEntry: number;
  txCountAtEntry: number;
  nowSec: number;
  tokenDecimals?: number | null;
}

interface PaperArmSpec {
  suffix: string;
  armName: string;
  parameterVersion: string;
  enabled: boolean;
  minBuyRatio: number;
  minTxCount: number;
  pairCooldownSec: number;
  probeWindowSec: number;
  probeHardCutPct: number;
  probeTrailingPct: number;
  t1MfeThreshold: number;
  t1TrailPct: number;
  profitFloorMult: number;
}

const lastOpenSecByArmPair = new Map<string, number>();

export function resetPureWsPaperParamArmsForTests(): void {
  lastOpenSecByArmPair.clear();
}

export function openPureWsPaperParamArms(input: OpenPaperParamArmsInput): void {
  if (!config.pureWsPaperParamArmsEnabled) return;
  for (const spec of buildArmSpecs()) {
    if (!spec.enabled) continue;
    openPaperArmIfQualified(input, spec);
  }
}

function buildArmSpecs(): PaperArmSpec[] {
  return [
    {
      suffix: 'cost-guard',
      armName: 'pure_ws_cost_guard_v1',
      parameterVersion: 'pure-ws-cost-guard-v1.0.0',
      enabled: config.pureWsPaperCostGuardEnabled,
      minBuyRatio: config.pureWsPaperCostGuardMinBuyRatio,
      minTxCount: config.pureWsPaperCostGuardMinTxCount,
      pairCooldownSec: config.pureWsPaperCostGuardPairCooldownSec,
      probeWindowSec: config.pureWsPaperCostGuardProbeWindowSec,
      probeHardCutPct: config.pureWsPaperCostGuardProbeHardCutPct,
      probeTrailingPct: config.pureWsPaperCostGuardProbeTrailPct,
      t1MfeThreshold: config.pureWsPaperCostGuardT1Mfe,
      t1TrailPct: config.pureWsPaperCostGuardT1TrailPct,
      profitFloorMult: config.pureWsPaperCostGuardProfitFloorMult,
    },
    {
      suffix: 'confirm60',
      armName: 'pure_ws_confirm60_v1',
      parameterVersion: 'pure-ws-confirm60-v1.0.0',
      enabled: config.pureWsPaperConfirm60Enabled,
      minBuyRatio: config.pureWsPaperConfirm60MinBuyRatio,
      minTxCount: config.pureWsPaperConfirm60MinTxCount,
      pairCooldownSec: config.pureWsPaperConfirm60PairCooldownSec,
      probeWindowSec: config.pureWsPaperConfirm60ProbeWindowSec,
      probeHardCutPct: config.pureWsPaperConfirm60ProbeHardCutPct,
      probeTrailingPct: config.pureWsPaperConfirm60ProbeTrailPct,
      t1MfeThreshold: config.pureWsPaperConfirm60T1Mfe,
      t1TrailPct: config.pureWsPaperConfirm60T1TrailPct,
      profitFloorMult: config.pureWsPaperConfirm60ProfitFloorMult,
    },
  ];
}

function openPaperArmIfQualified(input: OpenPaperParamArmsInput, spec: PaperArmSpec): void {
  if (input.buyRatioAtEntry < spec.minBuyRatio || input.txCountAtEntry < spec.minTxCount) {
    log.debug(
      `[PUREWS_PAPER_ARM_SKIP] ${spec.armName} ${input.signal.pairAddress.slice(0, 12)} ` +
      `microstructure buyRatio=${input.buyRatioAtEntry.toFixed(3)} tx=${input.txCountAtEntry} ` +
      `minBuyRatio=${spec.minBuyRatio.toFixed(3)} minTx=${spec.minTxCount}`
    );
    return;
  }
  if (hasOpenArmPosition(input.signal.pairAddress, spec.armName)) return;

  const cooldownKey = `${spec.armName}:${input.signal.pairAddress}`;
  const lastOpenSec = lastOpenSecByArmPair.get(cooldownKey) ?? 0;
  if (input.nowSec - lastOpenSec < spec.pairCooldownSec) {
    log.debug(
      `[PUREWS_PAPER_ARM_COOLDOWN] ${spec.armName} ${input.signal.pairAddress.slice(0, 12)} ` +
      `${spec.pairCooldownSec - (input.nowSec - lastOpenSec)}s remaining`
    );
    return;
  }
  lastOpenSecByArmPair.set(cooldownKey, input.nowSec);

  const paperId = `${input.primaryPositionId}-${spec.suffix}`;
  const position: PureWsPosition = {
    tradeId: paperId,
    pairAddress: input.signal.pairAddress,
    entryPrice: input.primaryEntryPrice,
    marketReferencePrice: input.marketReferencePrice,
    entryTimeSec: input.nowSec,
    quantity: input.primaryQuantity,
    tokenDecimals: input.tokenDecimals ?? null,
    state: 'PROBE',
    peakPrice: input.marketReferencePrice,
    troughPrice: input.marketReferencePrice,
    tokenSymbol: input.signal.tokenSymbol,
    sourceLabel: input.signal.sourceLabel,
    discoverySource: input.signal.discoverySource,
    plannedEntryPrice: input.signal.price,
    buyRatioAtEntry: input.buyRatioAtEntry,
    txCountAtEntry: input.txCountAtEntry,
    continuationT1Threshold: spec.t1MfeThreshold,
    parameterVersion: spec.parameterVersion,
    armName: spec.armName,
    isShadowArm: true,
    parentPositionId: input.primaryPositionId,
    executionMode: 'paper',
    paperOnlyReason: 'paper_param_arm',
    probeWindowSecOverride: spec.probeWindowSec,
    probeHardCutPctOverride: spec.probeHardCutPct,
    probeTrailingPctOverride: spec.probeTrailingPct,
    t1TrailPctOverride: spec.t1TrailPct,
    t1ProfitFloorMultOverride: spec.profitFloorMult,
  };
  activePositions.set(paperId, position);
  trackPureWsPaperMarkout(
    position,
    'buy',
    position.entryPrice,
    Math.max(0.000001, position.entryPrice * position.quantity),
    position.entryTimeSec * 1000,
    {
      buyRatioAtEntry: position.buyRatioAtEntry ?? null,
      txCountAtEntry: position.txCountAtEntry ?? null,
      paperArmMinBuyRatio: spec.minBuyRatio,
      paperArmMinTxCount: spec.minTxCount,
      paperArmPairCooldownSec: spec.pairCooldownSec,
      t1MfeThreshold: spec.t1MfeThreshold,
      probeTrailingPct: spec.probeTrailingPct,
    }
  );
  log.info(
    `[PUREWS_PAPER_ARM_OPEN] ${paperId} ${input.signal.pairAddress.slice(0, 12)} ` +
    `arm=${spec.armName} probe=${spec.probeWindowSec}s hardcut=${(spec.probeHardCutPct * 100).toFixed(2)}% ` +
    `t1=${(spec.t1MfeThreshold * 100).toFixed(2)}% trail=${(spec.t1TrailPct * 100).toFixed(2)}% ` +
    `floor=${spec.profitFloorMult.toFixed(3)}x`
  );
}

function hasOpenArmPosition(pairAddress: string, armName: string): boolean {
  return [...activePositions.values()].some((pos) =>
    pos.pairAddress === pairAddress &&
    pos.armName === armName &&
    pos.state !== 'CLOSED'
  );
}
