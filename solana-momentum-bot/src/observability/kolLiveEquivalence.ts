import { appendFile, mkdir } from 'fs/promises';
import path from 'path';

export const KOL_LIVE_EQUIVALENCE_SCHEMA_VERSION = 'kol-live-equivalence/v1' as const;
export const KOL_LIVE_EQUIVALENCE_FILE = 'kol-live-equivalence.jsonl' as const;

export type KolLiveEquivalenceDecisionStage =
  | 'paper_only'
  | 'same_mint_live_guard'
  | 'rotation_live_disabled'
  | 'hard_trading_halt'
  | 'wallet_stop'
  | 'entry_halt'
  | 'live_execution_quality_cooldown'
  | 'yellow_zone'
  | 'rotation_underfill_live_fallback'
  | 'smart_v3_live_fallback'
  | 'pre_execution_live_allowed'
  | 'live_fresh_reference_reject'
  | 'live_gate_not_entered'
  | 'default_paper';

export interface KolLiveEquivalenceParticipant {
  id: string;
  tier: string;
  timestamp: number;
}

export interface KolLiveEquivalenceRow {
  schemaVersion: typeof KOL_LIVE_EQUIVALENCE_SCHEMA_VERSION;
  generatedAt: string;
  candidateId: string;
  tokenMint: string;
  entrySignalLabel: string;
  armName: string;
  profileArm?: string;
  entryArm?: string;
  exitArm?: string;
  parameterVersion: string;
  entryReason: string;
  convictionLevel: string;
  paperWouldEnter: boolean;
  liveWouldEnter: boolean;
  liveAttempted: boolean;
  decisionStage: KolLiveEquivalenceDecisionStage;
  liveBlockReason: string | null;
  liveBlockFlags: string[];
  paperOnlyReason: string | null;
  isShadowKol: boolean;
  isLiveCanaryActive: boolean;
  hasBotContext: boolean;
  independentKolCount: number;
  effectiveIndependentKolCount: number;
  kolScore: number;
  participatingKols: KolLiveEquivalenceParticipant[];
  survivalFlags: string[];
  sameMintLiveActive?: boolean;
  hardTradingHaltReason?: string | null;
  liveExecutionQualityReason?: string | null;
  liveExecutionQualityRemainingMs?: number | null;
  source: 'runtime';
}

export async function appendKolLiveEquivalence(
  row: KolLiveEquivalenceRow,
  options: { realtimeDir: string } | { outputFile: string }
): Promise<void> {
  const outputFile =
    'outputFile' in options
      ? options.outputFile
      : path.join(options.realtimeDir, KOL_LIVE_EQUIVALENCE_FILE);
  await mkdir(path.dirname(outputFile), { recursive: true });
  await appendFile(outputFile, JSON.stringify(row) + '\n', 'utf8');
}
