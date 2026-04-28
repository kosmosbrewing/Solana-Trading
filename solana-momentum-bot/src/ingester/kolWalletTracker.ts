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
import {
  getAllActiveAddresses,
  getAllInactiveAddresses,
  lookupAnyKolByAddress,
  lookupKolByAddress,
} from '../kol/db';
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
  /**
   * Inactive KOL Shadow Track (Option A, 2026-04-27).
   * true 면 inactive KOL 도 subscribe 하지만 tx 는 별도 logger 에만 기록.
   * `kol_swap` event emit 안 함 → kolSignalHandler / smart-v3 / swing-v2 entry 호출 불가.
   *
   * Helius 429 risk MEDIUM: subscription 수가 active+inactive 합산이라 RPC 부담 ↑.
   * fetch rate cooldown 전략: 기존 `txFetchTimeoutMs` (5s) 와 onLogs fire-and-forget 구조 그대로 사용.
   * 추가 throttle 미적용 (관측 신호량 기반 향후 조정).
   */
  shadowTrackInactive?: boolean;
  /** Shadow tx jsonl 파일명 (default 'kol-shadow-tx.jsonl'). */
  shadowLogFileName?: string;
  /**
   * 2026-04-28: inactive KOL paper trade opt-in (Option B).
   * true 면 shadow tx 도 `kol_swap` event 로 emit (isShadow=true).
   * kolSignalHandler 가 inactive 분기로 paper PROBE 진입 → 별도 ledger 로 dump.
   * `shadowTrackInactive=true` 의 superset (둘 다 활성 필요).
   */
  shadowPaperTradeEnabled?: boolean;
}

/** 2026-04-26 (P0 audit fix #1): watchdog tunables — silent disconnect 시 자동 재구독.
 *  helius_ws_churn_fix_2026_04_21 패턴 재사용 — RPC 가 onLogs 를 silently 끊으면 KOL signal
 *  전체가 소멸하지만 알림이 없는 문제 fix. */
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;       // 5min — RPC churn detection
const RESUBSCRIBE_COOLDOWN_MS = 5 * 60 * 1000;    // 5min cooldown — thundering herd 방지
const FULL_DISCONNECT_ALERT_AFTER_MS = 15 * 60 * 1000;  // 15min: 모든 sub 사라지면 critical

export class KolWalletTracker extends EventEmitter {
  private readonly subscriptions = new Map<string, number>();
  private readonly config: KolWalletTrackerConfig;
  private started = false;
  private outputDirEnsured = false;
  private targetAddresses: string[] = [];
  // Shadow track (Option A): inactive KOL 만 담는 별도 set. handleLog 에서 routing 결정.
  // active 와 분리해야 sync 시 active→inactive 전환 (또는 역) 같은 미묘한 상태 변화 추적 가능.
  private shadowAddresses: Set<string> = new Set();
  private watchdogTimer: NodeJS.Timeout | null = null;
  private lastResubscribeMs = 0;
  private lastNonZeroSubscriptionsMs = Date.now();
  private fullDisconnectAlerted = false;
  // 2026-04-27 (B-fix QA F1): re-entry guard. setInterval 콜백은 await 안 함 → 이론적 overlap.
  // 실제 발생 가능성 매우 낮지만 (650ms typical vs 5min interval), 미래 race 가드.
  private syncInProgress = false;

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

    const activeAddresses = getAllActiveAddresses();
    // Shadow (Option A): inactive 도 subscribe — tx 는 별도 jsonl 로만 라우팅.
    const shadowAddrs = this.config.shadowTrackInactive ? getAllInactiveAddresses() : [];
    this.shadowAddresses = new Set(shadowAddrs);
    const addresses = [...activeAddresses, ...shadowAddrs];

    if (addresses.length === 0) {
      log.warn(`[KOL_TRACKER] no active KOL addresses — tracker idle (DB 확인 필요)`);
      return;
    }
    this.targetAddresses = [...addresses];
    log.info(
      `[KOL_TRACKER] subscribing to ${addresses.length} KOL addresses ` +
      `(active=${activeAddresses.length} shadow=${shadowAddrs.length})`
    );

    for (const addr of addresses) {
      await this.subscribeAddress(addr).catch((err) => {
        log.warn(`[KOL_TRACKER] subscribe ${addr.slice(0, 8)}... failed: ${String(err)}`);
      });
    }
    log.info(`[KOL_TRACKER] started — active subscriptions: ${this.subscriptions.size}`);

    // 2026-04-26 P0 audit fix #1: watchdog — subscription 이 소실되면 자동 재구독.
    // RPC silent disconnect 시 KOL signal 전체가 소멸하는 문제 (audit P0 #1) 의 fail-safe.
    this.startWatchdog();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
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

