import { Pool } from 'pg';
import { CandleStore, TradeStore } from '../candle';
import { PositionStore } from '../state';
import { SignalAuditLogger } from '../audit';
import { EventScoreStore } from '../event';
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('InitStores');

export interface StoreConfig {
  databaseUrl: string;
}

export interface InitStoresResult {
  dbPool: Pool;
  candleStore: CandleStore;
  tradeStore: TradeStore;
  positionStore: PositionStore;
  auditLogger: SignalAuditLogger;
  eventScoreStore: EventScoreStore;
}

/**
 * DB Pool + 코어 스토어 초기화
 * M-20: pool exhaustion 방지 — max connections 제한 + idle timeout
 */
export async function initStores(storeConfig: StoreConfig): Promise<InitStoresResult> {
  const dbPool = new Pool({
    connectionString: storeConfig.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  dbPool.on('error', (err) => {
    log.error(`DB pool error: ${err.message}`);
  });

  const candleStore = new CandleStore(dbPool);
  const tradeStore = new TradeStore(dbPool);
  const positionStore = new PositionStore(dbPool);
  const auditLogger = new SignalAuditLogger(dbPool);

  await Promise.all([
    candleStore.initialize(),
    tradeStore.initialize(),
    positionStore.initialize(),
    auditLogger.initialize(),
  ]);

  const eventScoreStore = new EventScoreStore(dbPool);
  await eventScoreStore.initialize();
  log.info('Database initialized');

  return { dbPool, candleStore, tradeStore, positionStore, auditLogger, eventScoreStore };
}
