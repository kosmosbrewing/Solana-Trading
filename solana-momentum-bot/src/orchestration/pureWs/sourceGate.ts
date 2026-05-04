// pure_ws source gate.
// The active pure_ws thesis is new-pair botflow. Legacy trending/breakout rows
// must not enter the same paper/live evidence stream.

import type { Signal } from '../../utils/types';

export const PURE_WS_NEW_PAIR_DISCOVERY_SOURCES = new Set([
  'gecko_new_pool',
  'program_new_pair',
  'pure_ws_new_pair',
]);

export interface PureWsSourceFields {
  discoverySource?: unknown;
  sourceLabel?: unknown;
  signalSource?: unknown;
  lane?: unknown;
  extras?: unknown;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function extrasOf(row: PureWsSourceFields): PureWsSourceFields {
  return typeof row.extras === 'object' && row.extras != null
    ? row.extras as PureWsSourceFields
    : {};
}

export function normalizePureWsDiscoverySource(row: PureWsSourceFields): string {
  const extras = extrasOf(row);
  return str(row.discoverySource) || str(extras.discoverySource);
}

export function normalizePureWsSourceLabel(row: PureWsSourceFields): string {
  const extras = extrasOf(row);
  return str(row.sourceLabel) || str(extras.sourceLabel) || str(row.signalSource);
}

export function isPureWsNewPairDiscoverySource(source: unknown): boolean {
  return PURE_WS_NEW_PAIR_DISCOVERY_SOURCES.has(str(source));
}

export function isPureWsNewPairSignal(signal: Pick<Signal, 'discoverySource' | 'sourceLabel'>): boolean {
  return isPureWsNewPairDiscoverySource(signal.discoverySource);
}

export function isPureWsNewPairWatchlistEntry<T extends { discoverySource?: string; lane?: string }>(
  entry: T | undefined
): entry is T & { discoverySource: string } {
  if (!entry || !isPureWsNewPairDiscoverySource(entry.discoverySource)) return false;
  return entry.lane == null || entry.lane === 'B';
}

export function isPureWsNewPairLedgerRow(row: PureWsSourceFields): boolean {
  return isPureWsNewPairDiscoverySource(normalizePureWsDiscoverySource(row));
}

export function describePureWsSource(row: PureWsSourceFields): string {
  const discoverySource = normalizePureWsDiscoverySource(row) || 'missing';
  const sourceLabel = normalizePureWsSourceLabel(row) || 'missing';
  const lane = str(row.lane) || str(extrasOf(row).lane) || 'missing';
  return `discoverySource=${discoverySource} sourceLabel=${sourceLabel} lane=${lane}`;
}
