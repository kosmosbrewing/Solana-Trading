import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { WalletManager } from '../src/executor/walletManager';

function makeWalletKey(): string {
  return bs58.encode(Keypair.generate().secretKey);
}

describe('WalletManager trade limits', () => {
  it('resolves strategy to wallet and allows trades within limits', () => {
    const manager = new WalletManager({
      solanaRpcUrl: 'http://localhost:8899',
      mainWalletKey: makeWalletKey(),
      sandboxWalletKey: makeWalletKey(),
      sandboxDailyLossLimitSol: 0.5,
      sandboxMaxPositionSol: 0.05,
    });

    const result = manager.checkTradeLimits('new_lp_sniper', 0.02);

    expect(result.allowed).toBe(true);
    expect(result.walletName).toBe('sandbox');
  });

  it('blocks trades when sandbox daily loss limit is hit', () => {
    const manager = new WalletManager({
      solanaRpcUrl: 'http://localhost:8899',
      mainWalletKey: makeWalletKey(),
      sandboxWalletKey: makeWalletKey(),
      sandboxDailyLossLimitSol: 0.5,
      sandboxMaxPositionSol: 0.05,
    });

    manager.recordPnl('sandbox', -0.6);

    const result = manager.checkTradeLimits('new_lp_sniper', 0.02);

    expect(result.allowed).toBe(false);
    expect(result.filterReason).toBe('sandbox_wallet_daily_limit');
  });

  it('blocks trades when wallet position limit is exceeded', () => {
    const manager = new WalletManager({
      solanaRpcUrl: 'http://localhost:8899',
      mainWalletKey: makeWalletKey(),
      sandboxWalletKey: makeWalletKey(),
      sandboxDailyLossLimitSol: 0.5,
      sandboxMaxPositionSol: 0.05,
    });

    const result = manager.checkTradeLimits('new_lp_sniper', 0.08);

    expect(result.allowed).toBe(false);
    expect(result.filterReason).toBe('sandbox_wallet_position_limit');
  });
});
