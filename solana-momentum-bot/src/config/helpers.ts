// Env parsing primitives for src/config/*. All sections must use these helpers
// so env catalog drift stays detectable (AGENTS.md §env: env access centralised).

import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

export function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export function boolOptional(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value == null || value === '') return fallback;
  return value === 'true';
}

export function numEnv(key: string, fallback: number | string): number {
  const raw = process.env[key];
  return Number(raw ?? fallback);
}

const VALID_TRADING_MODES = ['paper', 'live'] as const;
export type TradingMode = typeof VALID_TRADING_MODES[number];

export function parseTradingMode(): TradingMode {
  const raw = process.env.TRADING_MODE || 'paper';
  if (!VALID_TRADING_MODES.includes(raw as TradingMode)) {
    throw new Error(`Invalid TRADING_MODE: "${raw}". Must be "paper" or "live".`);
  }
  return raw as TradingMode;
}
