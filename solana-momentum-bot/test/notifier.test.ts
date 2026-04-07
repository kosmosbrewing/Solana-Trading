import axios from 'axios';
import fs from 'fs';
import { Notifier } from '../src/notifier/notifier';

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(),
  },
}));

interface NotifierEventRecord {
  category: string;
  phase: 'attempt' | 'result';
  status: 'ok' | 'fail' | 'attempt' | 'disabled';
  chunk_index: number;
  chunk_total: number;
  message_preview: string;
  error?: string;
  trade_id?: string;
  pair_address?: string;
}

function collectEvents(spy: jest.SpyInstance): NotifierEventRecord[] {
  return spy.mock.calls
    .map(([, payload]) => payload as string)
    .filter((line): line is string => typeof line === 'string')
    .map((line) => JSON.parse(line.replace(/\n$/, '')) as NotifierEventRecord);
}

describe('Notifier', () => {
  let appendSpy: jest.SpyInstance;
  let mkdirSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    // Why: Phase C1 감사 로그는 실제 디스크에 쓰지 않고 spy로만 검증한다.
    mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    appendSpy = jest.spyOn(fs, 'appendFileSync').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    mkdirSpy.mockRestore();
    appendSpy.mockRestore();
  });

  it('downgrades transient sendError alerts to warning and throttles duplicates', async () => {
    const post = jest.fn().mockResolvedValue(undefined);
    (axios.create as jest.Mock).mockReturnValue({ post });
    const notifier = new Notifier('bot-token', 'chat-id');

    await notifier.sendError('ingester', new Error('Request failed with status code 429'));
    await notifier.sendError('ingester', new Error('Request failed with status code 429'));

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1].text).toContain('Warning Alert');
    expect(post.mock.calls[0][1].text).toContain('Transient error: Request failed with status code 429');
  });

  it('keeps non-transient sendError alerts critical', async () => {
    const post = jest.fn().mockResolvedValue(undefined);
    (axios.create as jest.Mock).mockReturnValue({ post });
    const notifier = new Notifier('bot-token', 'chat-id');

    await notifier.sendError('trade_execution', new Error('insufficient balance'));

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1].text).toContain('Critical Alert');
    expect(post.mock.calls[0][1].text).toContain('Error: insufficient balance');
  });

  // Phase C1 — notifier-events.jsonl 감사 로그 검증
  describe('Phase C1 — notifier event audit log', () => {
    it('appends attempt + ok result records with correct category on success', async () => {
      const post = jest.fn().mockResolvedValue(undefined);
      (axios.create as jest.Mock).mockReturnValue({ post });
      const notifier = new Notifier('bot-token', 'chat-id');

      await notifier.sendError('trade_execution', new Error('insufficient balance'));

      const events = collectEvents(appendSpy);
      expect(events.length).toBeGreaterThanOrEqual(2);
      const attempt = events.find((e) => e.phase === 'attempt');
      const result = events.find((e) => e.phase === 'result');
      expect(attempt?.category).toBe('alert:critical:trade_execution');
      expect(attempt?.status).toBe('attempt');
      expect(result?.category).toBe('alert:critical:trade_execution');
      expect(result?.status).toBe('ok');
    });

    it('records alert:transient:* category for throttled transient errors (Phase C1 bugfix)', async () => {
      const post = jest.fn().mockResolvedValue(undefined);
      (axios.create as jest.Mock).mockReturnValue({ post });
      const notifier = new Notifier('bot-token', 'chat-id');

      await notifier.sendError('ingester', new Error('Request failed with status code 429'));

      const events = collectEvents(appendSpy);
      // Regression guard: 이전에는 transient 분기가 category='raw'로 기록되어 감사 로그가 깨졌다.
      expect(events.every((e) => e.category !== 'raw')).toBe(true);
      expect(events.some((e) => e.category === 'alert:transient:ingester')).toBe(true);
    });

    it('appends fail status with error message when telegram post rejects', async () => {
      const post = jest.fn().mockRejectedValue(new Error('telegram 500'));
      (axios.create as jest.Mock).mockReturnValue({ post });
      const notifier = new Notifier('bot-token', 'chat-id');

      await notifier.sendError('trade_execution', new Error('db connection lost'));

      const events = collectEvents(appendSpy);
      const failed = events.find((e) => e.phase === 'result' && e.status === 'fail');
      expect(failed).toBeDefined();
      expect(failed?.category).toBe('alert:critical:trade_execution');
      expect(failed?.error).toContain('telegram 500');
    });

    it('records disabled status when notifier is not configured', async () => {
      const notifier = new Notifier('', '');

      await notifier.sendCritical('startup', 'bot offline');

      const events = collectEvents(appendSpy);
      expect(events).toHaveLength(1);
      expect(events[0].status).toBe('disabled');
      expect(events[0].category).toBe('alert:critical:startup');
    });

    it('emits one attempt + one result per chunk when message is split', async () => {
      const post = jest.fn().mockResolvedValue(undefined);
      (axios.create as jest.Mock).mockReturnValue({ post });
      const notifier = new Notifier('bot-token', 'chat-id');

      // 4000자 제한 초과: 5000자 메시지 (line 분할을 타도록 개행 섞음).
      const long = Array.from({ length: 400 }, (_, i) => `line-${i} ${'x'.repeat(20)}`).join('\n');
      await notifier.sendCritical('bulk_test', long);

      const events = collectEvents(appendSpy);
      const attempts = events.filter((e) => e.phase === 'attempt');
      const results = events.filter((e) => e.phase === 'result');
      expect(attempts.length).toBeGreaterThanOrEqual(2);
      expect(results.length).toBe(attempts.length);
      expect(attempts.every((e) => e.category === 'alert:critical:bulk_test')).toBe(true);
      expect(attempts.every((e) => e.chunk_total === attempts.length)).toBe(true);
      // chunk_index는 0, 1, 2 ... 순차로 부여되어야 한다.
      const indices = attempts.map((e) => e.chunk_index).sort((a, b) => a - b);
      expect(indices).toEqual(Array.from({ length: attempts.length }, (_, i) => i));
    });
  });
});
