import type {
  PureWsBotflowBotProfile,
  PureWsBotflowProvenanceConfidence,
  PureWsBotflowWalletRole,
} from './pureWsBotflowTypes';

export const PURE_WS_BOTFLOW_GYGJ_LEGACY_WALLET = 'Gygj9QQby4j2jryqyqBHvLP7ctv2SaANgh4sCb69BUpA';
export const PURE_WS_BOTFLOW_MAYHEM_CURRENT_AGENT_WALLET = 'BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s';
export const PURE_WS_BOTFLOW_MAYHEM_PROGRAM_ID = 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e';

export interface PureWsBotflowProfileResolution {
  botProfile: PureWsBotflowBotProfile;
  trackedAddress: string;
  feePayerFilter?: string;
  walletRole: PureWsBotflowWalletRole;
  provenanceConfidence: PureWsBotflowProvenanceConfidence;
  mayhemAgentWallet?: string;
  mayhemProgramId?: string;
  notes: string[];
}

export function resolvePureWsBotflowProfile(input: {
  botProfile: PureWsBotflowBotProfile;
  trackedAddress?: string;
  feePayerFilter?: string;
}): PureWsBotflowProfileResolution {
  if (input.botProfile === 'gygj_legacy') {
    const trackedAddress = input.trackedAddress || PURE_WS_BOTFLOW_GYGJ_LEGACY_WALLET;
    return {
      botProfile: input.botProfile,
      trackedAddress,
      feePayerFilter: input.feePayerFilter ?? trackedAddress,
      walletRole: 'legacy_community_sample',
      provenanceConfidence: 'community_claim_unverified',
      notes: [
        'legacy/community-observed bot-flow sample only',
        'not treated as the current official Mayhem agent',
      ],
    };
  }

  if (input.botProfile === 'mayhem_current') {
    return {
      botProfile: input.botProfile,
      trackedAddress: input.trackedAddress || PURE_WS_BOTFLOW_MAYHEM_CURRENT_AGENT_WALLET,
      feePayerFilter: input.feePayerFilter,
      walletRole: 'official_mayhem_agent',
      provenanceConfidence: 'official_current',
      mayhemAgentWallet: PURE_WS_BOTFLOW_MAYHEM_CURRENT_AGENT_WALLET,
      mayhemProgramId: PURE_WS_BOTFLOW_MAYHEM_PROGRAM_ID,
      notes: [
        'official current Mayhem agent context',
        'observer-only; not a copy-trading profile',
      ],
    };
  }

  return {
    botProfile: input.botProfile,
    trackedAddress: input.trackedAddress ?? '',
    feePayerFilter: input.feePayerFilter,
    walletRole: 'custom_research',
    provenanceConfidence: 'user_supplied',
    notes: ['custom research profile'],
  };
}
