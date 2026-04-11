/**
 * KOL Wallet Tracker (Path B2 — 2026-04-11)
 *
 * Why: cupsey 같은 KOL 의 buy 를 실시간 감지하여 해당 token 을
 * ScannerEngine watchlist 에 즉시 추가한다. copy trading 이 아니라
 * "더 좋은 universe discovery source" 로 사용.
 *
 * 구현: Helius WS `connection.onLogs(walletPublicKey, ...)` 구독.
 * wallet 이 관여된 tx 에서 SPL token balance 변화 → buy 감지.
 *
 * 기존 heliusWSIngester 의 구독 패턴을 재사용하되,
 * 목적이 다르므로 (pool swap 파싱이 아닌 wallet activity 감지) 별도 모듈.
 */

import { Connection, PublicKey, Logs } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { createModuleLogger } from '../utils/logger';
import { SOL_MINT } from '../utils/constants';

const log = createModuleLogger('KOLWalletTracker');

export interface KolBuySignal {
  walletAddress: string;
  tokenMint: string;
  /** token UI amount delta (positive = buy) */
  tokenDelta: number;
  /** SOL delta (negative = spent SOL) */
  solDelta: number;
  /** estimated price per token (|solDelta| / tokenDelta) */
  estimatedPrice: number;
  signature: string;
  slot: number;
  timestamp: number;
}

export interface KolWalletTrackerConfig {
  rpcUrl: string;
  walletAddresses: string[];
}

/**
 * KOL wallet 을 Helius WS 로 구독하고 buy signal 을 emit 하는 tracker.
 *
 * Events:
 *   - 'buy' (KolBuySignal) — KOL 이 새 token 을 매수한 것으로 추정되는 activity
 *   - 'error' ({ wallet, error })
 *
 * Usage:
 *   const tracker = new KolWalletTracker({ rpcUrl, walletAddresses: ['cupsey-wallet'] });
 *   tracker.on('buy', (signal) => { scanner.addManualEntry(signal.tokenMint, ...) });
 *   await tracker.start();
 */
export class KolWalletTracker extends EventEmitter {
  private connection: Connection;
  private wallets: string[];
  private subscriptions = new Map<string, number>();

  constructor(config: KolWalletTrackerConfig) {
    super();
    this.connection = new Connection(config.rpcUrl, 'confirmed');
    this.wallets = config.walletAddresses.filter(w => w.length > 0);
  }

  async start(): Promise<void> {
    if (this.wallets.length === 0) {
      log.info('KOL wallet tracker: no wallets configured, skipping');
      return;
    }

    for (const wallet of this.wallets) {
      try {
        const publicKey = new PublicKey(wallet);
        const subscriptionId = this.connection.onLogs(
          publicKey,
          (logs, ctx) => {
            void this.handleWalletActivity(wallet, logs, ctx.slot);
          },
          'confirmed'
        );
        this.subscriptions.set(wallet, subscriptionId);
        log.info(`KOL wallet subscribed: ${wallet.slice(0, 8)}...`);
      } catch (error) {
        log.warn(`Failed to subscribe KOL wallet ${wallet.slice(0, 8)}: ${error}`);
        this.emit('error', { wallet, error });
      }
    }

    log.info(`KOL wallet tracker started: ${this.subscriptions.size} wallets`);
  }

  async stop(): Promise<void> {
    for (const [wallet, subId] of this.subscriptions) {
      await this.connection.removeOnLogsListener(subId);
      log.info(`KOL wallet unsubscribed: ${wallet.slice(0, 8)}...`);
    }
    this.subscriptions.clear();
  }

  private async handleWalletActivity(
    walletAddress: string,
    logs: Logs,
    slot: number
  ): Promise<void> {
    if (logs.err) return;

    // Quick heuristic: does this look like a swap/buy?
    // Check for SPL Token program involvement + known DEX program
    const logText = logs.logs.join('\n');
    const hasSplToken = logText.includes('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const hasSwapLike = logText.includes('swap') || logText.includes('Swap') ||
                        logText.includes('ray_log') || logText.includes('Program data:');

    if (!hasSplToken && !hasSwapLike) return;

    // Fetch parsed transaction for detailed balance changes
    try {
      const tx = await this.connection.getParsedTransaction(
        logs.signature,
        { maxSupportedTransactionVersion: 0 }
      );
      if (!tx || !tx.meta || tx.meta.err) return;

      const pre = tx.meta.preTokenBalances ?? [];
      const post = tx.meta.postTokenBalances ?? [];

      // Find token balance increases for this wallet (= buy)
      const preMap = new Map<string, number>();
      for (const b of pre) {
        if (b.owner !== walletAddress) continue;
        const amt = b.uiTokenAmount.uiAmount ?? 0;
        preMap.set(b.mint, (preMap.get(b.mint) ?? 0) + amt);
      }

      for (const b of post) {
        if (b.owner !== walletAddress) continue;
        if (b.mint === SOL_MINT) continue;
        const postAmt = b.uiTokenAmount.uiAmount ?? 0;
        const preAmt = preMap.get(b.mint) ?? 0;
        const delta = postAmt - preAmt;

        if (delta > 0) {
          // Token balance increased = BUY detected
          // Estimate SOL spent from lamport delta
          const accountKeys = tx.transaction.message.accountKeys;
          let solDelta = 0;
          for (let i = 0; i < accountKeys.length; i++) {
            const key = typeof accountKeys[i] === 'string'
              ? accountKeys[i]
              : (accountKeys[i] as { pubkey: PublicKey }).pubkey?.toBase58() ?? '';
            if (key === walletAddress) {
              solDelta = ((tx.meta.postBalances[i] ?? 0) - (tx.meta.preBalances[i] ?? 0)) / 1e9;
              break;
            }
          }

          const estimatedPrice = delta > 0 && solDelta < 0
            ? Math.abs(solDelta) / delta
            : 0;

          const signal: KolBuySignal = {
            walletAddress,
            tokenMint: b.mint,
            tokenDelta: delta,
            solDelta,
            estimatedPrice,
            signature: logs.signature,
            slot,
            timestamp: tx.blockTime ?? Math.floor(Date.now() / 1000),
          };

          log.info(
            `[KOL_BUY] ${walletAddress.slice(0, 8)} bought ${b.mint.slice(0, 8)}... ` +
            `delta=${delta.toFixed(4)} SOL_spent=${Math.abs(solDelta).toFixed(4)} ` +
            `price=${estimatedPrice.toFixed(8)}`
          );

          this.emit('buy', signal);
        }
      }
    } catch (error) {
      // Rate limit or RPC error — silently skip
      log.debug(`KOL wallet tx parse failed: ${error}`);
    }
  }
}
