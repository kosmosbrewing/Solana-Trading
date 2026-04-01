export const METEORA_DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
export const METEORA_DAMM_V2_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
export const METEORA_DAMM_V1_PROGRAM = 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB';

export const METEORA_DEX_IDS = [
  'meteora',
  'meteora-dlmm',
  'meteora-damm',
  'meteora-damm-v1',
  'meteora-damm-v2',
  'meteoradbc',
  'dlmm',
  'damm-v1',
  'damm-v2',
] as const;

export function isMeteoraDexId(dexId?: string | null): boolean {
  if (!dexId) return false;
  return METEORA_DEX_IDS.includes(dexId.toLowerCase() as typeof METEORA_DEX_IDS[number]);
}
