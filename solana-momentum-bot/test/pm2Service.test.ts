import { buildRestartProcessArgs } from '../src/ops/pm2Service';

describe('Pm2Service restart command', () => {
  it('restarts an existing process directly', () => {
    expect(buildRestartProcessArgs('momentum-bot', true, '/repo/ecosystem.config.cjs')).toEqual([
      'restart',
      'momentum-bot',
      '--update-env',
    ]);
  });

  it('starts from ecosystem config only when the process is missing', () => {
    expect(buildRestartProcessArgs('momentum-bot', true, '/repo/ecosystem.config.cjs', false)).toEqual([
      'startOrRestart',
      '/repo/ecosystem.config.cjs',
      '--only',
      'momentum-bot',
      '--update-env',
    ]);
  });

  it('falls back to simple restart when ecosystem config is unavailable', () => {
    expect(buildRestartProcessArgs('momentum-bot', false, '/repo/ecosystem.config.cjs', false)).toEqual([
      'restart',
      'momentum-bot',
      '--update-env',
    ]);
  });
});
