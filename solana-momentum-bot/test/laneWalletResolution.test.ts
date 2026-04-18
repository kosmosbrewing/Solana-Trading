/**
 * Block 1 (2026-04-18): lane wallet mode resolution.
 * 기존 `sandboxExecutor ?? executor` 암묵적 선택에서 env 기반 명시적 선택으로 전환.
 */
import { resolveCupseyWalletLabel } from '../src/orchestration/cupseyLaneHandler';
import { resolveMigrationWalletLabel } from '../src/orchestration/migrationLaneHandler';
import type { BotContext } from '../src/orchestration/types';

type WalletMode = 'auto' | 'main' | 'sandbox';

function mockCtx(hasSandbox: boolean): BotContext {
  const executor = { name: 'main-executor' };
  const sandboxExecutor = hasSandbox ? { name: 'sandbox-executor' } : undefined;
  return { executor, sandboxExecutor } as unknown as BotContext;
}

function withCupseyMode(mode: WalletMode, fn: () => void): void {
  const original = process.env.CUPSEY_WALLET_MODE;
  process.env.CUPSEY_WALLET_MODE = mode;
  // config 가 모듈 로드 시 env 를 읽고 고정되므로, 이 테스트는 resolveCupseyWalletLabel 의 런타임 동작을
  // config.cupseyWalletMode 경로로 검증한다. 테스트 파일 최상단에서 config 를 다시 로드하지 않는 이상
  // 런타임 config 가 바뀌지 않는다 — 실 동작 검증은 isolateModules 로 감싸 새 모듈 인스턴스를 만든다.
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const handler = require('../src/orchestration/cupseyLaneHandler');
    const resolveFn = handler.resolveCupseyWalletLabel as typeof resolveCupseyWalletLabel;
    (global as any).__resolve = resolveFn;
    fn();
  });
  if (original === undefined) delete process.env.CUPSEY_WALLET_MODE;
  else process.env.CUPSEY_WALLET_MODE = original;
}

function withMigrationMode(mode: WalletMode, fn: () => void): void {
  const original = process.env.MIGRATION_WALLET_MODE;
  process.env.MIGRATION_WALLET_MODE = mode;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const handler = require('../src/orchestration/migrationLaneHandler');
    const resolveFn = handler.resolveMigrationWalletLabel as typeof resolveMigrationWalletLabel;
    (global as any).__resolve = resolveFn;
    fn();
  });
  if (original === undefined) delete process.env.MIGRATION_WALLET_MODE;
  else process.env.MIGRATION_WALLET_MODE = original;
}

describe('cupsey wallet resolution', () => {
  it('auto: prefers sandbox when available (backward compat)', () => {
    withCupseyMode('auto', () => {
      const fn = (global as any).__resolve as typeof resolveCupseyWalletLabel;
      expect(fn(mockCtx(true))).toBe('sandbox');
      expect(fn(mockCtx(false))).toBe('main');
    });
  });

  it('main: forces main wallet regardless of sandbox availability', () => {
    withCupseyMode('main', () => {
      const fn = (global as any).__resolve as typeof resolveCupseyWalletLabel;
      expect(fn(mockCtx(true))).toBe('main');
      expect(fn(mockCtx(false))).toBe('main');
    });
  });

  it('sandbox: forces sandbox wallet label when available', () => {
    withCupseyMode('sandbox', () => {
      const fn = (global as any).__resolve as typeof resolveCupseyWalletLabel;
      expect(fn(mockCtx(true))).toBe('sandbox');
    });
  });
});

describe('migration wallet resolution', () => {
  it('auto: prefers sandbox when available', () => {
    withMigrationMode('auto', () => {
      const fn = (global as any).__resolve as typeof resolveMigrationWalletLabel;
      expect(fn(mockCtx(true))).toBe('sandbox');
      expect(fn(mockCtx(false))).toBe('main');
    });
  });

  it('main: forces main wallet regardless of sandbox availability', () => {
    withMigrationMode('main', () => {
      const fn = (global as any).__resolve as typeof resolveMigrationWalletLabel;
      expect(fn(mockCtx(true))).toBe('main');
      expect(fn(mockCtx(false))).toBe('main');
    });
  });

  it('sandbox: forces sandbox wallet label when available', () => {
    withMigrationMode('sandbox', () => {
      const fn = (global as any).__resolve as typeof resolveMigrationWalletLabel;
      expect(fn(mockCtx(true))).toBe('sandbox');
    });
  });
});
