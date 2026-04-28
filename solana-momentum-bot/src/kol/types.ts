/**
 * KOL Discovery types (Option 5, 2026-04-23)
 *
 * ADR: docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md
 * KOL Wallet Activity 를 1st-class Discovery trigger 로 격상. Scanner 우회.
 */

export type KolTier = 'S' | 'A' | 'B';

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
}

export interface KolDbFile {
  version: number;
  last_updated: string;
  kols: KolWallet[];
}

export type KolAction = 'buy' | 'sell';

/**
 * KOL 이 발행한 swap tx 이벤트 — Discovery trigger 의 primary input.
 * anti-correlation / scoring / logging 전 단계.
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
}

/**
 * Discovery trigger score — Gate 가산이 아니라 진입 자체의 "confidence" 로만 사용.
 * Gate 통과는 기존 pipeline (survival / drift / sell probe) 만으로 결정.
 */
export interface KolDiscoveryScore {
  tokenMint: string;
  /** anti-correlation 통과 후 독립 판단으로 간주된 KOL 수 */
  independentKolCount: number;
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
