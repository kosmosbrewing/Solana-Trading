import axios from 'axios';
import { Notifier } from '../src/notifier/notifier';

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(),
  },
}));

describe('Notifier', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
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
});
