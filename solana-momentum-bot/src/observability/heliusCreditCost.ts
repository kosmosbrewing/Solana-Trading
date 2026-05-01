/**
 * Helius Credit Cost Catalog (2026-05-01, Stream A).
 *
 * ADR: docs/exec-plans/active/helius-credit-edge-plan-2026-05-01.md §3 / §6 Stream A
 *
 * 목적: Helius API call 의 credit cost 를 method 별로 일원화 — backfill script 와
 *       runtime call site 가 동일 catalog 를 참조해 estimate 가 drift 안 되도록 한다.
 *
 * 정책:
 *   - **Standard RPC** vs **Enhanced API** 명시적 분리 (Codex 보정 1.2)
 *   - `getParsedTransaction` (Standard RPC) = 1 credit / Enhanced Transactions parsing = 100 credits
 *   - WebSocket = 2 credits / 0.1 MB metered (May 1, 2026 활성)
 *   - Sender = 0 credits (execution feature, credit burn 0)
 *
 * 의존: 없음 (pure data + helper). I/O 없음. config 의존 없음 — runtime side 가 받아서 ledger 와 결합.
 *
 * 출처: https://www.helius.dev/docs/billing/credits (2026-05-01 확인)
 */

export type HeliusCreditPurpose =
  | 'live_hot_path'
  | 'kol_tx_enrichment'
  | 'token_quality'
  | 'pool_prewarm'
  | 'markout_backfill'
  | 'wallet_style_backfill'
  | 'execution_telemetry'
  | 'ops_check';

/** API 면. Standard RPC vs Enhanced API 분리 — credit cost 가 다르다. */
export type HeliusApiSurface =
  | 'standard_rpc'
  | 'enhanced_tx'
  | 'das'
  | 'wallet_api'
  | 'priority_fee'
  | 'webhook'
  | 'wss'
  | 'sender'
  | 'staked_connection';

/** 단일 Helius call 의 catalog entry. */
export interface HeliusMethodCost {
  /** API surface — Standard RPC vs Enhanced 등 분류 */
  surface: HeliusApiSurface;
  /** Helius 측 method name (RPC method or REST endpoint) */
  method: string;
  /** call 1회당 credit cost. WSS 는 0.1MB 단위라 별도 unit 필드. */
  creditsPerCall: number;
  /** WSS 만 사용 — bytes 기준 metering */
  wssCreditsPerHundredKb?: number;
  /** Helius docs 에 명시된 인용 (검증용) */
  notes?: string;
}

/**
 * Method → cost 매핑.
 *
 * 추가 시 docs URL 검증 후 entry 보강. 변경 시 catalog version (v1) 도 같이 올린다.
 */
export const HELIUS_COST_CATALOG_VERSION = 'helius-cost-catalog/v1' as const;

