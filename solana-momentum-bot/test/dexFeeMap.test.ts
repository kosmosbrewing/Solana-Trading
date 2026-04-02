import { resolveAmmFeePct } from '../src/utils/dexFeeMap';

describe('resolveAmmFeePct', () => {
  // ─── dexId lookup ───
  it('returns 0.25% for raydium', () => {
    expect(resolveAmmFeePct('raydium')).toBe(0.0025);
  });

  it('returns 0.25% for pumpswap', () => {
    expect(resolveAmmFeePct('pumpswap')).toBe(0.0025);
  });

  it('returns 0.30% for meteora-dlmm', () => {
    expect(resolveAmmFeePct('meteora-dlmm')).toBe(0.003);
  });

  it('returns 0.30% for orca', () => {
    expect(resolveAmmFeePct('orca')).toBe(0.003);
  });

  // ─── case insensitive ───
  it('handles uppercase dexId', () => {
    expect(resolveAmmFeePct('Raydium')).toBe(0.0025);
    expect(resolveAmmFeePct('PUMPSWAP')).toBe(0.0025);
    expect(resolveAmmFeePct('Meteora-DLMM')).toBe(0.003);
  });

  // ─── poolProgram lookup ───
  it('resolves by Raydium AMM v4 program ID', () => {
    expect(resolveAmmFeePct(undefined, '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8')).toBe(0.0025);
  });

  it('resolves by PumpSwap program ID', () => {
    expect(resolveAmmFeePct(undefined, 'PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP')).toBe(0.0025);
  });

  it('resolves by Meteora DLMM program ID', () => {
    expect(resolveAmmFeePct(undefined, 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo')).toBe(0.003);
  });

  // ─── dexId takes priority over poolProgram ───
  it('prefers dexId over poolProgram when both provided', () => {
    // Raydium dexId (0.25%) vs Meteora program (0.30%)
    expect(resolveAmmFeePct('raydium', 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo')).toBe(0.0025);
  });

  // ─── fallback ───
  it('returns default fallback (0.003) for unknown dexId', () => {
    expect(resolveAmmFeePct('unknown_dex')).toBe(0.003);
  });

  it('returns default fallback for undefined inputs', () => {
    expect(resolveAmmFeePct()).toBe(0.003);
    expect(resolveAmmFeePct(undefined, undefined)).toBe(0.003);
  });

  it('uses custom fallback when provided', () => {
    expect(resolveAmmFeePct('unknown', undefined, 0.01)).toBe(0.01);
  });

  it('falls back to poolProgram when dexId is unknown', () => {
    expect(
      resolveAmmFeePct('unknown_dex', '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8')
    ).toBe(0.0025);
  });
});
