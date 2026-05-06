import { config } from '../utils/config';
import { createModuleLogger } from '../utils/logger';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { Notifier } from '../notifier';
import { Pm2AlertMonitor } from './pm2AlertMonitor';
import { buildPm2HealthSummary } from './pm2Health';
import { Pm2Service } from './pm2Service';
import {
  buildRuntimeHeartbeatReport,
  closeRuntimeHeartbeatDeps,
  createRuntimeHeartbeatDeps,
} from './runtimeHeartbeatReport';
import {
  formatActionMessage,
  formatErrorMessage,
  formatHealthMessage,
  formatHelpMessage,
  formatLogsMessage,
  formatStatusMessage,
} from './telegramControlFormatter';
import {
  isAuthorizedControlMessage,
  isSelfTargetingProcessCommand,
  parseControlCommand,
} from './telegramControlPolicy';
import { TelegramMessage, TelegramUpdate } from './telegramTypes';
import { TelegramUpdateClient } from './telegramUpdateClient';

const log = createModuleLogger('TelegramControlBot');
const POLL_TIMEOUT_SEC = 30;
const RETRY_DELAY_MS = 3_000;
const CONTROL_BOT_PROCESS_NAME = 'momentum-ops-bot';

let running = true;

async function main() {
  ensureControlConfig();

  const notifier = new Notifier(config.telegramBotToken, config.telegramChatId);
  const updateClient = new TelegramUpdateClient(config.telegramBotToken);
  const offsetStorePath = resolveOffsetStorePath();
  const pm2Service = new Pm2Service();
  const heartbeatDeps = createRuntimeHeartbeatDeps();
  const alertMonitor = new Pm2AlertMonitor(pm2Service, notifier, config.pm2AllowedProcesses);
  let offset = await getInitialOffset(updateClient, offsetStorePath);

  await alertMonitor.initialize();
  registerShutdownHandlers();
  log.info(`Ops bot started for chat ${config.telegramChatId}`);

  while (running) {
    try {
      const updates = await updateClient.getUpdates(offset, POLL_TIMEOUT_SEC);
      for (const update of updates) {
        offset = update.update_id + 1;
        await persistOffset(offsetStorePath, offset);
        await handleUpdate(update, notifier, pm2Service, alertMonitor, heartbeatDeps);
      }
      await alertMonitor.tick();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Polling failed: ${message}`);
      await sleep(RETRY_DELAY_MS);
    }
  }

  log.info('Ops bot stopped');
  await closeRuntimeHeartbeatDeps(heartbeatDeps);
}

async function handleUpdate(
  update: TelegramUpdate,
  notifier: Notifier,
  pm2Service: Pm2Service,
  alertMonitor: Pm2AlertMonitor,
  heartbeatDeps: ReturnType<typeof createRuntimeHeartbeatDeps>
): Promise<void> {
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
  const processCommand = parsed.command.type === 'restart' || parsed.command.type === 'stop'
    ? parsed.command
    : null;
  if (processCommand && isSelfTargetingProcessCommand(processCommand, CONTROL_BOT_PROCESS_NAME)) {
    await notifier.sendMessage(formatErrorMessage(
      `${processCommand.type} ${processCommand.processName} is blocked from Telegram control to prevent command replay loops. Use SSH/PM2 directly.`
    ));
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
          await listAllowedProcesses(pm2Service)
        ));
        return;
      case 'health':
        await notifier.sendMessage(formatHealthMessage(
          buildPm2HealthSummary(await listAllowedProcesses(pm2Service))
        ));
        return;
      case 'report':
        await notifier.sendMessage(await buildRuntimeHeartbeatReport(heartbeatDeps));
        return;
      case 'restart':
        alertMonitor.markManualAction(parsed.command.processName);
        await notifier.sendMessage(formatActionMessage(
          'restart',
          parsed.command.processName,
          await pm2Service.restartProcess(parsed.command.processName)
        ));
        return;
      case 'stop':
        alertMonitor.markManualAction(parsed.command.processName);
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

async function getInitialOffset(updateClient: TelegramUpdateClient, offsetStorePath: string): Promise<number> {
  const storedOffset = await readStoredOffset(offsetStorePath);
  const updates = await updateClient.getUpdates(undefined, 1);
  if (updates.length === 0) return storedOffset;
  const remoteOffset = updates[updates.length - 1].update_id + 1;
  const offset = Math.max(storedOffset, remoteOffset);
  await tryPersistOffset(offsetStorePath, offset);
  log.info(`Skipping ${updates.length} stale Telegram update(s), offset=${offset}`);
  return offset;
}

function resolveOffsetStorePath(): string {
  return path.resolve(config.realtimeDataDir, 'telegram-control-offset.json');
}

async function readStoredOffset(filePath: string): Promise<number> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as { offset?: unknown };
    return typeof parsed.offset === 'number' && Number.isFinite(parsed.offset)
      ? Math.max(0, Math.floor(parsed.offset))
      : 0;
  } catch {
    return 0;
  }
}

async function persistOffset(filePath: string, offset: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({
    offset,
    updatedAt: new Date().toISOString(),
  })}\n`);
}

async function tryPersistOffset(filePath: string, offset: number): Promise<void> {
  try {
    await persistOffset(filePath, offset);
  } catch (error) {
    log.warn(`Telegram offset persist failed: ${error}`);
  }
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

async function listAllowedProcesses(pm2Service: Pm2Service) {
  return (await pm2Service.listProcesses())
    .filter((process) => config.pm2AllowedProcesses.includes(process.name));
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  log.error(`Ops bot fatal error: ${message}`);
  process.exit(1);
});
