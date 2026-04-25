/**
 * KOL DB tests (Option 5 Phase 1a)
 */
jest.mock('../src/utils/logger', () => ({
  createModuleLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import {
  __testInject,
  resetKolDbState,
  lookupKolByAddress,
  lookupKolById,
  getAllActiveAddresses,
  getActiveKols,
  getKolDbStats,
} from '../src/kol/db';
import type { KolWallet } from '../src/kol/types';

const pain: KolWallet = {
  id: 'pain',
  addresses: ['ADDR_PAIN_MAIN', 'ADDR_PAIN_SUB'],
  tier: 'S',
  added_at: '2026-04-23',
  last_verified_at: '2026-04-23',
  notes: 'test',
  is_active: true,
};
const dunpa: KolWallet = {
  id: 'dunpa',
  addresses: ['ADDR_DUNPA_VEC', 'ADDR_DUNPA_SUB'],
  tier: 'A',
  added_at: '2026-04-23',
  last_verified_at: '2026-04-23',
  notes: 'test',
  is_active: true,
};
const inactive: KolWallet = {
  id: 'old_kol',
  addresses: ['ADDR_OLD'],
  tier: 'B',
  added_at: '2026-01-01',
  last_verified_at: '2026-02-01',
  notes: 'stale',
  is_active: false,
};

describe('kol/db', () => {
  beforeEach(() => {
    resetKolDbState();
    __testInject([pain, dunpa, inactive]);
  });
  afterEach(() => resetKolDbState());

  it('lookupKolByAddress 로 active KOL 발견', () => {
    expect(lookupKolByAddress('ADDR_PAIN_MAIN')?.id).toBe('pain');
    expect(lookupKolByAddress('ADDR_PAIN_SUB')?.id).toBe('pain');
    expect(lookupKolByAddress('ADDR_DUNPA_VEC')?.id).toBe('dunpa');
  });

  it('inactive KOL 은 lookup 에서 제외', () => {
    expect(lookupKolByAddress('ADDR_OLD')).toBeUndefined();
    expect(lookupKolById('old_kol')).toBeUndefined();
  });

  it('getAllActiveAddresses 는 active KOL 의 모든 address 반환', () => {
    const addrs = getAllActiveAddresses();
    expect(addrs).toHaveLength(4);
    expect(addrs).toContain('ADDR_PAIN_MAIN');
    expect(addrs).toContain('ADDR_DUNPA_VEC');
    expect(addrs).not.toContain('ADDR_OLD');
  });

  it('getActiveKols tier 필터링', () => {
    const sTier = getActiveKols(['S']);
    expect(sTier).toHaveLength(1);
    expect(sTier[0].id).toBe('pain');

    const allTier = getActiveKols();
    expect(allTier).toHaveLength(2);
  });

  it('getKolDbStats', () => {
    const stats = getKolDbStats();
    expect(stats.totalKols).toBe(3);
    expect(stats.activeKols).toBe(2);
    expect(stats.byTier.S).toBe(1);
    expect(stats.byTier.A).toBe(1);
    expect(stats.byTier.B).toBe(0); // inactive 이므로 0
    expect(stats.totalAddresses).toBe(5);
    expect(stats.activeAddresses).toBe(4);
  });

  it('빈 address 는 lookup 에서 반환 안 함', () => {
    expect(lookupKolByAddress('')).toBeUndefined();
  });
});
