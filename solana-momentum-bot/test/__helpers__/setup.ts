/**
 * Jest setup baseline (Phase H1.3, 2026-04-25)
 *
 * jest.config.cjs `setupFiles` 에 등록.
 * 기존 테스트 break 회피를 위해 최소 적용 — logger quiet 만.
 *
 * 추가 강제 하지 않는 이유:
 *  - axios auto-mock: 다수 테스트가 명시 mock 없이 axios 사용 가정 → break
 *    → opt-in: test/__helpers__/network.ts 의 createBlockedAxiosMock() 사용
 *  - Date.now() block: 기존 코드 다수 의존 → 점진 전환 (Clock interface, Phase H2)
 */

// Logger noise 감소 — winston 의 INFO/DEBUG 출력 최소화
if (!process.env.LOG_LEVEL) {
  process.env.LOG_LEVEL = 'error';
}

// 2026-04-25 (H1 follow-up): test 에서는 console 전부 차단.
// expect-error 테스트의 의도된 ERROR 가 stdout 에 흘러들어 jest --silent 도 noisy.
// LOG_SILENT=false 환경변수로 명시적 override 가능 (로컬 디버깅용).
if (!process.env.LOG_SILENT) {
  process.env.LOG_SILENT = 'true';
}

// Test 환경 마킹 — 일부 모듈이 isTest 분기 가능
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

// Config 모듈 import 테스트가 로컬 .env 유무에 흔들리지 않도록 test-only dummy secrets 주입.
// 실제 네트워크 호출은 각 테스트에서 별도 mock/fixture 를 사용해야 한다.
process.env.SOLANA_RPC_URL = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899';
process.env.WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY ?? JSON.stringify(Array(64).fill(1));
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@127.0.0.1:5432/test';

// Jupiter / Helius 외부 호출이 새는 경우 즉시 발견 가능하도록 unhandled rejection 강화
process.on('unhandledRejection', (reason) => {
  // jest 가 자동 fail 시키지만 명시적으로 stderr 에 기록
  // eslint-disable-next-line no-console
  console.error('[test/setup] unhandled rejection:', reason);
});
