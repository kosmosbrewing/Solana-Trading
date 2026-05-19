import {
  buildRotationPromotionBlockedWinnerAuditReport,
  renderRotationPromotionBlockedWinnerAuditReport,
} from '../scripts/rotation-promotion-blocked-winner-audit';

describe('rotation-promotion-blocked-winner-audit', () => {
  it('groups blocked positive bridge rows by normalized block reason', () => {
    const report = buildRotationPromotionBlockedWinnerAuditReport({
      generatedAt: '2026-05-19T00:00:00.000Z',
      sinceHours: 168,
      primaryBridgeRoster: [
        {
          candidateId: 'a',
          decisionId: 'a:yellow:block:wallet_0_7641_yellow_zone_requires_fresh_independentkolcount_=_2',
          exitReason: 'winner_trailing_t1',
          refundAdjustedNetSol: 0.01,
          walletStressSol: 0.008,
        },
        {
          candidateId: 'b',
          decisionId: 'b:yellow:block:wallet_0_7216_yellow_zone_requires_fresh_independentkolcount_=_2',
          exitReason: 'winner_trailing_t1',
          refundAdjustedNetSol: 0.02,
          walletStressSol: 0.018,
        },
      ],
    });
    const md = renderRotationPromotionBlockedWinnerAuditReport(report);

    expect(report.verdict).toBe('CONCENTRATED_BLOCK_REASON');
    expect(report.reasonRows).toHaveLength(1);
    expect(report.reasonRows[0]).toMatchObject({
      rows: 2,
      uniqueCandidates: 2,
      walletStressSol: 0.026,
      topExitReason: 'winner_trailing_t1',
    });
    expect(md).toContain('wallet_*_yellow_zone_requires_fresh_independentkolcount_=_2');
  });

  it('does not count wallet-stress losers as blocked winners', () => {
    const report = buildRotationPromotionBlockedWinnerAuditReport({
      primaryBridgeRoster: [
        {
          candidateId: 'loser',
          decisionId: 'loser:block:wallet_0_7000_yellow_zone_requires_fresh_independentkolcount_=_2',
          walletStressSol: -0.001,
        },
      ],
    });

    expect(report.verdict).toBe('NO_BLOCKED_WINNERS');
    expect(report.positiveWalletRows).toBe(0);
  });
});
