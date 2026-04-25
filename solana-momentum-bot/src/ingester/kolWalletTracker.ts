/**
 * KOL Wallet Tracker (Option 5, 2026-04-23)
 *
 * ADR: docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md
 * REFACTORING §6: Phase 1 passive logging + candidate queue 발행.
 *
 * 동작:
 *  1. `getAllActiveAddresses()` → KOL 주소 set
 *  2. 각 address 에 `connection.onLogs(address, callback)` 구독
 *  3. log event → `getParsedTransaction` fetch
 *  4. pre/post token balances / SOL delta 로 wallet 중심 swap 감지
 *  5. `KolTx` emit + `kol-tx.jsonl` append
 *  6. Anti-correlation dedup (60s) 은 **scoring 단계에서** 처리 (tracker 는 그대로 pass)
 *
 * Real Asset Guard 무영향 (read-only, sandbox safe).
 * Helius rate limit 고려: active KOL > N 시 tier S 만 실시간, A/B 는 polling degrade (추가 후 구현).
 *
 * NOT a signal handler — 단순 publisher. 실제 trade 판단은 kolSignalHandler (Phase 3).
 */
import { EventEmitter } from 'events';
import { Connection, ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';
import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { createModuleLogger } from '../utils/logger';
import { SOL_MINT, LAMPORTS_PER_SOL } from '../utils/constants';
import { getAllActiveAddresses, lookupKolByAddress } from '../kol/db';
import type { KolTx, KolAction } from '../kol/types';

const log = createModuleLogger('KolWalletTracker');

export interface KolWalletTrackerConfig {
  /** Solana RPC Connection 주입 (기존 rpc 재활용) */
  connection: Connection;
  /** jsonl 출력 디렉토리 */
  realtimeDataDir: string;
  /** jsonl 파일명 (기본 'kol-tx.jsonl') */
  logFileName: string;
  /** fetch tx timeout ms */
  txFetchTimeoutMs: number;
  /** 활성화 flag (env gate) */
  enabled: boolean;
}

export class KolWalletTracker extends EventEmitter {
  private readonly subscriptions = new Map<string, number>();
  private readonly config: KolWalletTrackerConfig;
  private started = false;
  private outputDirEnsured = false;

  constructor(config: KolWalletTrackerConfig) {
    super();
    this.config = config;
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      log.info(`[KOL_TRACKER] disabled by config — skip start`);
      return;
    }
    if (this.started) return;
    this.started = true;

    const addresses = getAllActiveAddresses();
    if (addresses.length === 0) {
      log.warn(`[KOL_TRACKER] no active KOL addresses — tracker idle (DB 확인 필요)`);
      return;
    }
    log.info(`[KOL_TRACKER] subscribing to ${addresses.length} KOL addresses`);

    for (const addr of addresses) {
      await this.subscribeAddress(addr).catch((err) => {
        log.warn(`[KOL_TRACKER] subscribe ${addr.slice(0, 8)}... failed: ${String(err)}`);
      });
    }
    log.info(`[KOL_TRACKER] started — active subscriptions: ${this.subscriptions.size}`);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const [addr, subId] of this.subscriptions) {
      try {
        await this.config.connection.removeOnLogsListener(subId);
      } catch (err) {
        log.debug(`[KOL_TRACKER] unsubscribe ${addr.slice(0, 8)} failed: ${String(err)}`);
      }
    }
    this.subscriptions.clear();
    log.info(`[KOL_TRACKER] stopped`);
  }

  /** 현재 구독 수 (헬스체크용). */
  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  // ─── Subscription ─────────────────────────────────────

  private async subscribeAddress(address: string): Promise<void> {
    try {
      const pubkey = new PublicKey(address);
      const subId = this.config.connection.onLogs(
        pubkey,
        (logInfo, ctx) => {
          if (logInfo.err) return; // 실패한 tx 무시
          // Fire-and-forget fetch — latency 영향 없음
          this.handleLog(address, logInfo.signature, ctx.slot).catch((err) => {
            log.debug(`[KOL_TRACKER] handleLog error ${address.slice(0, 8)}: ${String(err)}`);
          });
        },
        'confirmed'
      );
      this.subscriptions.set(address, subId);
    } catch (err) {
      throw new Error(`invalid address ${address}: ${String(err)}`);
    }
  }

  private async handleLog(walletAddress: string, signature: string, slot: number): Promise<void> {
    const wallet = lookupKolByAddress(walletAddress);
    if (!wallet) return; // DB 에서 사라졌거나 비활성

    const tx = await Promise.race([
      this.config.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), this.config.txFetchTimeoutMs)),
    ]);
    if (!tx) return;

    const swap = detectSwapFromWalletPerspective(tx, walletAddress);
    if (!swap) return;

    const kolTx: KolTx = {
      kolId: wallet.id,
      walletAddress,
      tier: wallet.tier,
      tokenMint: swap.tokenMint,
      action: swap.action,
      timestamp: (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000,
      txSignature: signature,
      solAmount: swap.solAmount,
    };

    // Emit → downstream consumer (Phase 3 kolSignalHandler)
    this.emit('kol_swap', kolTx);

    // Persist
    await this.appendJsonl(kolTx);

    log.info(
      `[KOL_TX] kol=${wallet.id} tier=${wallet.tier} ${kolTx.action} ` +
      `${swap.tokenMint.slice(0, 8)}... sol=${swap.solAmount?.toFixed(4) ?? '?'} sig=${signature.slice(0, 8)}`
    );
  }

  private async appendJsonl(kolTx: KolTx): Promise<void> {
    try {
      if (!this.outputDirEnsured) {
        await mkdir(this.config.realtimeDataDir, { recursive: true });
        this.outputDirEnsured = true;
      }
      const line = JSON.stringify({ ...kolTx, recordedAt: new Date().toISOString() }) + '\n';
      await appendFile(
        path.join(this.config.realtimeDataDir, this.config.logFileName),
        line,
        'utf8'
      );
    } catch (err) {
      log.debug(`[KOL_TRACKER] jsonl append failed: ${String(err)}`);
    }
  }
}

