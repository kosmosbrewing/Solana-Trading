export interface RuntimeDriftInput {
  processName?: string;
  pid: number;
  tradingMode: string;
  realtimeEnabled: boolean;
  jupiterApiUrl: string;
  pm2AllowedProcesses: string[];
}

export interface RuntimeDriftSnapshot {
  processName: string;
  pid: number;
  tradingMode: string;
  realtimeEnabled: boolean;
  jupiterApiUrl: string;
}

export function buildRuntimeDriftSnapshot(input: RuntimeDriftInput): RuntimeDriftSnapshot {
  return {
    processName: input.processName || 'unknown',
    pid: input.pid,
    tradingMode: input.tradingMode,
    realtimeEnabled: input.realtimeEnabled,
    jupiterApiUrl: input.jupiterApiUrl,
  };
}

export function evaluateRuntimeDriftWarnings(input: RuntimeDriftInput): string[] {
  const warnings: string[] = [];
  const processName = input.processName || 'unknown';

  if (processName === 'momentum') {
    warnings.push('legacy_pm2_process_name=momentum');
  }

  if (
    processName !== 'unknown' &&
    input.pm2AllowedProcesses.length > 0 &&
    !input.pm2AllowedProcesses.includes(processName)
  ) {
    warnings.push(`unexpected_pm2_process_name=${processName}`);
  }

  if (input.jupiterApiUrl.includes('quote-api.jup.ag')) {
    warnings.push('legacy_jupiter_quote_host');
  }

  if (isMisconfiguredJupiterApiUrl(input.jupiterApiUrl)) {
    warnings.push(`misconfigured_jupiter_api_url=${input.jupiterApiUrl}`);
  }

  return warnings;
}

function isMisconfiguredJupiterApiUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (
      url.hostname !== 'api.jup.ag' &&
      url.hostname !== 'lite-api.jup.ag'
    ) {
      return false;
    }

    const normalizedPath = url.pathname.replace(/\/+$/, '') || '/';
    return normalizedPath !== '/swap/v1';
  } catch {
    return false;
  }
}
