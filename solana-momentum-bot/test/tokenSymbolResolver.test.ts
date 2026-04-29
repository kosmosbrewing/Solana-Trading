/**
 * Token Symbol Resolver tests (2026-04-29).
 *
 * Why: notifier path 의 ticker 표시 보장. Helius DAS / pump.fun lookup 의 정상/실패/sanitize/cache 동작.
 */
jest.mock('../src/utils/logger', () => ({
  createModuleLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

// 분리된 get/post mock — createBlockedAxiosMock 은 단일 blocker 공유라 호출 분리 어려움.
jest.mock('axios', () => {
  const post = jest.fn();
  const get = jest.fn();
  return {
    __esModule: true,
    default: { post, get },
    post,
    get,
  };
});

// fs/promises 차단 — disk hydrate / persist 가 실제 fs 에 닿지 않도록.
const fsMocks = {
  appendFile: jest.fn().mockResolvedValue(undefined),
  mkdir: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockResolvedValue(''),
};
jest.mock('fs/promises', () => ({
  __esModule: true,
  ...fsMocks,
}));

jest.mock('../src/utils/config', () => ({
  config: {
    heliusApiKey: 'test-key',
    realtimeDataDir: '/tmp/test-token-symbols',
  },
}));

import axios from 'axios';
import {
  lookupCachedSymbol,
  resolveTokenSymbol,
  resetTokenSymbolResolverForTests,
  injectSymbolForTests,
} from '../src/ingester/tokenSymbolResolver';

const MINT = 'So11111111111111111111111111111111111111112';

const mockedAxios = axios as unknown as { post: jest.Mock; get: jest.Mock };

describe('tokenSymbolResolver', () => {
  beforeEach(() => {
    resetTokenSymbolResolverForTests();
    mockedAxios.post.mockReset();
    mockedAxios.get.mockReset();
    fsMocks.appendFile.mockClear();
    fsMocks.mkdir.mockClear();
    fsMocks.readFile.mockClear().mockResolvedValue('');
  });

  describe('lookupCachedSymbol', () => {
    it('cache miss 시 null 반환 (RPC 호출 0)', () => {
      expect(lookupCachedSymbol(MINT)).toBeNull();
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('inject 후 hit', () => {
      injectSymbolForTests(MINT, 'WSOL');
      expect(lookupCachedSymbol(MINT)).toBe('WSOL');
    });

    it('negative cache (null inject) 도 hit 으로 처리 → null 반환 (RPC 0)', () => {
      injectSymbolForTests(MINT, null);
      expect(lookupCachedSymbol(MINT)).toBeNull();
    });
  });

  describe('resolveTokenSymbol — Helius DAS', () => {
    it('Metaplex content.metadata.symbol 추출', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { result: { content: { metadata: { symbol: 'BONK' } } } },
      });
      const sym = await resolveTokenSymbol(MINT);
      expect(sym).toBe('BONK');
      expect(lookupCachedSymbol(MINT)).toBe('BONK');
    });

    it('Token-2022 token_info.symbol fallback', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { result: { token_info: { symbol: 'PYUSD' } } },
      });
      const sym = await resolveTokenSymbol(MINT);
      expect(sym).toBe('PYUSD');
    });

    it('symbol 누락 → pump.fun fallback 시도', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { result: {} } });
      mockedAxios.get.mockResolvedValueOnce({ data: { symbol: 'PUMPCOIN' } });
      const sym = await resolveTokenSymbol(MINT);
      expect(sym).toBe('PUMPCOIN');
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });

    it('Helius + pump.fun 둘 다 실패 → null negative cache', async () => {
      mockedAxios.post.mockRejectedValueOnce(new Error('helius down'));
      mockedAxios.get.mockRejectedValueOnce(new Error('pump down'));
      const sym = await resolveTokenSymbol(MINT);
      expect(sym).toBeNull();
      expect(lookupCachedSymbol(MINT)).toBeNull();
    });
  });

  describe('caching behavior', () => {
    it('cache hit 후 재호출 시 RPC 0', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { result: { content: { metadata: { symbol: 'BONK' } } } },
      });
      await resolveTokenSymbol(MINT);
      mockedAxios.post.mockClear();
      const sym = await resolveTokenSymbol(MINT);
      expect(sym).toBe('BONK');
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('in-flight dedup — 동시 호출 시 RPC 1회', async () => {
      let resolve!: (v: unknown) => void;
      mockedAxios.post.mockReturnValueOnce(
        new Promise((res) => {
          resolve = res;
        })
      );
      const p1 = resolveTokenSymbol(MINT);
      const p2 = resolveTokenSymbol(MINT);
      resolve({ data: { result: { content: { metadata: { symbol: 'WIF' } } } } });
      const [s1, s2] = await Promise.all([p1, p2]);
      expect(s1).toBe('WIF');
      expect(s2).toBe('WIF');
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('QA fixes (F1/F5)', () => {
    it('F1: 동시 첫 호출 N개 → hydrateFromDisk readFile 1회 (single-flight)', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { result: { content: { metadata: { symbol: 'BONK' } } } },
      });
      const mints = ['mintA', 'mintB', 'mintC', 'mintD'];
      await Promise.all(mints.map((m) => resolveTokenSymbol(m)));
      expect(fsMocks.readFile).toHaveBeenCalledTimes(1);
    });

    it('F5: negative resolve 시 disk persist 안 함 (appendFile 0)', async () => {
      mockedAxios.post.mockRejectedValueOnce(new Error('helius down'));
      mockedAxios.get.mockRejectedValueOnce(new Error('pump down'));
      const sym = await resolveTokenSymbol(MINT);
      expect(sym).toBeNull();
      expect(fsMocks.appendFile).not.toHaveBeenCalled();
    });

    it('F5: positive resolve 만 disk append', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { result: { content: { metadata: { symbol: 'WIF' } } } },
      });
      await resolveTokenSymbol(MINT);
      expect(fsMocks.appendFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('sanitization', () => {
    it('control char 제거 + 16 char 로 truncate', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { result: { content: { metadata: { symbol: '\x00WAY_TOO_LONG_SYMBOL_NAME\x01' } } } },
      });
      const sym = await resolveTokenSymbol(MINT);
      expect(sym).toBe('WAY_TOO_LONG_SYM');  // 16 char, no control chars
    });

    it('빈 문자열 / whitespace-only → null', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { result: { content: { metadata: { symbol: '   ' } } } },
      });
      mockedAxios.get.mockRejectedValueOnce(new Error('pump 404'));
      const sym = await resolveTokenSymbol(MINT);
      expect(sym).toBeNull();
    });
  });
});
