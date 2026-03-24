import { isAuthorizedControlMessage, parseControlCommand } from '../src/ops/telegramControlPolicy';
import { TelegramMessage } from '../src/ops/telegramTypes';

const ALLOWED_PROCESSES = ['momentum-bot', 'momentum-shadow'];

function buildMessage(text: string, chatId = '-1001', userId = '42'): TelegramMessage {
  return {
    message_id: 1,
    text,
    chat: { id: Number(chatId), type: 'group' },
    from: { id: Number(userId) },
  };
}

describe('telegramControlPolicy', () => {
  test('authorizes only matching chat and user', () => {
    expect(isAuthorizedControlMessage(buildMessage('/status'), '-1001', '42')).toBe(true);
    expect(isAuthorizedControlMessage(buildMessage('/status', '-1002', '42'), '-1001', '42')).toBe(false);
    expect(isAuthorizedControlMessage(buildMessage('/status', '-1001', '43'), '-1001', '42')).toBe(false);
  });

  test('parses status and strips bot suffix', () => {
    const parsed = parseControlCommand('/status@momentum_ops_bot', ALLOWED_PROCESSES);
    expect(parsed).toEqual({ kind: 'command', command: { type: 'status' } });
  });

  test('parses process commands for allowed processes', () => {
    const parsed = parseControlCommand('/restart momentum-shadow', ALLOWED_PROCESSES);
    expect(parsed).toEqual({
      kind: 'command',
      command: { type: 'restart', processName: 'momentum-shadow' },
    });
  });

  test('rejects missing process name', () => {
    const parsed = parseControlCommand('/logs', ALLOWED_PROCESSES);
    expect(parsed.kind).toBe('error');
  });

  test('rejects unknown process names', () => {
    const parsed = parseControlCommand('/stop random-service', ALLOWED_PROCESSES);
    expect(parsed).toEqual({
      kind: 'error',
      message: 'Process not allowed: random-service. Allowed: momentum-bot, momentum-shadow',
    });
  });

  test('ignores plain text messages', () => {
    expect(parseControlCommand('hello', ALLOWED_PROCESSES)).toEqual({ kind: 'ignored' });
  });
});
