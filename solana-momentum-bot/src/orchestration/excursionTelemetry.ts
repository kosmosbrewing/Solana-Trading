export interface ExcursionTelemetrySnapshot {
  maeAt5s: number | null;
  maeAt15s: number | null;
  maeAt30s: number | null;
  maeAt60s: number | null;
  maeWorstPct: number;
  maeWorstAtSec: number;
  maeSlopePctPerSec: number | null;
  maeRecoveryPct: number;
  lastMaePct: number;
  lastMfePct: number;
  lastCurrentPct: number;
  lastElapsedSec: number;
}

export interface ExcursionTelemetryInput {
  elapsedSec: number;
  maePct: number;
  mfePct: number;
  currentPct: number;
}

const MAE_SNAPSHOT_SECONDS = [5, 15, 30, 60] as const;

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function maybeCapture(
  previous: number | null,
  thresholdSec: number,
  elapsedSec: number,
  maePct: number
): number | null {
  if (previous != null) return previous;
  return elapsedSec >= thresholdSec ? maePct : null;
}

export function updateExcursionTelemetry(
  previous: ExcursionTelemetrySnapshot | undefined,
  input: ExcursionTelemetryInput
): ExcursionTelemetrySnapshot {
  const elapsedSec = Math.max(0, Math.floor(finiteOrZero(input.elapsedSec)));
  const maePct = finiteOrZero(input.maePct);
  const mfePct = finiteOrZero(input.mfePct);
  const currentPct = finiteOrZero(input.currentPct);
  const previousWorst = previous?.maeWorstPct ?? 0;
  const maeWorstPct = Math.min(previousWorst, maePct);
  const maeWorstAtSec = maeWorstPct < previousWorst
    ? elapsedSec
    : (previous?.maeWorstAtSec ?? 0);
  const maeSlopePctPerSec = maeWorstAtSec > 0 ? maeWorstPct / maeWorstAtSec : null;
  const maeRecoveryPct = Math.max(0, currentPct - maeWorstPct);

  return {
    maeAt5s: maybeCapture(previous?.maeAt5s ?? null, MAE_SNAPSHOT_SECONDS[0], elapsedSec, maePct),
    maeAt15s: maybeCapture(previous?.maeAt15s ?? null, MAE_SNAPSHOT_SECONDS[1], elapsedSec, maePct),
    maeAt30s: maybeCapture(previous?.maeAt30s ?? null, MAE_SNAPSHOT_SECONDS[2], elapsedSec, maePct),
    maeAt60s: maybeCapture(previous?.maeAt60s ?? null, MAE_SNAPSHOT_SECONDS[3], elapsedSec, maePct),
    maeWorstPct,
    maeWorstAtSec,
    maeSlopePctPerSec,
    maeRecoveryPct,
    lastMaePct: maePct,
    lastMfePct: mfePct,
    lastCurrentPct: currentPct,
    lastElapsedSec: elapsedSec,
  };
}

export function emptyExcursionTelemetry(): ExcursionTelemetrySnapshot {
  return {
    maeAt5s: null,
    maeAt15s: null,
    maeAt30s: null,
    maeAt60s: null,
    maeWorstPct: 0,
    maeWorstAtSec: 0,
    maeSlopePctPerSec: null,
    maeRecoveryPct: 0,
    lastMaePct: 0,
    lastMfePct: 0,
    lastCurrentPct: 0,
    lastElapsedSec: 0,
  };
}

export function buildExcursionTelemetryRecord(
  telemetry: ExcursionTelemetrySnapshot | undefined,
  close: { reason: string; maePctAtClose: number; elapsedSec: number }
): Record<string, number | null> {
  const snapshot = telemetry ?? emptyExcursionTelemetry();
  const reason = close.reason.toLowerCase();
  const isHardCut = reason.includes('hard_cut') ||
    reason.includes('structural_kill') ||
    reason.includes('dead_on_arrival') ||
    reason === 'stop_loss';
  return {
    maeAt5s: snapshot.maeAt5s,
    maeAt15s: snapshot.maeAt15s,
    maeAt30s: snapshot.maeAt30s,
    maeAt60s: snapshot.maeAt60s,
    maeWorstPct: snapshot.maeWorstPct,
    maeWorstAtSec: snapshot.maeWorstAtSec,
    maeSlopePctPerSec: snapshot.maeSlopePctPerSec,
    maeRecoveryPct: snapshot.maeRecoveryPct,
    hardCutTriggerMaePct: isHardCut ? close.maePctAtClose : null,
    hardCutTriggerElapsedSec: isHardCut ? close.elapsedSec : null,
  };
}
