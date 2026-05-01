/**
 * Paper-only dev wallet candidate registry.
 *
 * 후보군은 운영 dev DB(data/dev-wallets/wallets.json)에 승격하기 전 단계의 리서치 원본이다.
 * 이 모듈은 report / paper analysis 전용이며 entry, reject, live gate 에 영향 주지 않는다.
 */
import { readFile } from 'fs/promises';
import path from 'path';

export type DevWalletCandidateLane =
  | 'core'
  | 'event'
  | 'opportunistic'
  | 'bench'
  | 'repeat'
  | 'safe_migration'
  | 'pre_amm'
  | 'discovery'
  | 'lock_watch';

export type DevWalletCandidateRiskClass = 'low' | 'medium' | 'high' | 'unknown';
export type DevWalletCandidateStatus = 'candidate' | 'bench' | 'quarantine' | 'rejected';
export type DevWalletCandidateSourceTier = 'A' | 'B' | 'C';

export interface DevWalletCandidate {
  id: string;
  addresses: string[];
  lane: DevWalletCandidateLane;
  risk_class: DevWalletCandidateRiskClass;
  status: DevWalletCandidateStatus;
  source_tier: DevWalletCandidateSourceTier;
  evidence?: string[];
  metrics?: {
    top10_pct?: number | null;
    dev_share_pct?: number | null;
  };
  notes?: string;
}

export interface DevWalletCandidateFile {
  version: 'candidate-v1' | string;
  paper_only: boolean;
  generated_at: string;
  source_report?: string;
  policy?: Record<string, string>;
  candidates: DevWalletCandidate[];
}

export interface DevWalletCandidateIndex {
  candidates: DevWalletCandidate[];
  byAddress: Map<string, DevWalletCandidate>;
  duplicateAddresses: string[];
}

export const DEFAULT_DEV_WALLET_CANDIDATE_PATH = path.resolve(
  process.cwd(),
  'data/dev-wallets/candidates-2026-05-01.json',
);

export function buildDevWalletCandidateIndex(file: DevWalletCandidateFile): DevWalletCandidateIndex {
  const byAddress = new Map<string, DevWalletCandidate>();
  const duplicateAddresses: string[] = [];
  for (const candidate of file.candidates ?? []) {
    for (const address of candidate.addresses ?? []) {
      if (!address) continue;
      if (byAddress.has(address)) duplicateAddresses.push(address);
      byAddress.set(address, candidate);
    }
  }
  return {
    candidates: file.candidates ?? [],
    byAddress,
    duplicateAddresses,
  };
}

export async function loadDevWalletCandidateIndex(
  filePath: string = DEFAULT_DEV_WALLET_CANDIDATE_PATH,
): Promise<DevWalletCandidateIndex> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as DevWalletCandidateFile;
    if (!parsed || !Array.isArray(parsed.candidates)) {
      throw new Error('invalid candidate schema');
    }
    return buildDevWalletCandidateIndex(parsed);
  } catch {
    return buildDevWalletCandidateIndex({
      version: 'candidate-v1',
      paper_only: true,
      generated_at: '',
      candidates: [],
    });
  }
}

export function lookupDevWalletCandidate(
  address: string | null | undefined,
  index: DevWalletCandidateIndex,
): DevWalletCandidate | undefined {
  if (!address) return undefined;
  return index.byAddress.get(address);
}

function toFlagSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

export function getDevWalletCandidateFlags(candidate: DevWalletCandidate): string[] {
  return [
    'DEV_CANDIDATE_MATCHED',
    `DEV_CANDIDATE_ID_${toFlagSegment(candidate.id)}`,
    `DEV_CANDIDATE_LANE_${toFlagSegment(candidate.lane)}`,
    `DEV_CANDIDATE_RISK_${toFlagSegment(candidate.risk_class)}`,
    `DEV_CANDIDATE_STATUS_${toFlagSegment(candidate.status)}`,
    `DEV_CANDIDATE_SOURCE_${toFlagSegment(candidate.source_tier)}`,
  ];
}

export function getDevWalletCandidateStats(index: DevWalletCandidateIndex): {
  totalCandidates: number;
  addressCount: number;
  duplicateAddressCount: number;
  byLane: Record<string, number>;
  byRiskClass: Record<string, number>;
} {
  const byLane: Record<string, number> = {};
  const byRiskClass: Record<string, number> = {};
  for (const c of index.candidates) {
    byLane[c.lane] = (byLane[c.lane] ?? 0) + 1;
    byRiskClass[c.risk_class] = (byRiskClass[c.risk_class] ?? 0) + 1;
  }
  return {
    totalCandidates: index.candidates.length,
    addressCount: index.byAddress.size,
    duplicateAddressCount: index.duplicateAddresses.length,
    byLane,
    byRiskClass,
  };
}
