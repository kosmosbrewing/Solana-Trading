export function isDrawdownGuardHaltReason(reason?: string): boolean {
  return typeof reason === 'string' && reason.startsWith('Drawdown guard active:');
}

export function getHardTradingHaltReason(reason?: string): string | undefined {
  // 2026-05-04 mission alignment: 0.6 SOL wallet floor is the hard survival stop.
  // HWM-relative drawdown remains useful telemetry, but it must not freeze all lanes above floor.
  if (!reason || isDrawdownGuardHaltReason(reason)) return undefined;
  return reason;
}
