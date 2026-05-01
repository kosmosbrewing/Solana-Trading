/**
 * KOL Discovery types (Option 5, 2026-04-23)
 *
 * ADR: docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md
 * KOL Wallet Activity 를 1st-class Discovery trigger 로 격상. Scanner 우회.
 */

export type KolTier = 'S' | 'A' | 'B';

/**
 * 2026-04-28 (Phase 0B/1): KOL 의 follower-perspective 스타일 분류.
 * Why: 외부 피드백 — kev (5분 flip scalper) 의 sell 신호로 bflg (13일 hold copy_core) thesis
 *   까지 청산하는 mismatch 차단. style-weighted exit 정책의 입력.
 *
 * Decision tree:
 *   - copy_core: 일관된 PnL + low/mid 빈도 + follower 체결 가능한 size + long hold (≥1 day avg).
 *                직접 카피 대상. sell 신호로 우리도 close.
 *   - discovery_canary: 빠른 진입 + scalp 패턴 (≤1h avg hold). 작은 ticket 으로만 사용.
 *                      sell 신호는 confidence 하향만 (close 안 함).
 *   - observer: 시장 감시용. trigger 안 줌.
 *   - unknown: 미분류. 보수적 fallback (현재 default behavior 유지).
 */
export type KolLaneRole = 'copy_core' | 'discovery_canary' | 'observer' | 'unknown';

/**
 * Trading style — lane_role 의 보조 dimension. lane_role 만으로 분기 안 되는 edge case
 * (예: copy_core 인데 swing 인지 longhold 인지) 를 처리.
 */
export type KolTradingStyle = 'longhold' | 'swing' | 'scalper' | 'unknown';

export interface KolWallet {
  /** 인물 식별자 (lowercase, unique). 예: 'pain', 'dunpa' */
  id: string;
  /** 해당 인물의 모든 지갑 주소 (본지갑/부지갑/벡터지갑 등) */
  addresses: string[];
  tier: KolTier;
  added_at: string;        // ISO date
  last_verified_at: string; // ISO date
  notes: string;
  is_active: boolean;
  /** 월간 재검증 결과 (optional) */
  recent_30d_pnl_sol?: number;
  recent_30d_5x_count?: number;
  /**
   * 2026-04-28 (Phase 0B): Follower-perspective lane 분류.
   * 미설정 시 'unknown' fallback — handler 가 보수적 분기 (현재 default behavior 유지).
   */
  lane_role?: KolLaneRole;
  /** 2026-04-28 (Phase 0B): trading style. 미설정 시 'unknown'. */
  trading_style?: KolTradingStyle;
  /** 2026-04-28 (Phase 0B): 평균 hold 시간 (일 단위, observation 기반). */
  avg_hold_days?: number;
  /** 2026-04-28 (Phase 0B): 평균 ticket size (SOL). follower 가 체결 가능한 size 평가용. */
  avg_ticket_sol?: number;
}

export interface KolDbFile {
  version: number;
  last_updated: string;
  kols: KolWallet[];
}

export type KolAction = 'buy' | 'sell';

/**
 * 2026-05-01 (Helius Stream C): KolTx parse source 분류.
 *   - `standard_rpc`: Solana web3.js 의 getParsedTransaction Standard RPC parse 결과
 *   - `enhanced_tx`: Helius Enhanced Transactions API parse 결과 (100c, sample/backfill 만)
 *   - `heuristic`: SOL delta 추정 (현 fallback) — 가장 약한 evidence
 */
export type KolTxParseSource = 'standard_rpc' | 'enhanced_tx' | 'heuristic';

/**
 * 2026-05-01 (Helius Stream C): swap route 분류 — direct pool vs aggregator.
 */
export type KolTxRouteKind = 'direct_pool' | 'aggregator' | 'unknown';

/**
 * KOL 이 발행한 swap tx 이벤트 — Discovery trigger 의 primary input.
 * anti-correlation / scoring / logging 전 단계.
 *
 * 2026-05-01 (Helius Stream C): slot/dex/pool/token amount/fee/parseSource 신규 11 필드 추가.
 *   모두 optional + backward-compatible — old row reader 영향 0.
 *   ADR: docs/exec-plans/active/helius-credit-edge-plan-2026-05-01.md §6 Stream C
 */
export interface KolTx {
  kolId: string;
  walletAddress: string;
  tier: KolTier;
  tokenMint: string;
  action: KolAction;
  /** epoch ms */
  timestamp: number;
  /** tx signature */
  txSignature: string;
  /** SOL amount (buy: SOL spent, sell: SOL received). Approximate. */
  solAmount?: number;
  /**
   * 2026-04-28: inactive KOL (shadow) tx 여부. true 면 paper-only 별도 ledger 로 격리.
   * 분포 측정 무결성 — active 의 paper trade 결과와 섞이지 않도록 handler 가 분기 처리.
   */
  isShadow?: boolean;

  // ─── 2026-05-01 (Helius Stream C) — provenance / route enrichment ───
  /** Slot from WebSocket log context — KolWalletTracker 가 onLogs callback ctx.slot 에서 보존 */
  slot?: number;
  /** Block time (epoch seconds) — getParsedTransaction 의 blockTime */
  blockTime?: number;
  /** Pool address (direct_pool route 시) */
  poolAddress?: string;
  /** DEX 식별자 (e.g. 'pumpswap', 'raydium', 'meteora', 'orca') */
  dexId?: string;
  /** Program ID (parsed transaction 의 instruction program) */
  dexProgram?: string;
  /** swap input mint (e.g. SOL = So11111111... or USDC) */
  inputMint?: string;
  /** swap output mint */
  outputMint?: string;
  /** token amount (raw 또는 normalized — caller 가 결정) */
  tokenAmount?: number;
  /** transaction fee (lamports) */
  feeLamports?: number;
  /** priority fee paid (lamports) — execution copyability 측정 input */
  priorityFeeLamports?: number;
  /** parse 출처 — heuristic = 가장 약함 (SOL delta 추정만) */
  parseSource?: KolTxParseSource;
  /** route 종류 — direct pool vs Jupiter aggregator */
  routeKind?: KolTxRouteKind;
}

/**
 * Discovery trigger score — Gate 가산이 아니라 진입 자체의 "confidence" 로만 사용.
 * Gate 통과는 기존 pipeline (survival / drift / sell probe) 만으로 결정.
 */
export interface KolDiscoveryScore {
  tokenMint: string;
  /** anti-correlation 통과 후 독립 판단으로 간주된 KOL 수 (backward compat) */
  independentKolCount: number;
  /**
   * 2026-04-29: co-buy graph community 기반 effective independent count.
   * Σ (1 / community_size). 모두 같은 community → 1.0, 모두 독립 → independentKolCount 와 동일.
   * Graph 미공급 시 independentKolCount 와 동일.
   */
  effectiveIndependentCount: number;
  /** 참여 KOL (이름 + tier) */
  participatingKols: Array<{ id: string; tier: KolTier; timestamp: number }>;
  /** tier 가중치 합 (S=3 / A=1 / B=0.5) */
  weightedScore: number;
  /** 합의 보너스 */
  consensusBonus: number;
  /** 시간 감쇠 factor (0..1) */
  timeDecay: number;
  /** 최종 score */
  finalScore: number;
  /** 첫 KOL 진입 epoch ms */
  firstEntryMs: number;
}