// ─── Wallet-perspective swap detection (pure function, tested) ───

export interface WalletSwapDetection {
  action: KolAction;
  tokenMint: string;
  solAmount: number;
}

/**
 * Wallet 중심 swap 감지:
 *  - wallet SOL delta < 0 + token delta > 0 = buy (SOL 지불, token 수령)
 *  - wallet SOL delta > 0 + token delta < 0 = sell (token 지불, SOL 수령)
 * Multi-hop route 는 largest-token-delta heuristic 으로 대표 token 선택.
 *
 * Pure function — 테스트 용이.
 */
export function detectSwapFromWalletPerspective(
  tx: ParsedTransactionWithMeta | null,
  walletAddress: string
): WalletSwapDetection | null {
  if (!tx || !tx.meta) return null;
  const meta = tx.meta;
  if (meta.err) return null;

  // 1. wallet 의 account index 찾기
  const accountKeys = tx.transaction.message.accountKeys;
  const walletIdx = accountKeys.findIndex((k) => k.pubkey.toBase58() === walletAddress);
  if (walletIdx < 0) return null;

  // 2. SOL delta
  const preSol = meta.preBalances?.[walletIdx] ?? 0;
  const postSol = meta.postBalances?.[walletIdx] ?? 0;
  const solDeltaLamports = postSol - preSol;
  // Fee 는 wallet 의 SOL delta 에서 차감됨 — fee 이상의 큰 음수/양수만 swap 으로 간주
  if (Math.abs(solDeltaLamports) < 10_000) return null; // < 0.00001 SOL 변동 무시

  // 3. Token delta — wallet owner 의 token account 들
  const preTokens = meta.preTokenBalances ?? [];
  const postTokens = meta.postTokenBalances ?? [];
  const tokenDeltaByMint = new Map<string, number>();

  for (const post of postTokens) {
    if (post.owner !== walletAddress) continue;
    const postUi = post.uiTokenAmount?.uiAmount ?? 0;
    const pre = preTokens.find(
      (p) => p.owner === walletAddress && p.mint === post.mint
    );
    const preUi = pre?.uiTokenAmount?.uiAmount ?? 0;
    const delta = postUi - preUi;
    if (Math.abs(delta) > 0) {
      tokenDeltaByMint.set(post.mint, (tokenDeltaByMint.get(post.mint) ?? 0) + delta);
    }
  }
  // 이전엔 있고 이후엔 없는 account 도 처리
  for (const pre of preTokens) {
    if (pre.owner !== walletAddress) continue;
    if (tokenDeltaByMint.has(pre.mint)) continue;
    const postMatch = postTokens.find(
      (p) => p.owner === walletAddress && p.mint === pre.mint
    );
    if (postMatch) continue;
    const preUi = pre.uiTokenAmount?.uiAmount ?? 0;
    if (preUi > 0) {
      tokenDeltaByMint.set(pre.mint, -preUi);
    }
  }

  if (tokenDeltaByMint.size === 0) return null;

  // 4. Largest-magnitude non-SOL token 선택
  let candidateMint = '';
  let candidateDelta = 0;
  for (const [mint, delta] of tokenDeltaByMint) {
    if (mint === SOL_MINT) continue;
    if (Math.abs(delta) > Math.abs(candidateDelta)) {
      candidateMint = mint;
      candidateDelta = delta;
    }
  }
  if (!candidateMint) return null;

  // 5. action 판정
  const action: KolAction =
    solDeltaLamports < 0 && candidateDelta > 0 ? 'buy'
    : solDeltaLamports > 0 && candidateDelta < 0 ? 'sell'
    : null as unknown as KolAction;
  if (action === null) return null;

  return {
    action,
    tokenMint: candidateMint,
    solAmount: Math.abs(solDeltaLamports) / LAMPORTS_PER_SOL,
  };
}