  // ─── Watchdog (P0 audit fix #1) ───────────────────────
  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      this.runWatchdog().catch((err) =>
        log.warn(`[KOL_TRACKER_WATCHDOG] error: ${String(err)}`)
      );
    }, WATCHDOG_INTERVAL_MS);
    if (this.watchdogTimer.unref) this.watchdogTimer.unref();
  }

  private async runWatchdog(): Promise<void> {
    if (!this.started) return;

    const now = Date.now();
    if (this.subscriptions.size > 0) {
      this.lastNonZeroSubscriptionsMs = now;
      this.fullDisconnectAlerted = false;
    }

    // 2026-04-27 (B-fix): wallets.json hot-reload 가 KolDB in-memory index 만 갱신하고
    // tracker 의 targetAddresses 는 start() 시점에 frozen 되어 있던 한계 해결.
    // 매 watchdog cycle 마다 KolDB 와 active set diff → 새 active 구독 / 제거 active 구독 해제.
    // wallets.json 편집 → ≤5min 자동 반영 (재시작 불필요).
    await this.syncActiveSet();

    // Missing subscriptions 가 있으면 재구독 시도 (cooldown 적용).
    const missing = this.targetAddresses.filter((addr) => !this.subscriptions.has(addr));
    if (missing.length === 0) return;

    if (now - this.lastResubscribeMs < RESUBSCRIBE_COOLDOWN_MS) {
      log.debug(
        `[KOL_TRACKER_WATCHDOG] ${missing.length} missing subs but cooldown active ` +
        `(${Math.round((RESUBSCRIBE_COOLDOWN_MS - (now - this.lastResubscribeMs)) / 1000)}s remaining)`
      );
    } else {
      this.lastResubscribeMs = now;
      log.warn(
        `[KOL_TRACKER_WATCHDOG] detected ${missing.length}/${this.targetAddresses.length} ` +
        `subscriptions lost — attempting resubscribe`
      );
      let recovered = 0;
      for (const addr of missing) {
        try {
          await this.subscribeAddress(addr);
          recovered++;
        } catch (err) {
          log.debug(`[KOL_TRACKER_WATCHDOG] resubscribe ${addr.slice(0, 8)} failed: ${String(err)}`);
        }
      }
      log.info(
        `[KOL_TRACKER_WATCHDOG] resubscribed ${recovered}/${missing.length} — active=${this.subscriptions.size}`
      );
    }

    // Full disconnect (15min 동안 sub 0) → critical alert. emit 한 번만.
    if (
      this.subscriptions.size === 0 &&
      now - this.lastNonZeroSubscriptionsMs >= FULL_DISCONNECT_ALERT_AFTER_MS &&
      !this.fullDisconnectAlerted
    ) {
      this.fullDisconnectAlerted = true;
      this.emit('full_disconnect', {
        targetCount: this.targetAddresses.length,
        elapsedMs: now - this.lastNonZeroSubscriptionsMs,
      });
      log.error(
        `[KOL_TRACKER_FULL_DISCONNECT] all ${this.targetAddresses.length} subs lost ` +
        `for >${Math.round((now - this.lastNonZeroSubscriptionsMs) / 60000)}min — RPC 점검 필요`
      );
    }
  }

  /** 현재 구독 수 (헬스체크용). */
  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  // ─── Active set sync (2026-04-27 B-fix) ───────────────
  /**
   * KolDB 의 현재 active addresses 와 tracker subscriptions 를 diff 해서
   * 새 active 는 구독 시작, 제거된 active 는 구독 해제.
   *
   * Defensive guard: KolDB load 실패로 active set 이 비어 있는데 기존 subs 가 있으면
   * "DB anomaly" 의심 → sync skip (전체 unsub 사고 방지). 다음 cycle 에서 정상 회복 시 재시도.
   *
   * Cooldown 분리: 신규 add/remove 는 missing-sub resub cooldown 무시 (운영자 변경은 즉시 적용).
   */
  private async syncActiveSet(): Promise<void> {
    // 2026-04-27 (QA F1): re-entry guard — runWatchdog 가 cycle 보다 오래 걸려 다음 cycle 가
    // 진입하는 race 차단. targetAddresses 갱신 reorder / 중복 RPC 호출 방어.
    if (this.syncInProgress) {
      log.debug('[KOL_TRACKER_SYNC] previous cycle in progress — skip');
      return;
    }
    this.syncInProgress = true;
    try {
      await this.syncActiveSetInner();
    } finally {
      this.syncInProgress = false;
    }
  }

  private async syncActiveSetInner(): Promise<void> {
    const liveActiveList = getAllActiveAddresses();
    const liveActive = new Set(liveActiveList);
    // Shadow set 도 매 cycle 재계산 — wallets.json 에서 active↔inactive flip 시 routing 자동 갱신.
    const liveShadowList = this.config.shadowTrackInactive ? getAllInactiveAddresses() : [];
    const liveShadow = new Set(liveShadowList);
    // 합산 set: subscribe 결정의 단일 source of truth.
    const liveAll = new Set<string>([...liveActive, ...liveShadow]);

    // Defensive guard: empty DB + existing subs = DB load anomaly 의심.
    if (liveAll.size === 0 && this.subscriptions.size > 0) {
      log.warn(
        `[KOL_TRACKER_SYNC] active set empty but ${this.subscriptions.size} subs exist — ` +
        `DB load anomaly 의심, sync skip (다음 cycle 재시도)`
      );
      return;
    }

    const currentSet = new Set(this.targetAddresses);
    const toAdd = [...liveAll].filter((addr) => !currentSet.has(addr));
    const toRemove = this.targetAddresses.filter((addr) => !liveAll.has(addr));
    // Shadow 분류는 항상 최신 liveShadow 기준으로 갱신 (active↔shadow flip 반영).
    this.shadowAddresses = liveShadow;

    if (toAdd.length === 0 && toRemove.length === 0) return;

    let added = 0;
    let removed = 0;
    for (const addr of toAdd) {
      try {
        await this.subscribeAddress(addr);
        added++;
      } catch (err) {
        log.debug(`[KOL_TRACKER_SYNC] sub ${addr.slice(0, 8)} fail: ${String(err)}`);
      }
    }
    for (const addr of toRemove) {
      const subId = this.subscriptions.get(addr);
      if (subId !== undefined) {
        try {
          await this.config.connection.removeOnLogsListener(subId);
        } catch (err) {
          log.debug(`[KOL_TRACKER_SYNC] unsub ${addr.slice(0, 8)} fail: ${String(err)}`);
        }
        this.subscriptions.delete(addr);
        removed++;
      }
    }

    this.targetAddresses = [...liveAll];
    log.info(
      `[KOL_TRACKER_SYNC] active set updated — added=${added} removed=${removed} ` +
      `total_subs=${this.subscriptions.size} shadow=${this.shadowAddresses.size}`
    );
  }

  // ─── Subscription ─────────────────────────────────────

  private async subscribeAddress(address: string): Promise<void> {
    // 2026-04-26 QA fix D: idempotency guard — 동일 address 가 이미 구독돼 있으면 skip.
    // Why: 정상 flow 에서는 watchdog 의 `missing.filter` 가 막아주지만, 향후 다른 진입점이 생기거나
    // start/watchdog race 시 onLogs 가 새 subId 발급 + Map overwrite → 이전 sub 영구 leak.
    if (this.subscriptions.has(address)) return;
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
    // Shadow path: inactive KOL — kolSignalHandler 호출 금지, jsonl 만 기록.
    // lookupKolByAddress 는 inactive 를 undefined 로 반환하므로 shadow 분기에서는 lookupAnyKolByAddress 사용.
    const isShadow = this.shadowAddresses.has(walletAddress);
    const wallet = isShadow
      ? lookupAnyKolByAddress(walletAddress)
      : lookupKolByAddress(walletAddress);
    if (!wallet) return; // DB 에서 사라짐 (shadow 도 DB 에서 fully 제거되면 무시)

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
      isShadow,  // 2026-04-28: handler 가 active vs inactive 분기 처리하도록 마킹.
    };

    if (isShadow) {
      // 2026-04-28 (Option B): inactive KOL paper trade opt-in.
      // shadowPaperTradeEnabled=true 면 kol_swap 도 emit 하여 kolSignalHandler 가 paper PROBE 진입.
      // isShadow=true flag 로 active 와 분리. 분포 측정 무결성: 별도 ledger 로 dump.
      // false (default) 면 기존 Option A 동작 — kol_shadow_tx 만 emit, paper position 영향 0.
      this.emit('kol_shadow_tx', kolTx);
      await this.appendJsonl(kolTx, /* shadow */ true);
      log.info(
        `[KOL_SHADOW_TX] kol=${wallet.id} tier=${wallet.tier} ${kolTx.action} ` +
        `${swap.tokenMint.slice(0, 8)}... sol=${swap.solAmount?.toFixed(4) ?? '?'} sig=${signature.slice(0, 8)}`
      );
      if (this.config.shadowPaperTradeEnabled) {
        // Inactive 도 kol_swap emit (paper trade trigger). isShadow flag 유지 → handler 분기.
        this.emit('kol_swap', kolTx);
      }
      return;
    }

    // Emit → downstream consumer (Phase 3 kolSignalHandler)
    this.emit('kol_swap', kolTx);

    // Persist
    await this.appendJsonl(kolTx, /* shadow */ false);

    log.info(
      `[KOL_TX] kol=${wallet.id} tier=${wallet.tier} ${kolTx.action} ` +
      `${swap.tokenMint.slice(0, 8)}... sol=${swap.solAmount?.toFixed(4) ?? '?'} sig=${signature.slice(0, 8)}`
    );
  }

  private async appendJsonl(kolTx: KolTx, shadow: boolean): Promise<void> {
    try {
      if (!this.outputDirEnsured) {
        await mkdir(this.config.realtimeDataDir, { recursive: true });
        this.outputDirEnsured = true;
      }
      const fileName = shadow
        ? (this.config.shadowLogFileName ?? 'kol-shadow-tx.jsonl')
        : this.config.logFileName;
      const line = JSON.stringify({ ...kolTx, shadow, recordedAt: new Date().toISOString() }) + '\n';
      await appendFile(
        path.join(this.config.realtimeDataDir, fileName),
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
