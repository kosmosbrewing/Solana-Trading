import axios, { AxiosInstance } from 'axios';
import fs from 'fs';
import path from 'path';
import { createModuleLogger } from '../utils/logger';
import { config } from '../utils/config';
import { Signal, Trade, Order, AlertLevel } from '../utils/types';
import {
  buildAlertMessage,
  buildRecoveryReportMessage,
  buildSignalMessage,
  buildTradeCloseMessage,
  buildTradeOpenMessage,
} from './messageFormatter';
import { buildDailySummaryMessage, DailySummaryReport } from './dailySummaryFormatter';
import { RealtimeShadowReport } from '../reporting';
import { formatKstDate } from './formatting';
import { buildRealtimeShadowSummaryMessage } from './realtimeShadowFormatter';

const log = createModuleLogger('Notifier');
const TELEGRAM_MESSAGE_LIMIT = 4000;

// Phase C1: 발송/실패 이력을 jsonl로 보존해 사후 감사 가능하게 한다.
// DB 대신 jsonl을 선택한 이유: schema 변경 없이 적용 가능 + append-only가 경합에 안전.
const NOTIFIER_EVENT_LOG_PATH = path.resolve(config.realtimeDataDir, 'notifier-events.jsonl');

interface NotifierEventContext {
  /** signal | trade_open | trade_close | alert | info | summary | recovery | shadow | raw */
  category: string;
  tradeId?: string;
  pairAddress?: string;
}

interface NotifierEventRecord {
  sent_at: string;
  direction: 'out';
  phase: 'attempt' | 'result';
  category: string;
  trade_id?: string;
  pair_address?: string;
  chunk_index: number;
  chunk_total: number;
  message_preview: string;
  status: 'ok' | 'fail' | 'attempt' | 'disabled';
  error?: string;
}

let notifierLogInitAttempted = false;

function ensureNotifierLogDir(): void {
  if (notifierLogInitAttempted) return;
  notifierLogInitAttempted = true;
  try {
    fs.mkdirSync(path.dirname(NOTIFIER_EVENT_LOG_PATH), { recursive: true });
  } catch (error) {
    log.warn(`Failed to create notifier-events.jsonl dir: ${error}`);
  }
}

function appendNotifierEvent(record: NotifierEventRecord): void {
  ensureNotifierLogDir();
  try {
    fs.appendFileSync(NOTIFIER_EVENT_LOG_PATH, `${JSON.stringify(record)}\n`);
  } catch (error) {
    // Why: 이력 기록이 실패해도 실제 알림 전송을 막지 않는다.
    log.warn(`Failed to append notifier event: ${error}`);
  }
}

function buildMessagePreview(text: string, maxLen = 120): string {
  const stripped = text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return stripped.length <= maxLen ? stripped : `${stripped.slice(0, maxLen - 3)}...`;
}

const ALERT_EMOJI: Record<AlertLevel, string> = {
  CRITICAL: '🔴',
  WARNING: '🟡',
  TRADE: '🟢',
  INFO: '⚪',
};

interface ThrottleEntry {
  lastSent: number;
  count: number;
  hourStart: number;
}

export class Notifier {
  private client: AxiosInstance;
  private chatId: string;
  private enabled: boolean;
  private throttle: Map<string, ThrottleEntry> = new Map();

  constructor(botToken: string, chatId: string) {
    this.chatId = chatId;
    this.enabled = !!(botToken && chatId);

    this.client = axios.create({
      baseURL: `https://api.telegram.org/bot${botToken}`,
      timeout: 10000,
    });

    if (!this.enabled) {
      log.warn('Telegram notifier disabled — missing BOT_TOKEN or CHAT_ID');
    }
  }

  // ─── 4-Level Alert System ───

  async sendCritical(context: string, message: string): Promise<void> {
    await this.send(buildAlertMessage('CRITICAL', context, message));
  }

  async sendWarning(context: string, message: string): Promise<void> {
    const key = `warning:${context}`;
    if (this.isThrottled(key, 5 * 60 * 1000)) return;
    this.updateThrottle(key);

    await this.send(buildAlertMessage('WARNING', context, message));
  }

  async sendTradeAlert(message: string): Promise<void> {
    const msg = `${ALERT_EMOJI.TRADE} ${message}`;
    await this.send(msg);
  }

