import { TelegramMessage } from './telegramTypes';

export type ControlCommand =
  | { type: 'help' }
  | { type: 'status' }
  | { type: 'list' }
  | { type: 'health' }
  | { type: 'report' }
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
  const processToken = args[0];
  const allowedList = formatAllowedProcesses(allowedProcesses);

  switch (command) {
    case '/help':
      return { kind: 'command', command: { type: 'help' } };
    case '/status':
      return { kind: 'command', command: { type: 'status' } };
    case '/list':
      return { kind: 'command', command: { type: 'list' } };
    case '/health':
      return { kind: 'command', command: { type: 'health' } };
    case '/report':
    case '/heartbeat':
      return { kind: 'command', command: { type: 'report' } };
    case '/restart':
      return parseProcessCommand('restart', processToken, allowedProcesses, allowedList);
    case '/stop':
      return parseProcessCommand('stop', processToken, allowedProcesses, allowedList);
    case '/logs':
      return parseProcessCommand('logs', processToken, allowedProcesses, allowedList);
    default:
      return { kind: 'error', message: `Unknown command: ${command}` };
  }
}

function parseProcessCommand(
  type: 'restart' | 'stop' | 'logs',
  processToken: string | undefined,
  allowedProcesses: string[],
  allowedList: string
): ParsedControlCommand {
  if (!processToken) {
    return { kind: 'error', message: `Missing process name. Allowed: ${allowedList}` };
  }

  const processName = resolveProcessName(processToken, allowedProcesses);
  if (!processName) {
    return { kind: 'error', message: `Process not allowed: ${processToken}. Allowed: ${allowedList}` };
  }

  return { kind: 'command', command: { type, processName } };
}

export function listProcessAliases(processName: string): string[] {
  const match = processName.match(/^momentum-(.+?)(?:-bot)?$/);
  if (!match) return [processName];
  return [processName, match[1]];
}

function resolveProcessName(processToken: string, allowedProcesses: string[]): string | null {
  const normalizedToken = processToken.toLowerCase();
  for (const processName of allowedProcesses) {
    if (listProcessAliases(processName).map((alias) => alias.toLowerCase()).includes(normalizedToken)) {
      return processName;
    }
  }
  return null;
}

function formatAllowedProcesses(allowedProcesses: string[]): string {
  return allowedProcesses
    .map((processName) => listProcessAliases(processName).join('/'))
    .join(', ');
}
