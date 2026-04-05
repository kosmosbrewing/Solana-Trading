import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { Pool } from 'pg';
import { createModuleLogger } from '../utils/logger';
import { DailyPnlTracker, DailyLimitConfig } from './dailyPnlTracker';

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

export interface WalletTradeLimitResult {
  allowed: boolean;
  walletName?: string;
  filterReason?: string;
  reason?: string;
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
  private connection: Connection;
  /** M-13: 일일 PnL 추적은 DailyPnlTracker에 위임 */
  readonly dailyPnlTracker: DailyPnlTracker;

  constructor(config: WalletManagerConfig & Partial<typeof DEFAULT_CONFIG>, dbPool?: Pool) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    this.connection = new Connection(cfg.solanaRpcUrl, 'confirmed');

    // Register main wallet (C-10: 키 파싱 실패 시 명확한 에러 메시지)
    let mainKeypair: Keypair;
    try {
      mainKeypair = Keypair.fromSecretKey(bs58.decode(cfg.mainWalletKey));
    } catch (err) {
      throw new Error(`Invalid main wallet private key (WALLET_PRIVATE_KEY). Check Base58 encoding. ${err}`);
    }
    this.wallets.set('main', {
      name: 'main',
      keypair: mainKeypair,
      dailyLossLimitSol: Infinity, // Main wallet uses RiskManager limits
      maxPositionSol: Infinity,
      allowedStrategies: ['volume_spike', 'fib_pullback', 'bootstrap_10s', 'core_momentum'],
    });
    log.info(`Main wallet: ${mainKeypair.publicKey.toBase58().slice(0, 8)}...`);

    // Register sandbox wallet (Strategy D)
    if (cfg.sandboxWalletKey) {
      let sandboxKeypair: Keypair;
      try {
        sandboxKeypair = Keypair.fromSecretKey(bs58.decode(cfg.sandboxWalletKey));
      } catch (err) {
        throw new Error(`Invalid sandbox wallet private key (SANDBOX_WALLET_PRIVATE_KEY). Check Base58 encoding. ${err}`);
      }
      this.wallets.set('sandbox', {
        name: 'sandbox',
        keypair: sandboxKeypair,
        dailyLossLimitSol: cfg.sandboxDailyLossLimitSol!,
        maxPositionSol: cfg.sandboxMaxPositionSol!,
        allowedStrategies: ['new_lp_sniper'],
      });
      log.info(`Sandbox wallet: ${sandboxKeypair.publicKey.toBase58().slice(0, 8)}...`);
    }

    // M-13: DailyPnlTracker에 지갑별 한도 위임
    const limitConfigs: DailyLimitConfig[] = [];
    for (const [name, profile] of this.wallets.entries()) {
      limitConfigs.push({ name, dailyLossLimitSol: profile.dailyLossLimitSol });
    }
    this.dailyPnlTracker = new DailyPnlTracker(limitConfigs, dbPool);
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

  getWalletNameForStrategy(strategy: string): string | undefined {
    return this.getWalletForStrategy(strategy)?.name;
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
   * M-13: DailyPnlTracker에 위임 — DB 초기화 + PnL 로드
   */
  async initDailyPnlStore(): Promise<void> {
    return this.dailyPnlTracker.initialize();
  }

  /** M-13: DailyPnlTracker에 위임 */
  recordPnl(walletName: string, pnlSol: number): void {
    this.dailyPnlTracker.recordPnl(walletName, pnlSol);
  }

  /** M-13: DailyPnlTracker에 위임 */
  isDailyLimitHit(walletName: string): boolean {
    return this.dailyPnlTracker.isDailyLimitHit(walletName);
  }

  /**
   * Check if a position size is within limits for a wallet.
   */
  isWithinLimits(walletName: string, positionSol: number): boolean {
    const profile = this.wallets.get(walletName);
    if (!profile) return false;
    return positionSol <= profile.maxPositionSol;
  }

  checkTradeLimits(strategy: string, positionSol: number): WalletTradeLimitResult {
    const walletName = this.getWalletNameForStrategy(strategy);
    if (!walletName) {
      return {
        allowed: false,
        filterReason: 'wallet_not_configured',
        reason: `No wallet configured for strategy ${strategy}`,
      };
    }

    if (this.isDailyLimitHit(walletName)) {
      return {
        allowed: false,
        walletName,
        filterReason: `${walletName}_wallet_daily_limit`,
        reason: `${walletName} wallet daily loss limit hit`,
      };
    }

    if (!this.isWithinLimits(walletName, positionSol)) {
      return {
        allowed: false,
        walletName,
        filterReason: `${walletName}_wallet_position_limit`,
        reason: `Position ${positionSol.toFixed(4)} SOL exceeds ${walletName} wallet limit`,
      };
    }

    return {
      allowed: true,
      walletName,
    };
  }

  /** M-13: DailyPnlTracker에 위임 */
  getDailyPnl(walletName: string): number {
    return this.dailyPnlTracker.getDailyPnl(walletName);
  }

  /**
   * Check if sandbox wallet is configured.
   */
  hasSandboxWallet(): boolean {
    return this.wallets.has('sandbox');
  }
}