const CATALOG: ReadonlyArray<HeliusMethodCost> = [
  // ─── Standard RPC (1 credit) ───
  { surface: 'standard_rpc', method: 'getAccountInfo', creditsPerCall: 1 },
  { surface: 'standard_rpc', method: 'getBalance', creditsPerCall: 1 },
  { surface: 'standard_rpc', method: 'getMultipleAccounts', creditsPerCall: 1 },
  { surface: 'standard_rpc', method: 'getTokenAccountsByOwner', creditsPerCall: 1 },
  { surface: 'standard_rpc', method: 'getTokenLargestAccounts', creditsPerCall: 1 },
  { surface: 'standard_rpc', method: 'getTokenSupply', creditsPerCall: 1 },
  { surface: 'standard_rpc', method: 'getSignatureStatuses', creditsPerCall: 1 },
  { surface: 'standard_rpc', method: 'getSignaturesForAddress', creditsPerCall: 1 },
  // Codex 보정 (1.2): getParsedTransaction 은 Standard RPC = 1 credit (Enhanced 와 별개).
  { surface: 'standard_rpc', method: 'getParsedTransaction', creditsPerCall: 1, notes: 'Standard RPC = 1c (Enhanced parsing 은 100c)' },
  { surface: 'standard_rpc', method: 'getTransaction', creditsPerCall: 1 },
  { surface: 'standard_rpc', method: 'getBlock', creditsPerCall: 1 },
  { surface: 'standard_rpc', method: 'getBlockTime', creditsPerCall: 1 },
  { surface: 'standard_rpc', method: 'getLatestBlockhash', creditsPerCall: 1 },
  { surface: 'standard_rpc', method: 'getSlot', creditsPerCall: 1 },
  { surface: 'standard_rpc', method: 'sendTransaction', creditsPerCall: 1 },
  { surface: 'standard_rpc', method: 'simulateTransaction', creditsPerCall: 1 },

  // ─── Standard RPC, 비싼 sweep (10 credit) ───
  { surface: 'standard_rpc', method: 'getProgramAccounts', creditsPerCall: 10, notes: 'broad sweep — hot path 회피' },

  // ─── Enhanced Transactions (100 credits) ───
  { surface: 'enhanced_tx', method: 'parseTransactions', creditsPerCall: 100, notes: 'Enhanced API parsing — KOL backfill / sample only' },
  { surface: 'enhanced_tx', method: 'parseTransactionHistory', creditsPerCall: 100 },

  // ─── Wallet API (50 credits / call) ───
  { surface: 'wallet_api', method: 'getTransactionsForAddress', creditsPerCall: 50, notes: 'KOL wallet history — bounded budget cap 필수' },

  // ─── DAS API (10 credits) ───
  { surface: 'das', method: 'getAsset', creditsPerCall: 10 },
  { surface: 'das', method: 'getAssetsByOwner', creditsPerCall: 10 },
  { surface: 'das', method: 'getAssetsByGroup', creditsPerCall: 10 },
  { surface: 'das', method: 'searchAssets', creditsPerCall: 10 },

  // ─── Priority Fee API (1 credit) ───
  { surface: 'priority_fee', method: 'getPriorityFeeEstimate', creditsPerCall: 1, notes: 'observe-only telemetry 적합' },

  // ─── Webhook (1 credit per event) ───
  { surface: 'webhook', method: 'webhook_event', creditsPerCall: 1, notes: '안정 address/event delivery 용' },

  // ─── WebSocket (metered, 2 credits / 0.1 MB) ───
  // Note: creditsPerCall 은 0 으로 두고 wssCreditsPerHundredKb 만 사용.
  //       caller (heliusCreditLedger) 가 byte 측정으로 estimateWssCredits() 호출.
  { surface: 'wss', method: 'wss_subscription', creditsPerCall: 0, wssCreditsPerHundredKb: 2, notes: '2026-05-01 활성 metering' },

  // ─── Sender (0 credits, execution feature) ───
  { surface: 'sender', method: 'sender_send', creditsPerCall: 0, notes: 'credit burn 0 — execution path 만' },

  // ─── Staked connections (1 credit) ───
  { surface: 'staked_connection', method: 'staked_send', creditsPerCall: 1 },
];

/**
 * Method → cost lookup. case-sensitive method 이름 일치.
 *
 * 미등록 method 면 undefined 반환 — caller 가 fallback (e.g. 보수적 100c estimate) 결정.
 */
export function getCostByMethod(
  method: string,
  surface?: HeliusApiSurface,
): HeliusMethodCost | undefined {
  return CATALOG.find((c) => {
    if (c.method !== method) return false;
    if (surface && c.surface !== surface) return false;
    return true;
  });
}

/**
 * `getParsedTransaction` 처럼 surface 가 다른 동일 method 에 대해 명시적 lookup.
 * caller 가 어떤 surface 에서 호출하는지 알 때 정확한 cost 확보.
 */
export function getCostByMethodAndSurface(
  method: string,
  surface: HeliusApiSurface,
): HeliusMethodCost | undefined {
  return CATALOG.find((c) => c.method === method && c.surface === surface);
}

/**
 * Standard RPC fallback 보수 estimate — catalog 에 없는 method 의 default.
 * RPC = 1c 가정. Enhanced 가 의심되면 caller 가 명시적 surface 지정해야 한다.
 */
export const DEFAULT_STANDARD_RPC_COST = 1 as const;
export const DEFAULT_ENHANCED_FALLBACK_COST = 100 as const;

export function estimateCostFallback(surface: HeliusApiSurface): number {
  switch (surface) {
    case 'standard_rpc': return DEFAULT_STANDARD_RPC_COST;
    case 'enhanced_tx': return DEFAULT_ENHANCED_FALLBACK_COST;
    case 'das': return 10;
    case 'wallet_api': return 50;
    case 'priority_fee': return 1;
    case 'webhook': return 1;
    case 'wss': return 0; // metered separately by bytes
    case 'sender': return 0;
    case 'staked_connection': return 1;
    default: return DEFAULT_STANDARD_RPC_COST;
  }
}

/**
 * WSS bytes → credits estimate.
 * Helius 정책: 2 credits / 0.1 MB (= 102,400 bytes).
 *
 * ceiling 처리 — 1 byte 이상 0.1 MB 미만이면 2 credits.
 */
export function estimateWssCredits(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  const HUNDRED_KB = 100 * 1024;
  const buckets = Math.ceil(bytes / HUNDRED_KB);
  return buckets * 2;
}

/**
 * 카탈로그 dump (test / ops verification).
 */
export function listCatalog(): ReadonlyArray<HeliusMethodCost> {
  return CATALOG;
}
