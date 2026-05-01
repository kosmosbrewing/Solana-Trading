/**
 * Holder Distribution analyzer (2026-05-01, Decu Quality Layer Phase B.2).
 *
 * Why: 기존 securityGate 는 top10 한 가지 임계만 사용. ADR §4.2 권고 — top1/top5/top10 +
 *      HHI (Herfindahl-Hirschman Index) 로 holder concentration 정밀 측정.
 *
 * 입력: getTokenLargestAccounts() 결과 (이미 securityGate 가 호출 중) — RPC 신규 호출 0.
 * 출력: 4 metric + 5 risk flag.
 *
 * HHI 정의: Σ(holderShare_i)^2  (range 0~1, 1 = 100% 집중)
 *   - HHI > 0.25 = "highly concentrated" (전통 antitrust 정의 변형, normalized)
 *   - HHI > 0.5  = 매우 위험 (1-2 holder 가 절반 보유)
 *
 * 2026-05-01 (codex F-B fix): 분모는 **totalSupply** 가 정답. 이전엔 sample 합계 (sum of returned
 *   largestAccounts) 를 분모로 사용 → top10 이 supply 의 10% 에 불과해도 sample 안에서 100% 면
 *   `top10HolderPct=1.0` 으로 잘못 산출 → false `HOLDER_TOP10_HIGH` flag → cohort/gate 오판.
 *   `getTokenLargestAccounts` 는 mint 당 최대 20 account 만 반환하므로 sample-기준 비율은 본질적으로
 *   잘못된 측정. `onchainSecurity.computeTop10HolderPct(supply, accounts)` 와 동일 정합 유지.
 */

export interface LargestAccountEntry {
  /** 보유 amount (raw 또는 normalized) — 비율 산출 시 sum 으로 normalize */
  amount: number;
  /** holder address (top holder overlap 계산용) */
  address?: string;
}

export interface HolderDistributionMetrics {
  top1HolderPct?: number;
  top5HolderPct?: number;
  top10HolderPct?: number;
  /** Σ(share_i)^2, range 0~1. 1 = 단일 holder 가 전부 보유. */
  holderHhi?: number;
  /** 데이터 수집된 holder 개수 (top N 만 — 전체 holder 수 아님) */
  holderCountApprox?: number;
  /** 산출에 사용된 raw account 수 (debugging) */
  sampleSize: number;
  /**
   * true 면 totalSupply 미제공으로 sample 합계 분모 fallback 사용 — false flag 위험.
   *   caller 는 totalSupply 를 항상 전달하는 것이 정답 (codex F-B fix).
   */
  sampleBased?: boolean;
}

export interface HolderRiskThresholds {
  /** HOLDER_TOP1_HIGH 임계 (default 0.20 = 20%) */
  top1HighPct: number;
  /** HOLDER_TOP5_HIGH 임계 (default 0.50 = 50%) */
  top5HighPct: number;
  /** HOLDER_TOP10_HIGH 임계 (default 0.80 = 80%) — securityGate 와 동일 */
  top10HighPct: number;
  /** HOLDER_HHI_HIGH 임계 (default 0.25) */
  hhiHighThreshold: number;
}

export const DEFAULT_HOLDER_THRESHOLDS: HolderRiskThresholds = {
  top1HighPct: 0.20,
  top5HighPct: 0.50,
  top10HighPct: 0.80,
  hhiHighThreshold: 0.25,
};

/**
 * 정렬되지 않은 holder list + totalSupply 를 받아 top1/top5/top10 + HHI 계산.
 *
 * @param accounts top largest accounts (RPC 결과)
 * @param totalSupply 토큰 전체 supply (raw amount 단위 — accounts.amount 와 동일 단위 필수).
 *                    주어지지 않으면 sample 합계 fallback (legacy behavior, 결과에 sampleBased=true 마커).
 *                    fallback 은 정확도 떨어지므로 caller 가 supply 전달 권장.
 *
 * 2026-05-01 (codex F-B fix): supply 분모로 교체. 이전 sample-합계 분모는 RPC 가 반환하는
 *   상위 N (보통 20) 개에 한정된 비율을 산출 → false HOLDER_TOP*_HIGH flag 다발.
 */
