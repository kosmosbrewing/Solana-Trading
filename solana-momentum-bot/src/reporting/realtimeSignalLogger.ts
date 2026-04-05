import { RealtimeReplayStore } from '../realtime/replayStore';
import { RealtimeSignalRecord } from './realtimeMeasurement';

export type RealtimeSignalIntent = Omit<RealtimeSignalRecord, 'horizons' | 'summary'>;

export interface RealtimeSignalSink {
  log(record: RealtimeSignalRecord): Promise<void>;
}

export interface RealtimeSignalIntentSink {
  logIntent(record: RealtimeSignalIntent): Promise<void>;
}

export class RealtimeSignalLogger implements RealtimeSignalSink, RealtimeSignalIntentSink {
  constructor(private readonly store: RealtimeReplayStore) {}

  async log(record: RealtimeSignalRecord): Promise<void> {
    await this.store.appendSignal(record);
  }

  async logIntent(record: RealtimeSignalIntent): Promise<void> {
    await this.store.appendSignalIntent(record);
  }
}
