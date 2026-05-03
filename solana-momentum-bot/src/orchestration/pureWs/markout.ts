// pure_ws paper markout sidecar.
// Reuses trade-markout-anchors/markouts so runtime paper truth stays comparable
// with KOL live/paper, while keeping pure_ws horizons lane-specific.

import { buildTradeMarkoutConfigFromGlobal, trackTradeMarkout } from '../../observability/tradeMarkoutObserver';
import { config } from '../../utils/config';
import type { PureWsPosition } from './types';

function uniqSortedSeconds(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isFinite(value) && value > 0))]
    .sort((a, b) => a - b);
}

export function pureWsPaperMarkoutOffsetsSec(): number[] {
  return uniqSortedSeconds(config.pureWsPaperMarkoutOffsetsSec ?? [15, 30, 60, 180, 300, 1800]);
}

function buildPureWsPaperTradeMarkoutConfig() {
  return buildTradeMarkoutConfigFromGlobal({
    realtimeDataDir: config.realtimeDataDir,
    enabled: config.tradeMarkoutObserverEnabled,
    offsetsSec: pureWsPaperMarkoutOffsetsSec(),
    jitterPct: config.tradeMarkoutObserverJitterPct,
    maxInflight: config.tradeMarkoutObserverMaxInflight,
    dedupWindowSec: config.tradeMarkoutObserverDedupWindowSec,
    jupiterApiUrl: config.jupiterApiUrl,
    jupiterApiKey: config.jupiterApiKey,
  });
}

export function trackPureWsPaperMarkout(
  pos: PureWsPosition,
  anchorType: 'buy' | 'sell',
  anchorPrice: number,
  probeSolAmount: number,
  anchorAtMs: number,
  extras: Record<string, unknown> = {},
): void {
  if (anchorPrice <= 0 || probeSolAmount <= 0) return;
  const armName = pos.armName ?? 'pure_ws_breakout';
  const strategy = armName.startsWith('pure_ws') ? armName : 'pure_ws_breakout';
  trackTradeMarkout(
    {
      anchorType,
      positionId: pos.tradeId,
      tokenMint: pos.pairAddress,
      anchorTxSignature: null,
      anchorAtMs,
      anchorPrice,
      anchorPriceKind: anchorType === 'buy' ? 'entry_token_only' : 'exit_token_only',
      probeSolAmount,
      tokenDecimals: pos.tokenDecimals ?? null,
      signalSource: armName,
      extras: {
        lane: 'pure_ws',
        mode: 'paper',
        eventType: `pure_ws_paper_${anchorType}`,
        strategy,
        armName,
        parameterVersion: pos.parameterVersion ?? null,
        isShadowArm: pos.isShadowArm === true,
        parentPositionId: pos.parentPositionId ?? null,
        executionMode: pos.executionMode ?? 'paper',
        paperOnlyReason: pos.paperOnlyReason ?? (pos.isShadowArm ? 'shadow_arm' : null),
        sourceLabel: pos.sourceLabel ?? null,
        discoverySource: pos.discoverySource ?? null,
        ...extras,
      },
    },
    buildPureWsPaperTradeMarkoutConfig()
  );
}
