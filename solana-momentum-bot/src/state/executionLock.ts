import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('ExecutionLock');

const LOCK_TIMEOUT_MS = 60_000; // 60초

/**
 * 인메모리 실행 잠금 — 동시에 하나의 트레이드만 실행 가능
 */
export class ExecutionLock {
  private locked = false;
  private lockedAt?: number;
  private lockTimer?: NodeJS.Timeout;
  private onTimeout?: () => void;

  constructor(onTimeout?: () => void) {
    this.onTimeout = onTimeout;
  }

  acquire(): boolean {
    // Stale lock 자동 해제
    if (this.locked && this.lockedAt) {
      const elapsed = Date.now() - this.lockedAt;
      if (elapsed > LOCK_TIMEOUT_MS) {
        log.warn(`Lock timeout after ${elapsed}ms — auto-releasing`);
        this.release();
        this.onTimeout?.();
      }
    }

    if (this.locked) {
      return false;
    }

    this.locked = true;
    this.lockedAt = Date.now();

    this.lockTimer = setTimeout(() => {
      if (this.locked) {
        log.warn('Lock timeout — force releasing');
        this.release();
        this.onTimeout?.();
      }
    }, LOCK_TIMEOUT_MS);

    return true;
  }

  release(): void {
    this.locked = false;
    this.lockedAt = undefined;
    if (this.lockTimer) {
      clearTimeout(this.lockTimer);
      this.lockTimer = undefined;
    }
  }

  isLocked(): boolean {
    return this.locked;
  }

  destroy(): void {
    this.release();
  }
}
