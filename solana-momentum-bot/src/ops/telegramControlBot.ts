import { config } from '../utils/config';
import { createModuleLogger } from '../utils/logger';
import { Notifier } from '../notifier';
import { Pm2Service } from './pm2Service';
import {
  formatActionMessage,
  formatErrorMessage,
  formatHelpMessage,
  formatLogsMessage,
  formatStatusMessage,
} from './telegramControlFormatter';
import { parseControlCommand, isAuthorizedControlMessage } from './telegramControlPolicy';
import { TelegramMessage, TelegramUpdate } from './telegramTypes';
import { TelegramUpdateClient } from './telegramUpdateClient';

const log = createModuleLogger('TelegramControlBot');
const POLL_TIMEOUT_SEC = 30;
const RETRY_DELAY_MS = 3_000;

let running = true;

async function main() {
  ensureControlConfig();

  const notifier = new Notifier(config.telegramBotToken, config.telegramChatId);
  const updateClient = new TelegramUpdateClient(config.telegramBotToken);
  const pm2Service = new Pm2Service();
  let offset = await getInitialOffset(updateClient);

  registerShutdownHandlers();
  log.info(`Ops bot started for chat ${config.telegramChatId}`);

  while (running) {
    try {
      const updates = await updateClient.getUpdates(offset, POLL_TIMEOUT_SEC);
      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(update, notifier, pm2Service);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Polling failed: ${message}`);
      await sleep(RETRY_DELAY_MS);
    }
  }

  log.info('Ops bot stopped');
}

async function handleUpdate(update: TelegramUpdate, notifier: Notifier, pm2Service: Pm2Service): Promise<void> {
  const message = extractMessage(update);
  if (!message?.text) return;

  if (!isAuthorizedControlMessage(message, config.telegramChatId, config.telegramAdminUserId)) {
    log.warn(`Unauthorized control attempt chat=${message.chat.id} user=${message.from?.id || 'unknown'}`);
    return;
  }

  const parsed = parseControlCommand(message.text, config.pm2AllowedProcesses);
  if (parsed.kind === 'ignored') return;
  if (parsed.kind === 'error') {
    await notifier.sendMessage(formatErrorMessage(`${parsed.message}\nUse /help for available commands.`));
    return;
  }

  try {
    switch (parsed.command.type) {
      case 'help':
        await notifier.sendMessage(formatHelpMessage(config.pm2AllowedProcesses));
        return;
      case 'status':
      case 'list':
        await notifier.sendMessage(formatStatusMessage(
          (await pm2Service.listProcesses())
            .filter((process) => config.pm2AllowedProcesses.includes(process.name))
        ));
        return;
      case 'restart':
        await notifier.sendMessage(formatActionMessage(
          'restart',
          parsed.command.processName,
          await pm2Service.restartProcess(parsed.command.processName)
        ));
        return;
      case 'stop':
        await notifier.sendMessage(formatActionMessage(
          'stop',
          parsed.command.processName,
          await pm2Service.stopProcess(parsed.command.processName)
        ));
        return;
      case 'logs':
        await notifier.sendMessage(formatLogsMessage(
          parsed.command.processName,
          await pm2Service.readLogs(parsed.command.processName)
        ));
        return;
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    log.error(`Command failed: ${messageText}`);
    await notifier.sendMessage(formatErrorMessage(messageText));
  }
}

async function getInitialOffset(updateClient: TelegramUpdateClient): Promise<number> {
  const updates = await updateClient.getUpdates(undefined, 1);
  if (updates.length === 0) return 0;
  const offset = updates[updates.length - 1].update_id + 1;
  log.info(`Skipping ${updates.length} stale Telegram update(s)`);
  return offset;
}

function ensureControlConfig(): void {
  if (!config.telegramBotToken) throw new Error('Missing required env var for ops bot: TELEGRAM_BOT_TOKEN');
  if (!config.telegramChatId) throw new Error('Missing required env var for ops bot: TELEGRAM_CHAT_ID');
  if (!config.telegramAdminUserId) {
    throw new Error('Missing required env var for ops bot: TELEGRAM_ADMIN_USER_ID');
  }
}

function extractMessage(update: TelegramUpdate): TelegramMessage | undefined {
  return update.message || update.edited_message;
}

function registerShutdownHandlers(): void {
  const stop = () => {
    running = false;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  log.error(`Ops bot fatal error: ${message}`);
  process.exit(1);
});
