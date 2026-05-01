import { mkdir, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  buildDevWalletCandidateIndex,
  getDevWalletCandidateFlags,
  getDevWalletCandidateStats,
  loadDevWalletCandidateIndex,
  lookupDevWalletCandidate,
  type DevWalletCandidateFile,
} from '../src/observability/devWalletCandidateRegistry';

describe('devWalletCandidateRegistry', () => {
  it('loads bundled candidate file as paper-only raw universe', async () => {
    const index = await loadDevWalletCandidateIndex();
    const stats = getDevWalletCandidateStats(index);
    expect(stats.totalCandidates).toBe(94);
    expect(stats.addressCount).toBe(94);
    expect(stats.duplicateAddressCount).toBe(0);
    expect(stats.byLane.core).toBe(7);
    expect(stats.byRiskClass.high).toBe(2);
  });

  it('builds address lookup and candidate flags', () => {
    const file: DevWalletCandidateFile = {
      version: 'candidate-v1',
      paper_only: true,
      generated_at: '2026-05-01',
      candidates: [
        {
          id: 'good_dev',
          addresses: ['ADDR1', 'ADDR2'],
          lane: 'core',
          risk_class: 'low',
          status: 'candidate',
          source_tier: 'A',
        },
      ],
    };
    const index = buildDevWalletCandidateIndex(file);
    const candidate = lookupDevWalletCandidate('ADDR2', index);
    expect(candidate?.id).toBe('good_dev');
    expect(getDevWalletCandidateFlags(candidate!)).toEqual([
      'DEV_CANDIDATE_MATCHED',
      'DEV_CANDIDATE_ID_GOOD_DEV',
      'DEV_CANDIDATE_LANE_CORE',
      'DEV_CANDIDATE_RISK_LOW',
      'DEV_CANDIDATE_STATUS_CANDIDATE',
      'DEV_CANDIDATE_SOURCE_A',
    ]);
  });

  it('duplicate addresses are surfaced for quality checks', () => {
    const file: DevWalletCandidateFile = {
      version: 'candidate-v1',
      paper_only: true,
      generated_at: '2026-05-01',
      candidates: [
        { id: 'a', addresses: ['DUP'], lane: 'bench', risk_class: 'unknown', status: 'bench', source_tier: 'C' },
        { id: 'b', addresses: ['DUP'], lane: 'event', risk_class: 'high', status: 'candidate', source_tier: 'B' },
      ],
    };
    const index = buildDevWalletCandidateIndex(file);
    expect(index.duplicateAddresses).toEqual(['DUP']);
    expect(lookupDevWalletCandidate('DUP', index)?.id).toBe('b');
  });

  it('missing or damaged file fails open to empty candidate index', async () => {
    const tmpDir = path.join(os.tmpdir(), `dev-candidate-${Date.now()}-${Math.random()}`);
    await mkdir(tmpDir, { recursive: true });
    const badPath = path.join(tmpDir, 'bad.json');
    await writeFile(badPath, '{ bad', 'utf8');

    const missing = await loadDevWalletCandidateIndex(path.join(tmpDir, 'missing.json'));
    const damaged = await loadDevWalletCandidateIndex(badPath);

    expect(getDevWalletCandidateStats(missing).totalCandidates).toBe(0);
    expect(getDevWalletCandidateStats(damaged).addressCount).toBe(0);
  });
});
