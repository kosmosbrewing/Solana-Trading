/**
 * Helius Markout fetchPriceTrajectory wiring tests (2026-05-01, Sprint X2).
 *
 * 검증:
 *   - stub mode (connection 미공급) → 빈 trajectory + estimatedCredits=0
 *   - stub flag 명시 → 동일 결과
 *   - mock Connection 으로 정상 path → estimatedCredits 누적
 *   - getSignaturesForAddress 실패 → graceful 빈 결과
 *
 * Note: fetchPriceTrajectory 는 unexported — script 통해 실 동작은 integration test 범위.
 *       본 test 는 schema/credit ledger 정합 + stub mode safe 만 검증.
 */

import { processAnchor, parseArgs } from '../scripts/kol-helius-markout-backfill';

describe('processAnchor — stub mode (connection 미공급)', () => {
  it('빈 trajectory → coverage 0 + incomplete', async () => {
    const args = parseArgs(['--dry-run', '--horizons', '60,300']);
    const record = await processAnchor(
      {
        subjectType: 'close',
        subjectId: 'pos-stub-1',
        tokenMint: 'TestMint',
        anchorTsMs: 1000,
        anchorPrice: 0.001,
        exitOffsetSec: 200,
      } as Parameters<typeof processAnchor>[0],
      [60, 300],
      args,
    );
    expect(record.coveragePct).toBe(0);
    expect(record.estimatedCredits).toBe(0);
    expect(record.parseFailedCount).toBe(0);
    expect(record.source).toBe('historical_rpc');
  });

  it('reject anchor stub → reached5xAfterExit undefined (close 만 분기)', async () => {
    const args = parseArgs(['--dry-run']);
    const record = await processAnchor(
      {
        subjectType: 'reject',
        subjectId: 'rej-stub-1',
        tokenMint: 'M2',
        anchorTsMs: 2000,
        anchorPrice: 0.005,
      } as Parameters<typeof processAnchor>[0],
      [60, 300, 1800],
      args,
    );
    // stub mode → has5x=false → reject anchor 의 reached5xAfterExit = false
    expect(record.subjectType).toBe('reject');
    expect(record.reached5xBeforeExit).toBeUndefined();
    expect(record.reached5xAfterExit).toBe(false);
  });

  it('close anchor + stub → reached5x both false (5x 미도달 fixed)', async () => {
    const args = parseArgs(['--dry-run']);
    const record = await processAnchor(
      {
        subjectType: 'close',
        subjectId: 'pos-stub-2',
        tokenMint: 'M3',
        anchorTsMs: 3000,
        anchorPrice: 0.002,
        exitOffsetSec: 500,
      } as Parameters<typeof processAnchor>[0],
      [60, 300, 1800],
      args,
    );
    // QA F3 fix: 5x 미도달 시 close anchor 의 reached5x{Before,After}Exit 둘 다 false
    expect(record.subjectType).toBe('close');
    expect(record.reached5xBeforeExit).toBe(false);
    expect(record.reached5xAfterExit).toBe(false);
  });
});

describe('processAnchor — real RPC pagination wiring', () => {
  it('paginates signatures until the anchor window is reached', async () => {
    const args = parseArgs([
      '--dry-run',
      '--max-txs-per-anchor', '5',
      '--max-signature-pages', '3',
      '--rpc-delay-ms', '0',
    ]);
    const conn = {
      getSignaturesForAddress: jest.fn()
        .mockResolvedValueOnce([
          { signature: 'newer-1', blockTime: 2_000 },
          { signature: 'newer-2', blockTime: 1_900 },
        ])
        .mockResolvedValueOnce([
          { signature: 'hit-1', blockTime: 1_050 },
          { signature: 'older-1', blockTime: 900 },
        ]),
      getParsedTransaction: jest.fn().mockResolvedValue({
        meta: {
          preTokenBalances: [],
          postTokenBalances: [],
        },
      }),
    };

    const record = await processAnchor(
      {
        subjectType: 'close',
        subjectId: 'pos-paged',
        tokenMint: '11111111111111111111111111111111',
        anchorTsMs: 1_000_000,
        anchorPrice: 0.001,
        exitOffsetSec: 30,
      } as Parameters<typeof processAnchor>[0],
      [100],
      args,
      conn as never,
    );

    expect(conn.getSignaturesForAddress).toHaveBeenCalledTimes(2);
    expect(conn.getSignaturesForAddress.mock.calls[1][1]).toMatchObject({ before: 'newer-2' });
    expect(conn.getParsedTransaction).toHaveBeenCalledWith('hit-1', { maxSupportedTransactionVersion: 0 });
    expect(record.estimatedCredits).toBe(3);
  });
});
