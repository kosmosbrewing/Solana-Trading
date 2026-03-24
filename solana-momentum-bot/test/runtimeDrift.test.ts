import {
  buildRuntimeDriftSnapshot,
  evaluateRuntimeDriftWarnings,
} from '../src/ops/runtimeDrift';

describe('runtimeDrift', () => {
  it('builds a runtime snapshot for startup logging', () => {
    expect(buildRuntimeDriftSnapshot({
      processName: 'momentum-bot',
      pid: 1234,
      tradingMode: 'paper',
      realtimeEnabled: true,
      jupiterApiUrl: 'https://api.jup.ag',
      pm2AllowedProcesses: ['momentum-bot', 'momentum-shadow'],
    })).toEqual({
      processName: 'momentum-bot',
      pid: 1234,
      tradingMode: 'paper',
      realtimeEnabled: true,
      jupiterApiUrl: 'https://api.jup.ag',
    });
  });

  it('warns on legacy pm2 process names and legacy Jupiter host', () => {
    expect(evaluateRuntimeDriftWarnings({
      processName: 'momentum',
      pid: 4321,
      tradingMode: 'live',
      realtimeEnabled: true,
      jupiterApiUrl: 'https://quote-api.jup.ag/v6',
      pm2AllowedProcesses: ['momentum-bot', 'momentum-shadow'],
    })).toEqual([
      'legacy_pm2_process_name=momentum',
      'unexpected_pm2_process_name=momentum',
      'legacy_jupiter_quote_host',
    ]);
  });
});
