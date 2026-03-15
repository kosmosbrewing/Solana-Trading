export interface DrawdownGuardConfig {
  maxDrawdownPct: number;
  recoveryPct: number;
}

export interface DrawdownGuardState {
  peakBalanceSol: number;
  currentBalanceSol: number;
  drawdownPct: number;
  recoveryBalanceSol: number;
  halted: boolean;
}

const EPSILON = 1e-9;

export function createDrawdownGuardState(balanceSol: number): DrawdownGuardState {
  const normalizedBalance = Math.max(balanceSol, 0);
  return {
    peakBalanceSol: normalizedBalance,
    currentBalanceSol: normalizedBalance,
    drawdownPct: 0,
    recoveryBalanceSol: normalizedBalance,
    halted: false,
  };
}

export function updateDrawdownGuardState(
  previous: DrawdownGuardState,
  balanceSol: number,
  config: DrawdownGuardConfig
): DrawdownGuardState {
  const normalizedBalance = Math.max(balanceSol, 0);
  const peakBalanceSol = Math.max(previous.peakBalanceSol, normalizedBalance);
  const drawdownPct = peakBalanceSol > EPSILON
    ? Math.max(0, (peakBalanceSol - normalizedBalance) / peakBalanceSol)
    : 0;
  const recoveryBalanceSol = peakBalanceSol * config.recoveryPct;

  let halted = previous.halted;
  if (!halted && drawdownPct >= config.maxDrawdownPct) {
    halted = true;
  }
  if (halted && normalizedBalance + EPSILON >= recoveryBalanceSol) {
    halted = false;
  }

  return {
    peakBalanceSol,
    currentBalanceSol: normalizedBalance,
    drawdownPct,
    recoveryBalanceSol,
    halted,
  };
}

export function replayDrawdownGuardState(
  balanceTimeline: number[],
  config: DrawdownGuardConfig
): DrawdownGuardState {
  if (balanceTimeline.length === 0) {
    return createDrawdownGuardState(0);
  }

  let state = createDrawdownGuardState(balanceTimeline[0]);
  for (let i = 1; i < balanceTimeline.length; i++) {
    state = updateDrawdownGuardState(state, balanceTimeline[i], config);
  }

  return state;
}

export function buildBalanceTimelineFromClosedPnls(
  currentBalanceSol: number,
  realizedPnls: number[]
): number[] {
  const totalRealizedPnl = realizedPnls.reduce((sum, pnl) => sum + pnl, 0);
  const startingBalanceSol = currentBalanceSol - totalRealizedPnl;
  const timeline = [startingBalanceSol];

  let runningBalance = startingBalanceSol;
  for (const pnl of realizedPnls) {
    runningBalance += pnl;
    timeline.push(runningBalance);
  }

  return timeline;
}
