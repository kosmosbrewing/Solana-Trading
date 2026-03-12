import axios, { AxiosInstance } from 'axios';
import { createModuleLogger } from '../utils/logger';
import { Signal, Trade, Order } from '../utils/types';

const log = createModuleLogger('Notifier');

export class Notifier {
  private client: AxiosInstance;
  private chatId: string;
  private enabled: boolean;

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

  async sendSignal(signal: Signal): Promise<void> {
    const icon = signal.action === 'BUY' ? '🟢' : signal.action === 'SELL' ? '🔴' : '⚪';
    const msg = [
      `${icon} <b>Signal: ${signal.action}</b>`,
      `Strategy: ${signal.strategy}`,
      `Pair: <code>${signal.pairAddress}</code>`,
      `Price: ${signal.price.toFixed(8)}`,
      `Time: ${signal.timestamp.toISOString()}`,
      '',
      ...Object.entries(signal.meta).map(
        ([k, v]) => `  ${k}: ${typeof v === 'number' ? v.toFixed(4) : v}`
      ),
    ].join('\n');

    await this.send(msg);
  }

  async sendTradeOpen(order: Order, txSignature?: string): Promise<void> {
    const msg = [
      `📈 <b>Trade Opened</b>`,
      `Strategy: ${order.strategy}`,
      `Side: ${order.side}`,
      `Price: ${order.price.toFixed(8)}`,
      `Quantity: ${order.quantity.toFixed(6)}`,
      `SL: ${order.stopLoss.toFixed(8)}`,
      `TP1: ${order.takeProfit1.toFixed(8)}`,
      `TP2: ${order.takeProfit2.toFixed(8)}`,
      txSignature ? `TX: <code>${txSignature}</code>` : '',
    ].join('\n');

    await this.send(msg);
  }

  async sendTradeClose(trade: Trade): Promise<void> {
    const pnlIcon = (trade.pnl || 0) >= 0 ? '✅' : '❌';
    const msg = [
      `${pnlIcon} <b>Trade Closed</b>`,
      `Strategy: ${trade.strategy}`,
      `Entry: ${trade.entryPrice.toFixed(8)}`,
      `Exit: ${trade.exitPrice?.toFixed(8) || 'N/A'}`,
      `PnL: ${trade.pnl?.toFixed(6) || 'N/A'} SOL`,
      `Slippage: ${((trade.slippage || 0) * 100).toFixed(2)}%`,
      trade.txSignature ? `TX: <code>${trade.txSignature}</code>` : '',
    ].join('\n');

    await this.send(msg);
  }

  async sendError(context: string, error: unknown): Promise<void> {
    const msg = [
      `🚨 <b>Error</b>`,
      `Context: ${context}`,
      `Message: ${error instanceof Error ? error.message : String(error)}`,
    ].join('\n');

    await this.send(msg);
  }

  async sendDailySummary(
    totalTrades: number,
    wins: number,
    losses: number,
    pnl: number
  ): Promise<void> {
    const msg = [
      `📊 <b>Daily Summary</b>`,
      `Total Trades: ${totalTrades}`,
      `Wins: ${wins} | Losses: ${losses}`,
      `Win Rate: ${totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0}%`,
      `PnL: ${pnl.toFixed(6)} SOL`,
    ].join('\n');

    await this.send(msg);
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
