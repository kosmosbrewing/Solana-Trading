import {
  isAuthorizedControlMessage,
  isSelfTargetingProcessCommand,
  listProcessAliases,
  parseControlCommand,
} from '../src/ops/telegramControlPolicy';
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

  test('parses health command', () => {
    const parsed = parseControlCommand('/health', ALLOWED_PROCESSES);
    expect(parsed).toEqual({ kind: 'command', command: { type: 'health' } });
  });

  test('parses report command and heartbeat alias', () => {
    expect(parseControlCommand('/report', ALLOWED_PROCESSES)).toEqual({
      kind: 'command',
      command: { type: 'report' },
    });
    expect(parseControlCommand('/heartbeat', ALLOWED_PROCESSES)).toEqual({
      kind: 'command',
      command: { type: 'report' },
    });
  });

  test('parses process commands for allowed processes', () => {
    const parsed = parseControlCommand('/restart momentum-shadow', ALLOWED_PROCESSES);
    expect(parsed).toEqual({
      kind: 'command',
      command: { type: 'restart', processName: 'momentum-shadow' },
    });
  });

  test('parses aliases for allowed processes', () => {
    const parsed = parseControlCommand('/logs shadow', ALLOWED_PROCESSES);
    expect(parsed).toEqual({
      kind: 'command',
      command: { type: 'logs', processName: 'momentum-shadow' },
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
      message: 'Process not allowed: random-service. Allowed: momentum-bot/bot, momentum-shadow/shadow',
    });
  });

  test('ignores plain text messages', () => {
    expect(parseControlCommand('hello', ALLOWED_PROCESSES)).toEqual({ kind: 'ignored' });
  });

  test('lists derived process aliases', () => {
    expect(listProcessAliases('momentum-bot')).toEqual(['momentum-bot', 'bot']);
    expect(listProcessAliases('momentum-shadow')).toEqual(['momentum-shadow', 'shadow']);
  });

  test('detects unsafe self restart or stop commands', () => {
    expect(isSelfTargetingProcessCommand(
      { type: 'restart', processName: 'momentum-ops-bot' },
      'momentum-ops-bot'
    )).toBe(true);
    expect(isSelfTargetingProcessCommand(
      { type: 'stop', processName: 'momentum-ops-bot' },
      'momentum-ops-bot'
    )).toBe(true);
    expect(isSelfTargetingProcessCommand(
      { type: 'logs', processName: 'momentum-ops-bot' },
      'momentum-ops-bot'
    )).toBe(false);
    expect(isSelfTargetingProcessCommand(
      { type: 'restart', processName: 'momentum-bot' },
      'momentum-ops-bot'
    )).toBe(false);
  });
});
