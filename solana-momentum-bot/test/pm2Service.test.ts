import { buildRestartProcessArgs } from '../src/ops/pm2Service';

describe('Pm2Service restart command', () => {
  it('reapplies ecosystem config when available', () => {
    expect(buildRestartProcessArgs('momentum-bot', true, '/repo/ecosystem.config.cjs')).toEqual([
      'startOrRestart',
      '/repo/ecosystem.config.cjs',
      '--only',
      'momentum-bot',
      '--update-env',
    ]);
  });

  it('falls back to simple restart when ecosystem config is unavailable', () => {
    expect(buildRestartProcessArgs('momentum-bot', false, '/repo/ecosystem.config.cjs')).toEqual([
      'restart',
      'momentum-bot',
      '--update-env',
    ]);
  });
});