export function computeHolderDistribution(
  accounts: LargestAccountEntry[],
  totalSupply?: number,
): HolderDistributionMetrics {
  if (!accounts || accounts.length === 0) {
    return { sampleSize: 0 };
  }
  // 큰 holder 부터 정렬 (caller 가 이미 정렬해도 멱등 — 안전 보장)
  const sorted = [...accounts].sort((a, b) => b.amount - a.amount);
  const sampleSum = sorted.reduce((s, a) => s + a.amount, 0);
  // 분모 결정: totalSupply 우선, 없거나 0 이하면 sample 합계 fallback (legacy 호환).
  //   sampleBased=true 로 caller 에 정확도 한계 표시. supply > 0 일 때만 정상 모드.
  const useSupply = typeof totalSupply === 'number' && Number.isFinite(totalSupply) && totalSupply > 0;
  const denominator = useSupply ? totalSupply : sampleSum;
  if (denominator <= 0) {
    return { sampleSize: sorted.length };
  }
  const shares = sorted.map((a) => a.amount / denominator);
  const top1 = shares[0] ?? 0;
  const top5 = shares.slice(0, 5).reduce((s, x) => s + x, 0);
  const top10 = shares.slice(0, 10).reduce((s, x) => s + x, 0);
  // HHI 는 항상 sample 합계 기준 share 로 산출 (sample 안에서의 분포 집중도).
  //   supply 기준으로 계산하면 sample 외 dust holder 의 효과를 0 으로 가정한 lower bound 가 됨.
  //   convention: HHI = Σ(s_i)^2 where s_i = share within sample → 기존 의미 보존.
  const sampleShares = sampleSum > 0 ? sorted.map((a) => a.amount / sampleSum) : sorted.map(() => 0);
  const hhi = sampleShares.reduce((s, x) => s + x * x, 0);
  return {
    top1HolderPct: top1,
    top5HolderPct: top5,
    top10HolderPct: top10,
    holderHhi: hhi,
    holderCountApprox: sorted.length,
    sampleSize: sorted.length,
    sampleBased: !useSupply,
  };
}

/** Risk flag 산출 — 4 metric × threshold 비교. */
export function computeHolderRiskFlags(
  metrics: HolderDistributionMetrics,
  thresholds: HolderRiskThresholds = DEFAULT_HOLDER_THRESHOLDS,
): string[] {
  const flags: string[] = [];
  if (metrics.top1HolderPct != null && metrics.top1HolderPct > thresholds.top1HighPct) {
    flags.push('HOLDER_TOP1_HIGH');
  }
  if (metrics.top5HolderPct != null && metrics.top5HolderPct > thresholds.top5HighPct) {
    flags.push('HOLDER_TOP5_HIGH');
  }
  if (metrics.top10HolderPct != null && metrics.top10HolderPct > thresholds.top10HighPct) {
    flags.push('HOLDER_TOP10_HIGH');
  }
  if (metrics.holderHhi != null && metrics.holderHhi > thresholds.hhiHighThreshold) {
    flags.push('HOLDER_HHI_HIGH');
  }
  return flags;
}

/**
 * Dev wallet / LP pool 가 top holder 에 포함되는지 검증.
 * @returns 추가 risk flag list (DEV_IN_TOP_HOLDER, LP_OR_POOL_IN_TOP_HOLDER)
 */
export function detectTopHolderOverlap(
  accounts: LargestAccountEntry[],
  options: {
    devAddresses?: Set<string>;
    poolAddresses?: Set<string>;
    /** top N 까지 검사 (default 10) */
    topN?: number;
  } = {},
): string[] {
  const flags: string[] = [];
  const n = options.topN ?? 10;
  const top = [...accounts].sort((a, b) => b.amount - a.amount).slice(0, n);
  if (options.devAddresses && options.devAddresses.size > 0) {
    if (top.some((a) => a.address && options.devAddresses!.has(a.address))) {
      flags.push('DEV_IN_TOP_HOLDER');
    }
  }
  if (options.poolAddresses && options.poolAddresses.size > 0) {
    if (top.some((a) => a.address && options.poolAddresses!.has(a.address))) {
      flags.push('LP_OR_POOL_IN_TOP_HOLDER');
    }
  }
  return flags;
}
