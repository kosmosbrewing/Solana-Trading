import {
  buildBalanceTimelineFromClosedPnls,
  createDrawdownGuardState,
  replayDrawdownGuardState,
  updateDrawdownGuardState,
} from '../src/risk/drawdownGuard';

describe('DrawdownGuard', () => {
  it('reconstructs balance timeline from realized pnl ledger', () => {
    expect(buildBalanceTimelineFromClosedPnls(9, [1, -2])).toEqual([10, 11, 9]);
  });

  it('latches halt until recovery threshold is met', () => {
    const config = { maxDrawdownPct: 0.30, recoveryPct: 0.85 };
    const breached = replayDrawdownGuardState([10, 12, 8], config);

    expect(breached.peakBalanceSol).toBe(12);
    expect(breached.halted).toBe(true);
    expect(breached.recoveryBalanceSol).toBeCloseTo(10.2, 6);
    expect(breached.drawdownPct).toBeCloseTo(1 / 3, 6);

    const stillHalted = updateDrawdownGuardState(
      breached,
      9.5,
      config
    );
    expect(stillHalted.halted).toBe(true);

    const recovered = updateDrawdownGuardState(
      stillHalted,
      10.3,
      config
    );
    expect(recovered.halted).toBe(false);
  });

  it('tracks new peaks after recovery', () => {
    const config = { maxDrawdownPct: 0.30, recoveryPct: 0.85 };
    let state = createDrawdownGuardState(10);

    state = updateDrawdownGuardState(state, 15, config);
    state = updateDrawdownGuardState(state, 10, config);
    expect(state.halted).toBe(true);

    state = updateDrawdownGuardState(state, 13, config);
    expect(state.halted).toBe(false);

    state = updateDrawdownGuardState(state, 16, config);
    expect(state.peakBalanceSol).toBe(16);
    expect(state.recoveryBalanceSol).toBeCloseTo(13.6, 6);
  });
});
