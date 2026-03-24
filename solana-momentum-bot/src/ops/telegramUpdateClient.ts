import axios, { AxiosInstance } from 'axios';
import { createModuleLogger } from '../utils/logger';
import { TelegramUpdate } from './telegramTypes';

const log = createModuleLogger('TelegramUpdateClient');

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

export class TelegramUpdateClient {
  private client: AxiosInstance;

  constructor(botToken: string) {
    this.client = axios.create({
      baseURL: `https://api.telegram.org/bot${botToken}`,
      timeout: 35_000,
    });
  }

  async getUpdates(offset?: number, timeoutSec = 30): Promise<TelegramUpdate[]> {
    const response = await this.client.get<TelegramApiResponse<TelegramUpdate[]>>('/getUpdates', {
      params: {
        offset,
        timeout: timeoutSec,
        allowed_updates: JSON.stringify(['message', 'edited_message']),
      },
    });

    if (!response.data.ok) {
      const message = response.data.description || 'Telegram getUpdates failed';
      log.warn(message);
      throw new Error(message);
    }

    return response.data.result;
  }
}
