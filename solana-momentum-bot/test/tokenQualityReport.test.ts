import { buildDevWalletCandidateIndex, type DevWalletCandidateFile } from '../src/observability/devWalletCandidateRegistry';
import { buildFlagMatrix } from '../scripts/token-quality-report';

const args = {
  windowDays: 7,
  inputDir: 'unused',
  threshold5xMfe: 4.0,
  bigLossThresholdPct: -0.1,
};

describe('token-quality-report dev candidate join', () => {
  it('adds paper-only dev candidate flags from creator/dev wallet fields', () => {
    const candidates: DevWalletCandidateFile = {
      version: 'candidate-v1',
      paper_only: true,
      generated_at: '2026-05-01',
      candidates: [
        {
          id: 'core_dev',
          addresses: ['DEV1'],
          lane: 'core',
          risk_class: 'low',
          status: 'candidate',
          source_tier: 'A',
        },
      ],
    };
    const index = buildDevWalletCandidateIndex(candidates);
    const stats = buildFlagMatrix(
      [{
        schemaVersion: 'token-quality/v1',
        tokenMint: 'MINT1',
        observedAt: '2026-05-01T00:00:00.000Z',
        creatorAddress: 'DEV1',
        riskFlags: [],
        observationContext: {
          positionId: 'pos1',
          isLive: false,
          isShadowArm: false,
        },
      }],
      [{
        positionId: 'pos1',
        tokenMint: 'MINT1',
        closedAt: '2026-05-01T00:01:00.000Z',
        netSol: 0.01,
        netPct: 0.5,
        mfePctPeak: 4.5,
      }],
      [],
      args,
      index,
    );

    const lane = stats.find((s) => s.flag === 'DEV_CANDIDATE_LANE_CORE' && s.cohort === 'paper');
    const risk = stats.find((s) => s.flag === 'DEV_CANDIDATE_RISK_LOW' && s.cohort === 'overall');
    const id = stats.find((s) => s.flag === 'DEV_CANDIDATE_ID_CORE_DEV' && s.cohort === 'paper');

    expect(lane?.n).toBe(1);
    expect(lane?.winners5x).toBe(1);
    expect(risk?.netSol).toBeCloseTo(0.01);
    expect(id?.n).toBe(1);
  });

  it('falls back to NO_FLAGS when no candidate or risk flag matches', () => {
    const index = buildDevWalletCandidateIndex({
      version: 'candidate-v1',
      paper_only: true,
      generated_at: '2026-05-01',
      candidates: [],
    });
    const stats = buildFlagMatrix(
      [{
        tokenMint: 'MINT2',
        observedAt: '2026-05-01T00:00:00.000Z',
        creatorAddress: 'UNKNOWN',
        riskFlags: [],
        observationContext: { positionId: 'pos2', isLive: true, isShadowArm: false },
      }],
      [{ positionId: 'pos2', tokenMint: 'MINT2', netPct: -0.2, netSol: -0.01, mfePctPeak: 0 }],
      [],
      args,
      index,
    );

    expect(stats.find((s) => s.flag === 'NO_FLAGS' && s.cohort === 'live')?.bigLosses).toBe(1);
  });
});
