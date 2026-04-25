/**
 * Test network helpers (Phase H1.3, 2026-04-25)
 *
 * Why: 단위 테스트가 axios.get / fetch 를 직접 호출하면 외부 네트워크 접근 → DNS 실패 / 비결정성 / CI timeout.
 *      본 helper 는 **opt-in** 패턴 — 신규/기존 테스트가 명시적으로 import 해서 사용.
 *      자동 적용 (setupFiles) 은 기존 테스트 다수를 break 하므로 회피.
 *
 * 사용법:
 *   import { mockBlockExternalAxios, mockBlockGlobalFetch } from './__helpers__/network';
 *   describe('my test', () => {
 *     beforeEach(() => mockBlockGlobalFetch());
 *     it(...);
 *   });
 *
 * 또는 가장 흔한 패턴:
 *   jest.mock('axios', () => createBlockedAxiosMock()); // top-level
 *
 * 정책:
 *  - blocked call 은 throw — 누락된 mock 즉시 발견
 *  - 명시적 mock 으로 override 가능 (mockResolvedValue 등)
 */

/** axios mock factory — `jest.mock('axios', () => createBlockedAxiosMock())` */
export function createBlockedAxiosMock(): Record<string, unknown> {
  const blocker = jest.fn(() =>
    Promise.reject(
      new Error(
        '[test/network] external axios call blocked. ' +
        'Use mockResolvedValue / mockRejectedValue to stub responses.'
      )
    )
  );
  return {
    __esModule: true,
    default: { get: blocker, post: blocker, put: blocker, delete: blocker, request: blocker },
    get: blocker,
    post: blocker,
    put: blocker,
    delete: blocker,
    request: blocker,
    isAxiosError: () => false,
  };
}

/** global.fetch 차단 — beforeEach 에서 호출 */
export function mockBlockGlobalFetch(): jest.Mock {
  const blocker = jest.fn(() =>
    Promise.reject(
      new Error('[test/network] external fetch call blocked. Mock fetch explicitly in your test.')
    )
  );
  (global as { fetch: typeof fetch }).fetch = blocker as unknown as typeof fetch;
  return blocker as unknown as jest.Mock;
}

/** Test logger 노이즈 감소 — beforeAll 에서 1회 호출 */
export function quietLogger(): void {
  process.env.LOG_LEVEL = 'error';
}
