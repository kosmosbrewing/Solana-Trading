import {
  assessRotationUnderfillLiveRoute,
  isRotationUnderfillExitRouteUnknownFlag,
} from '../src/orchestration/rotation/underfillLiveRouteGate';

describe('underfillLiveRouteGate', () => {
  it('does not block when no route-unknown flag is present', () => {
    const result = assessRotationUnderfillLiveRoute(['CLEAN_TOKEN']);

    expect(result.blocked).toBe(false);
    expect(result.reason).toBeNull();
  });

  it('blocks legacy exit-liquidity unknown when no pre-live route proof exists', () => {
    const result = assessRotationUnderfillLiveRoute(['EXIT_LIQUIDITY_UNKNOWN']);

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('rotation_underfill_live_exit_route_unknown');
    expect(result.flags).toContain('ROTATION_UNDERFILL_ROUTE_BUCKET_PRELIVE_ROUTE_PROOF_MISSING');
  });

  it('allows security-unknown candidates when sized sell quote proves a route', () => {
    const result = assessRotationUnderfillLiveRoute(
      ['EXIT_LIQUIDITY_UNKNOWN'],
      { routeFound: true, reason: null, quoteFailed: false }
    );

    expect(result.blocked).toBe(false);
    expect(result.flags).toContain('ROTATION_UNDERFILL_PRELIVE_SELL_ROUTE_OK');
    expect(result.flags).toContain('ROTATION_UNDERFILL_ROUTE_BUCKET_QUOTE_OK_SECURITY_UNKNOWN');
  });

  it('keeps hard no-route flags blocked even if evidence conflicts', () => {
    const result = assessRotationUnderfillLiveRoute(
      ['NO_SELL_ROUTE'],
      { routeFound: true, reason: null, quoteFailed: false }
    );

    expect(result.blocked).toBe(true);
    expect(result.flags).toContain('ROTATION_UNDERFILL_ROUTE_BUCKET_CONFLICTING_NO_ROUTE_FLAG');
  });

  it('blocks explicit sell quote no-route evidence', () => {
    const result = assessRotationUnderfillLiveRoute(
      ['EXIT_LIQUIDITY_UNKNOWN'],
      { routeFound: false, reason: 'no_sell_route', quoteFailed: false }
    );

    expect(result.blocked).toBe(true);
    expect(result.flags).toContain('ROTATION_UNDERFILL_ROUTE_BUCKET_SELL_QUOTE_NO_ROUTE');
  });

  it('treats sell quote errors as blocked proof gaps', () => {
    const result = assessRotationUnderfillLiveRoute(
      ['EXIT_LIQUIDITY_UNKNOWN'],
      { routeFound: null, reason: 'sell_quote_error', quoteFailed: true }
    );

    expect(result.blocked).toBe(true);
    expect(result.flags).toContain('ROTATION_UNDERFILL_ROUTE_BUCKET_SELL_QUOTE_ERROR');
  });

  it('recognizes legacy no-route flags', () => {
    expect(isRotationUnderfillExitRouteUnknownFlag('EXIT_LIQUIDITY_UNKNOWN')).toBe(true);
    expect(isRotationUnderfillExitRouteUnknownFlag('NO_SELL_ROUTE')).toBe(true);
    expect(isRotationUnderfillExitRouteUnknownFlag('SELL_NO_ROUTE')).toBe(true);
    expect(isRotationUnderfillExitRouteUnknownFlag('CLEAN_TOKEN')).toBe(false);
  });
});
