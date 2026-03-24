import axios, { AxiosInstance } from 'axios';
import { createModuleLogger } from '../utils/logger';
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
import { buildRealtimeShadowSummaryMessage } from './realtimeShadowFormatter';

const log = createModuleLogger('Notifier');

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

  async sendInfo(message: string): Promise<void> {
    const key = 'info';
    if (this.isHourlyThrottled(key, 5)) return;
    this.updateThrottle(key);

    const msg = `${ALERT_EMOJI.INFO} ${message}`;
    await this.send(msg);
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
    await this.send(buildDailySummaryMessage(report, new Date().toISOString().slice(0, 10)));
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

    try {
      await this.client.post('/sendMessage', {
        chat_id: this.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (error) {
      log.error(`Telegram send failed: ${error}`);
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
