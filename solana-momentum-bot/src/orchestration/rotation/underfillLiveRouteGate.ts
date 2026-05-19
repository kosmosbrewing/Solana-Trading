export interface RotationUnderfillSellRouteEvidence {
  routeFound?: boolean | null;
  reason?: string | null;
  quoteFailed?: boolean | null;
}

export interface RotationUnderfillRouteAssessment {
  blocked: boolean;
  reason: string | null;
  flags: string[];
}

const ROUTE_UNKNOWN_REASON = 'rotation_underfill_live_exit_route_unknown';

function upperFlag(flag: string): string {
  return flag.toUpperCase();
}

export function isRotationUnderfillExitRouteUnknownFlag(flag: string): boolean {
  const upper = upperFlag(flag);
  return upper === 'EXIT_LIQUIDITY_UNKNOWN' ||
    upper === 'NO_SELL_ROUTE' ||
    upper === 'SELL_NO_ROUTE' ||
    upper === 'NO_ROUTE' ||
    upper.includes('NO_SELL_ROUTE');
}

function isHardNoSellRouteFlag(flag: string): boolean {
  const upper = upperFlag(flag);
  return upper === 'NO_SELL_ROUTE' ||
    upper === 'SELL_NO_ROUTE' ||
    upper === 'NO_ROUTE' ||
    upper.includes('NO_SELL_ROUTE');
}

function isExitLiquidityUnknownFlag(flag: string): boolean {
  return upperFlag(flag) === 'EXIT_LIQUIDITY_UNKNOWN';
}

function reasonFlag(reason?: string | null): string | null {
  if (!reason) return null;
  return `ROTATION_UNDERFILL_ROUTE_REASON_${reason.toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 80)}`;
}

export function assessRotationUnderfillLiveRoute(
  entryFlags: string[],
  sellRouteEvidence?: RotationUnderfillSellRouteEvidence | null
): RotationUnderfillRouteAssessment {
  const hasRouteUnknown = entryFlags.some(isRotationUnderfillExitRouteUnknownFlag);
  if (!hasRouteUnknown) return { blocked: false, reason: null, flags: [] };

  const flags: string[] = ['ROTATION_UNDERFILL_ROUTE_PROOF_REQUIRED'];
  const hardNoRoute = entryFlags.some(isHardNoSellRouteFlag);
  const securityExitLiquidityMissing = entryFlags.some(isExitLiquidityUnknownFlag);

  if (securityExitLiquidityMissing) {
    flags.push('ROTATION_UNDERFILL_ROUTE_BUCKET_SECURITY_EXIT_LIQUIDITY_MISSING');
  }

  if (!sellRouteEvidence) {
    flags.push('ROTATION_UNDERFILL_ROUTE_BUCKET_PRELIVE_ROUTE_PROOF_MISSING');
    return { blocked: true, reason: ROUTE_UNKNOWN_REASON, flags };
  }

  const routeReason = reasonFlag(sellRouteEvidence.reason);
  if (routeReason) flags.push(routeReason);

  if (sellRouteEvidence.routeFound === true) {
    flags.push('ROTATION_UNDERFILL_PRELIVE_SELL_ROUTE_OK');
    if (securityExitLiquidityMissing) {
      flags.push('ROTATION_UNDERFILL_ROUTE_BUCKET_QUOTE_OK_SECURITY_UNKNOWN');
    }
    if (!hardNoRoute) return { blocked: false, reason: null, flags };
    flags.push('ROTATION_UNDERFILL_ROUTE_BUCKET_CONFLICTING_NO_ROUTE_FLAG');
    return { blocked: true, reason: ROUTE_UNKNOWN_REASON, flags };
  }

  if (sellRouteEvidence.routeFound === false || hardNoRoute) {
    flags.push('ROTATION_UNDERFILL_ROUTE_BUCKET_SELL_QUOTE_NO_ROUTE');
    return { blocked: true, reason: ROUTE_UNKNOWN_REASON, flags };
  }

  if (sellRouteEvidence.quoteFailed === true || sellRouteEvidence.reason === 'sell_quote_error') {
    flags.push('ROTATION_UNDERFILL_ROUTE_BUCKET_SELL_QUOTE_ERROR');
    return { blocked: true, reason: ROUTE_UNKNOWN_REASON, flags };
  }

  flags.push('ROTATION_UNDERFILL_ROUTE_BUCKET_ROUTE_FOUND_UNKNOWN');
  return { blocked: true, reason: ROUTE_UNKNOWN_REASON, flags };
}
