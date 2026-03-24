import { TelegramMessage } from './telegramTypes';

export type ControlCommand =
  | { type: 'help' }
  | { type: 'status' }
  | { type: 'list' }
  | { type: 'restart'; processName: string }
  | { type: 'stop'; processName: string }
  | { type: 'logs'; processName: string };

export type ParsedControlCommand =
  | { kind: 'ignored' }
  | { kind: 'error'; message: string }
  | { kind: 'command'; command: ControlCommand };

export function isAuthorizedControlMessage(
  message: TelegramMessage,
  allowedChatId: string,
  adminUserId: string
): boolean {
  return String(message.chat.id) === allowedChatId && String(message.from?.id || '') === adminUserId;
}

export function parseControlCommand(text: string | undefined, allowedProcesses: string[]): ParsedControlCommand {
  if (!text || !text.trim().startsWith('/')) {
    return { kind: 'ignored' };
  }

  const [rawCommand, ...args] = text.trim().split(/\s+/);
  const command = rawCommand.toLowerCase().replace(/@.+$/, '');
  const processName = args[0];
  const allowedList = allowedProcesses.join(', ');

  switch (command) {
    case '/help':
      return { kind: 'command', command: { type: 'help' } };
    case '/status':
      return { kind: 'command', command: { type: 'status' } };
    case '/list':
      return { kind: 'command', command: { type: 'list' } };
    case '/restart':
      return parseProcessCommand('restart', processName, allowedProcesses, allowedList);
    case '/stop':
      return parseProcessCommand('stop', processName, allowedProcesses, allowedList);
    case '/logs':
      return parseProcessCommand('logs', processName, allowedProcesses, allowedList);
    default:
      return { kind: 'error', message: `Unknown command: ${command}` };
  }
}

function parseProcessCommand(
  type: 'restart' | 'stop' | 'logs',
  processName: string | undefined,
  allowedProcesses: string[],
  allowedList: string
): ParsedControlCommand {
  if (!processName) {
    return { kind: 'error', message: `Missing process name. Allowed: ${allowedList}` };
  }

  if (!allowedProcesses.includes(processName)) {
    return { kind: 'error', message: `Process not allowed: ${processName}. Allowed: ${allowedList}` };
  }

  return { kind: 'command', command: { type, processName } };
}
