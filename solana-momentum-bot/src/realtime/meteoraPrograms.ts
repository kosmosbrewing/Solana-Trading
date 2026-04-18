export const METEORA_DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
export const METEORA_DAMM_V2_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
export const METEORA_DAMM_V1_PROGRAM = 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB';

// Block 2 (2026-04-18): coverage expansion — 같은 3 Meteora 프로그램 (DLMM / DAMM v1 / DAMM v2)
// 를 가리키는 DexScreener 태그 변형을 모두 포함한다.
// 2026-04-18 Block 2 QA fix: overly-generic alias (`damm`) 는 제거 — 다른 DEX 의 AMM 태그와 충돌 위험.
// `dlmm` 은 Meteora 외 다른 DEX 에도 흔히 쓰이므로 잠정 유지하되, 실 운영 데이터로 재검토 필요.
export const METEORA_DEX_IDS = [
  'meteora',
  'meteora-dlmm',
  'meteora-damm',
  'meteora-damm-v1',
  'meteora-damm-v2',
  'meteoradbc',
  'meteora-dbc',
  'meteora_dlmm',
  'meteora_damm',
  'meteora-dynamic',
  'dlmm',
  'damm-v1',
  'damm-v2',
  'damm_v1',
  'damm_v2',
] as const;

export function isMeteoraDexId(dexId?: string | null): boolean {
  if (!dexId) return false;
  return METEORA_DEX_IDS.includes(dexId.toLowerCase() as typeof METEORA_DEX_IDS[number]);
}
