/**
 * poolPrewarmContext tests (2026-05-01, Helius Stream D).
 */

import {
  checkPoolPrewarm,
  classifyAdmissionReason,
} from '../src/observability/poolPrewarmContext';
import type { PoolPrewarmContext } from '../src/observability/poolPrewarmContext';
import { HeliusPoolRegistry } from '../src/scanner/heliusPoolRegistry';
import type { DexScreenerPair } from '../src/scanner/dexScreenerClient';

function makePair(opts: {
  pairAddress: string;
  baseAddress: string;
  quoteAddress: string;
  dexId: string;
  liquidityUsd?: number;
}): DexScreenerPair {
  return {
    chainId: 'solana',
    dexId: opts.dexId,
    pairAddress: opts.pairAddress,
    baseToken: { address: opts.baseAddress, name: '', symbol: '' },
    quoteToken: { address: opts.quoteAddress, name: '', symbol: '' },
    priceUsd: 1,
    liquidity: { usd: opts.liquidityUsd ?? 1000, base: 0, quote: 0 },
    volume: { h24: 100 },
    priceChange: {},
    txns: { h24: { buys: 1, sells: 1 } },
  };
}

describe('checkPoolPrewarm — pool registry lookup (Stream D)', () => {
  const TOKEN = 'TestMint11111111111111111111111111111111111';
  const SOL = 'So11111111111111111111111111111111111111112';

  describe('cohort 분기 (사전 차단)', () => {
    it('shadow KOL → prewarm skip + reason=shadow_kol', async () => {
      const reg = new HeliusPoolRegistry();
      const ctx = await checkPoolPrewarm(reg, TOKEN, { isShadowKol: true });
      expect(ctx.candidateCohort).toBe('kol_shadow');
      expect(ctx.prewarmAttempted).toBe(false);
      expect(ctx.prewarmSkipReason).toBe('shadow_kol');
    });

    it('capacity 초과 → reason=capacity', async () => {
      const reg = new HeliusPoolRegistry();
      const ctx = await checkPoolPrewarm(reg, TOKEN, { capacityExceeded: true });
      expect(ctx.prewarmSkipReason).toBe('capacity');
      expect(ctx.prewarmAttempted).toBe(false);
    });

    it('cooldown → reason=cooldown', async () => {
      const reg = new HeliusPoolRegistry();
      const ctx = await checkPoolPrewarm(reg, TOKEN, { onCooldown: true });
      expect(ctx.prewarmSkipReason).toBe('cooldown');
    });
  });

  describe('registry lookup', () => {
    it('registry hit + supported dex (pumpswap) → prewarmSuccess=true', async () => {
      const reg = new HeliusPoolRegistry();
      reg.upsertPair(makePair({
        pairAddress: 'PoolXYZ',
        baseAddress: TOKEN,
        quoteAddress: SOL,
        dexId: 'pumpswap',
      }));
      const ctx = await checkPoolPrewarm(reg, TOKEN);
      expect(ctx.poolRegistryHit).toBe(true);
      expect(ctx.knownPoolCount).toBe(1);
      expect(ctx.primaryPool).toBe('PoolXYZ');
      expect(ctx.primaryDexId).toBe('pumpswap');
      expect(ctx.prewarmSuccess).toBe(true);
      expect(ctx.prewarmSkipReason).toBeUndefined();
    });

    it('registry miss → prewarmSkipReason=no_pair', async () => {
      const reg = new HeliusPoolRegistry();
      const ctx = await checkPoolPrewarm(reg, TOKEN);
      expect(ctx.poolRegistryHit).toBe(false);
      expect(ctx.prewarmAttempted).toBe(true);
      expect(ctx.prewarmSuccess).toBe(false);
      expect(ctx.prewarmSkipReason).toBe('no_pair');
    });

    it('unsupported dex (foobar_dex) → prewarmSkipReason=unsupported_dex', async () => {
      const reg = new HeliusPoolRegistry();
      reg.upsertPair(makePair({
        pairAddress: 'PoolFoo',
        baseAddress: TOKEN,
        quoteAddress: SOL,
        dexId: 'foobar_dex',
      }));
      const ctx = await checkPoolPrewarm(reg, TOKEN);
      expect(ctx.poolRegistryHit).toBe(true);
      expect(ctx.prewarmSuccess).toBe(false);
      expect(ctx.prewarmSkipReason).toBe('unsupported_dex');
    });

    it('multiple pools → primary 는 highest liquidity', async () => {
      const reg = new HeliusPoolRegistry();
      reg.upsertPair(makePair({
        pairAddress: 'PoolLow',
        baseAddress: TOKEN,
        quoteAddress: SOL,
        dexId: 'raydium',
        liquidityUsd: 100,
      }));
      reg.upsertPair(makePair({
        pairAddress: 'PoolHigh',
        baseAddress: TOKEN,
        quoteAddress: SOL,
        dexId: 'raydium',
        liquidityUsd: 10000,
      }));
      const ctx = await checkPoolPrewarm(reg, TOKEN);
      expect(ctx.knownPoolCount).toBe(2);
      expect(ctx.primaryPool).toBe('PoolHigh');
    });
  });

  describe('classifyAdmissionReason', () => {
    it.each([
      ['admitted', { prewarmSuccess: true } as Partial<PoolPrewarmContext>],
      ['no_pair', { prewarmSuccess: false, prewarmSkipReason: 'no_pair' } as Partial<PoolPrewarmContext>],
      ['unsupported_dex', { prewarmSuccess: false, prewarmSkipReason: 'unsupported_dex' } as Partial<PoolPrewarmContext>],
      ['capacity', { prewarmSuccess: false, prewarmSkipReason: 'capacity' } as Partial<PoolPrewarmContext>],
      ['pool_prewarm_miss', { prewarmSuccess: false, prewarmSkipReason: 'cooldown' } as Partial<PoolPrewarmContext>],
    ])('reason=%s', (expected, ctx) => {
      expect(classifyAdmissionReason(ctx as PoolPrewarmContext)).toBe(expected);
    });
  });
});
