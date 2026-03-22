import { RealtimeReplayStore } from '../realtime/replayStore';
import { RealtimeSignalRecord } from './realtimeMeasurement';

export interface RealtimeSignalSink {
  log(record: RealtimeSignalRecord): Promise<void>;
}

export class RealtimeSignalLogger implements RealtimeSignalSink {
  constructor(private readonly store: RealtimeReplayStore) {}

  async log(record: RealtimeSignalRecord): Promise<void> {
    await this.store.appendSignal(record);
  }
}
