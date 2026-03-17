import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('WalletManager');

export interface WalletProfile {
  name: string;
  keypair: Keypair;
  /** Daily loss limit in SOL for this wallet */
  dailyLossLimitSol: number;
  /** Max single position size in SOL */
  maxPositionSol: number;
  /** Strategies allowed to use this wallet */
  allowedStrategies: string[];
}

export interface WalletManagerConfig {
  solanaRpcUrl: string;
  /** Main wallet private key (Base58) — for Strategy A/C */
  mainWalletKey: string;
  /** Sandbox wallet private key (Base58) — for Strategy D */
  sandboxWalletKey?: string;
  /** Daily loss limit for sandbox wallet (SOL) */
  sandboxDailyLossLimitSol: number;
  /** Max position size for sandbox wallet (SOL) */
  sandboxMaxPositionSol: number;
}

const DEFAULT_CONFIG: Partial<WalletManagerConfig> = {
  sandboxDailyLossLimitSol: 0.5,
  sandboxMaxPositionSol: 0.05,
};

/**
 * Isolated Wallet Manager — Phase 3 자본 격리.
 *
 * 메인 지갑 (Strategy A/C)과 샌드박스 지갑 (Strategy D)을
 * 완전히 분리하여:
 *   - 각 지갑별 잔고 독립 추적
 *   - 전략별 일일 손실 한도 독립 관리
 *   - 하나의 전략 실패가 다른 전략 자본에 영향 없음
 */
export class WalletManager {
  private wallets = new Map<string, WalletProfile>();
  private dailyPnl = new Map<string, number>();
  private connection: Connection;
  private lastResetDate: string;

  constructor(config: WalletManagerConfig & Partial<typeof DEFAULT_CONFIG>) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    this.connection = new Connection(cfg.solanaRpcUrl, 'confirmed');
    this.lastResetDate = new Date().toISOString().slice(0, 10);

    // Register main wallet
    const mainKeypair = Keypair.fromSecretKey(bs58.decode(cfg.mainWalletKey));
    this.wallets.set('main', {
      name: 'main',
      keypair: mainKeypair,
      dailyLossLimitSol: Infinity, // Main wallet uses RiskManager limits
      maxPositionSol: Infinity,
      allowedStrategies: ['volume_spike', 'fib_pullback'],
    });
    log.info(`Main wallet: ${mainKeypair.publicKey.toBase58().slice(0, 8)}...`);

    // Register sandbox wallet (Strategy D)
    if (cfg.sandboxWalletKey) {
      const sandboxKeypair = Keypair.fromSecretKey(bs58.decode(cfg.sandboxWalletKey));
      this.wallets.set('sandbox', {
        name: 'sandbox',
        keypair: sandboxKeypair,
        dailyLossLimitSol: cfg.sandboxDailyLossLimitSol!,
        maxPositionSol: cfg.sandboxMaxPositionSol!,
        allowedStrategies: ['new_lp_sniper'],
      });
      log.info(`Sandbox wallet: ${sandboxKeypair.publicKey.toBase58().slice(0, 8)}...`);
    }
  }

  /**
   * Get the wallet profile for a strategy.
   */
  getWalletForStrategy(strategy: string): WalletProfile | undefined {
    for (const profile of this.wallets.values()) {
      if (profile.allowedStrategies.includes(strategy)) {
        return profile;
      }
    }
    return undefined;
  }

  /**
   * Get wallet by name.
   */
  getWallet(name: string): WalletProfile | undefined {
    return this.wallets.get(name);
  }

  /**
   * Get SOL balance for a wallet.
   */
  async getBalance(name: string): Promise<number> {
    const profile = this.wallets.get(name);
    if (!profile) return 0;
    const balance = await this.connection.getBalance(profile.keypair.publicKey);
    return balance / 1e9;
  }

  /**
   * Record a PnL event for daily loss tracking.
   */
  recordPnl(walletName: string, pnlSol: number): void {
    this.maybeResetDaily();
    const current = this.dailyPnl.get(walletName) ?? 0;
    this.dailyPnl.set(walletName, current + pnlSol);
  }

  /**
   * Check if a wallet has hit its daily loss limit.
   */
  isDailyLimitHit(walletName: string): boolean {
    this.maybeResetDaily();
    const profile = this.wallets.get(walletName);
    if (!profile) return true;

    const dailyPnl = this.dailyPnl.get(walletName) ?? 0;
    if (dailyPnl <= -profile.dailyLossLimitSol) {
      log.warn(
        `${walletName} daily loss limit hit: ${dailyPnl.toFixed(4)} SOL ` +
        `(limit: -${profile.dailyLossLimitSol} SOL)`
      );
      return true;
    }
    return false;
  }

  /**
   * Check if a position size is within limits for a wallet.
   */
  isWithinLimits(walletName: string, positionSol: number): boolean {
    const profile = this.wallets.get(walletName);
    if (!profile) return false;
    return positionSol <= profile.maxPositionSol;
  }

  /**
   * Get daily PnL for a wallet.
   */
  getDailyPnl(walletName: string): number {
    this.maybeResetDaily();
    return this.dailyPnl.get(walletName) ?? 0;
  }

  /**
   * Reset daily PnL at midnight UTC.
   */
  private maybeResetDaily(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastResetDate) {
      this.dailyPnl.clear();
      this.lastResetDate = today;
      log.info('Daily PnL counters reset');
    }
  }

  /**
   * Check if sandbox wallet is configured.
   */
  hasSandboxWallet(): boolean {
    return this.wallets.has('sandbox');
  }
}