  async sendInfo(message: string, category = 'generic'): Promise<void> {
    const key = `info:${category}`;
    if (this.isHourlyThrottled(key, 5)) return;
    this.updateThrottle(key);

    const msg = `${ALERT_EMOJI.INFO} ${message}`;
    await this.send(msg);
  }

  async sendMessage(message: string): Promise<void> {
    await this.send(message);
  }

  // ─── Trade-specific alerts ───

  async sendSignal(signal: Signal): Promise<void> {
    await this.send(buildSignalMessage(signal));
  }

  async sendTradeOpen(order: Order, txSignature?: string): Promise<void> {
    await this.send(buildTradeOpenMessage(order, txSignature));
  }

  async sendTradeClose(trade: Trade): Promise<void> {
    await this.send(buildTradeCloseMessage(trade));
  }

  async sendRecoveryReport(details: string[]): Promise<void> {
    await this.send(buildRecoveryReportMessage(details));
  }

  async sendError(context: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = normalizeThrottleMessage(message);

    if (isTransientErrorMessage(message)) {
      const key = `transient-error:${context}:${normalized}`;
      if (this.isThrottled(key, 2 * 60 * 1000)) return;
      this.updateThrottle(key);
      await this.send(buildAlertMessage('WARNING', context, `Transient error: ${message}`));
      return;
    }

    const key = `critical-error:${context}:${normalized}`;
    if (this.isThrottled(key, 60 * 1000)) return;
    this.updateThrottle(key);
    await this.sendCritical(context, `Error: ${message}`);
  }

  async sendDailySummary(report: DailySummaryReport): Promise<void> {
    await this.send(buildDailySummaryMessage(report, formatKstDate(new Date())));
  }

  async sendRealtimeShadowSummary(report: RealtimeShadowReport): Promise<void> {
    await this.send(buildRealtimeShadowSummaryMessage(report));
  }

  // ─── Throttling ───

  private isThrottled(key: string, windowMs: number): boolean {
    const entry = this.throttle.get(key);
    if (!entry) return false;
    return Date.now() - entry.lastSent < windowMs;
  }

  private isHourlyThrottled(key: string, maxPerHour: number): boolean {
    const entry = this.throttle.get(key);
    if (!entry) return false;
    const currentHour = Math.floor(Date.now() / 3_600_000);
    if (entry.hourStart !== currentHour) return false;
    return entry.count >= maxPerHour;
  }

  private updateThrottle(key: string): void {
    const currentHour = Math.floor(Date.now() / 3_600_000);
    const existing = this.throttle.get(key);

    if (existing && existing.hourStart === currentHour) {
      existing.lastSent = Date.now();
      existing.count++;
    } else {
      this.throttle.set(key, {
        lastSent: Date.now(),
        count: 1,
        hourStart: currentHour,
      });
    }
  }

  private async send(text: string): Promise<void> {
    if (!this.enabled) {
      log.debug(`[Telegram disabled] ${text.replace(/<[^>]*>/g, '')}`);
      return;
    }

    for (const chunk of splitTelegramMessage(text, TELEGRAM_MESSAGE_LIMIT)) {
      try {
        await this.client.post('/sendMessage', {
          chat_id: this.chatId,
          text: chunk,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
      } catch (error) {
        log.error(`Telegram send failed: ${error}`);
        return;
      }
    }
  }
}

function isTransientErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    '429',
    'rate limit',
    'fetch failed',
    'network error',
    'timeout',
    'timed out',
    'socket hang up',
    'econnreset',
    'econnrefused',
    'eai_again',
    'enotfound',
  ].some((token) => normalized.includes(token));
}

function normalizeThrottleMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitTelegramMessage(message: string, maxLength: number): string[] {
  if (message.length <= maxLength) {
    return [message];
  }

  const chunks: string[] = [];
  let current = '';

  for (const line of message.split('\n')) {
    const normalizedLine = line.length <= maxLength
      ? line
      : `${line.slice(0, Math.max(0, maxLength - 13))}\n...truncated`;

    if (!current) {
      current = normalizedLine;
      continue;
    }

    const candidate = `${current}\n${normalizedLine}`;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }

    chunks.push(current);
    current = normalizedLine;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [message.slice(0, maxLength)];
}
