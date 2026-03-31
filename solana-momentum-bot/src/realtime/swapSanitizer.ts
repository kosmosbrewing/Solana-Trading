import { ParsedSwap } from './types';

interface RealtimeSwapSanitizerState {
  recentAcceptedPrices: number[];
}

export interface RealtimeSwapSanitizerResult {
  swaps: ParsedSwap[];
  keptCount: number;
  droppedCount: number;
}

const MAX_SEQUENTIAL_PRICE_RATIO = 100;
const MAX_ROLLING_MEDIAN_PRICE_RATIO = 20;
const ROLLING_PRICE_WINDOW = 5;

export class RealtimeSwapSanitizer {
  private readonly stateByPool = new Map<string, RealtimeSwapSanitizerState>();

  accept(swap: ParsedSwap): boolean {
    if (!isFinitePositive(swap.priceNative) || !isFinitePositive(swap.amountBase) || !isFinitePositive(swap.amountQuote)) {
      return false;
    }

    const state = this.getOrCreateState(swap.pool);
    const previousPrice = state.recentAcceptedPrices[state.recentAcceptedPrices.length - 1];
    if (previousPrice && priceRatio(previousPrice, swap.priceNative) > MAX_SEQUENTIAL_PRICE_RATIO) {
      return false;
    }

    if (state.recentAcceptedPrices.length >= 3) {
      const medianPrice = median(state.recentAcceptedPrices);
      if (medianPrice > 0 && priceRatio(medianPrice, swap.priceNative) > MAX_ROLLING_MEDIAN_PRICE_RATIO) {
        return false;
      }
    }

    state.recentAcceptedPrices = [
      ...state.recentAcceptedPrices.slice(-(ROLLING_PRICE_WINDOW - 1)),
      swap.priceNative,
    ];
    this.stateByPool.set(swap.pool, state);
    return true;
  }

  seed(swaps: ParsedSwap[]): RealtimeSwapSanitizerResult {
    const accepted: ParsedSwap[] = [];
    let droppedCount = 0;
    const ordered = [...swaps].sort((left, right) => left.timestamp - right.timestamp || left.slot - right.slot);

    for (const swap of ordered) {
      if (this.accept(swap)) {
        accepted.push(swap);
      } else {
        droppedCount += 1;
      }
    }

    return {
      swaps: accepted,
      keptCount: accepted.length,
      droppedCount,
    };
  }

  private getOrCreateState(pool: string): RealtimeSwapSanitizerState {
    return this.stateByPool.get(pool) ?? { recentAcceptedPrices: [] };
  }
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function priceRatio(left: number, right: number): number {
  return Math.max(left, right) / Math.min(left, right);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}
