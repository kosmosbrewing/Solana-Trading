/**
 * Sprint B1 (2026-04-28) — Jupiter 429 detection 회귀 테스트.
 *
 * 운영 incident — kolh-live-GwR3ruFz 가 9 attempts 연속 close fail (Swap failed after 3 attempts:
 * Request failed with status code 429) 후 17분 close 지연으로 mae −63% → −66.8% 손실 확대.
 * Fix: executor.ts 의 swap retry loop 가 429 error 를 명시 detect 해서 longer backoff (5/15/45s)
 * 적용 + 별도 maxRetries 로 일반 retry 와 분리 + recordJupiter429 호출.
 *
 * 본 테스트는 detection helper 의 정확성만 unit-level 로 검증. executor 의 full retry loop 는
 * Jupiter API + Solana RPC mock 부담이 커서 별도 integration test 로 deferred.
 */
jest.mock('../src/utils/logger', () => ({
  createModuleLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { AxiosError } from 'axios';
import { is429Error } from '../src/executor/executor';

describe('executor 429 detection (Sprint B1)', () => {
  it('AxiosError with response.status=429 → true', () => {
    const err = new AxiosError('Request failed', '429', undefined, null, {
      status: 429,
      statusText: 'Too Many Requests',
      headers: {},
      config: {} as any,
      data: null,
    });
    expect(is429Error(err)).toBe(true);
  });

  it('AxiosError with response.status=500 → false', () => {
    const err = new AxiosError('Server error', '500', undefined, null, {
      status: 500,
      statusText: 'Internal Server Error',
      headers: {},
      config: {} as any,
      data: null,
    });
    expect(is429Error(err)).toBe(false);
  });

  it('Generic Error with "429" in message → true (fallback detect)', () => {
    const err = new Error('Swap failed after 3 attempts: Request failed with status code 429');
    expect(is429Error(err)).toBe(true);
  });

  it('Generic Error with "rate limit" in message → true (fallback detect)', () => {
    const err = new Error('Jupiter quote API: rate limit exceeded');
    expect(is429Error(err)).toBe(true);
  });

  it('Generic Error without 429/rate-limit keyword → false', () => {
    const err = new Error('Insufficient liquidity');
    expect(is429Error(err)).toBe(false);
  });

  it('non-Error value (null) → false', () => {
    expect(is429Error(null)).toBe(false);
  });
});
