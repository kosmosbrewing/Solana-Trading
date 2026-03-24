import type { BotContext } from './types';

export interface RealtimeDiscoveryTelemetry {
  discoveryTimestamp?: string;
  triggerWarmupLatencyMs?: number;
}

export function resolveRealtimeDiscoveryTelemetry(
  ctx: BotContext,
  tokenMint: string | undefined,
  signalTimestampIso: string
): RealtimeDiscoveryTelemetry | undefined {
  if (!tokenMint || !ctx.scanner) return undefined;

  const entry = ctx.scanner.getEntry(tokenMint);
  if (!entry) return undefined;

  const discoveryTimestamp = entry.addedAt.toISOString();
  const signalTimestampMs = Date.parse(signalTimestampIso);
  const discoveryTimestampMs = entry.addedAt.getTime();
  const triggerWarmupLatencyMs =
    Number.isFinite(signalTimestampMs) && Number.isFinite(discoveryTimestampMs)
      ? Math.max(0, signalTimestampMs - discoveryTimestampMs)
      : undefined;

  return {
    discoveryTimestamp,
    triggerWarmupLatencyMs,
  };
}
