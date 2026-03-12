import { Pool } from 'pg';
import { Candle } from '../utils/types';
import { CandleDataSource } from './types';
import { CandleStore } from '../candle/candleStore';

/**
 * DB-based candle loader for backtesting
 * Reuses existing CandleStore.getAllCandles()
 */
export class DbLoader implements CandleDataSource {
  private candleStore: CandleStore;

  constructor(pool: Pool) {
    this.candleStore = new CandleStore(pool);
  }

  async load(pairAddress: string, intervalSec: number): Promise<Candle[]> {
    return this.candleStore.getAllCandles(pairAddress, intervalSec);
  }
}
