import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('BirdeyeWS');

const BIRDEYE_WS_URL = 'wss://public-api.birdeye.so/socket/solana';

export type WSSubscriptionType =
  | 'SUBSCRIBE_PRICE'
  | 'SUBSCRIBE_TXS'
  | 'SUBSCRIBE_TOKEN_NEW_LISTING'
  | 'SUBSCRIBE_NEW_PAIR';

export interface WSPriceUpdate {
  type: 'PRICE_UPDATE';
  tokenMint: string;
  price: number;
  priceChange24h?: number;
  volume24h?: number;
  timestamp: number;
}

export interface WSTransactionUpdate {
  type: 'TXS_UPDATE';
  tokenMint: string;
  side: 'buy' | 'sell';
  amount: number;
  priceUsd: number;
  timestamp: number;
  txHash?: string;
}

export interface WSNewListingUpdate {
  type: 'NEW_LISTING';
  address: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  liquidity?: number;
  liquidityAddedAt?: number;
}

export interface WSNewPairUpdate {
  type: 'NEW_PAIR';
  pairAddress: string;
  baseMint: string;
  quoteMint: string;
  liquidity?: number;
  dex?: string;
  timestamp: number;
}

export type WSUpdate = WSPriceUpdate | WSTransactionUpdate | WSNewListingUpdate | WSNewPairUpdate;

export interface BirdeyeWSConfig {
  apiKey: string;
  reconnectIntervalMs?: number;
  maxReconnectAttempts?: number;
  pingIntervalMs?: number;
}

/**
 * Birdeye WebSocket client.
 *
 * Events:
 *   - 'price'        (WSPriceUpdate)
 *   - 'txs'          (WSTransactionUpdate)
 *   - 'newListing'   (WSNewListingUpdate)
 *   - 'newPair'      (WSNewPairUpdate)
 *   - 'connected'    ()
 *   - 'disconnected' (reason: string)
 *   - 'error'        (Error)
 */
export class BirdeyeWSClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: Required<BirdeyeWSConfig>;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private subscriptions: Map<string, { type: WSSubscriptionType; params: Record<string, unknown> }> = new Map();
  private connected = false;
  private closing = false;

  constructor(config: BirdeyeWSConfig) {
    super();
    this.config = {
      apiKey: config.apiKey,
      reconnectIntervalMs: config.reconnectIntervalMs ?? 5_000,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 20,
      pingIntervalMs: config.pingIntervalMs ?? 30_000,
    };
  }

  isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    this.closing = false;
    this.connect();
  }

  stop(): void {
    this.closing = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.close(1000, 'client shutdown');
      this.ws = null;
    }
    this.connected = false;
  }

  /** Subscribe to real-time price updates for a token */
  subscribePrice(tokenMint: string): void {
    const key = `price:${tokenMint}`;
    const msg = { type: 'SUBSCRIBE_PRICE', data: { address: tokenMint, type: 'token' } };
    this.subscriptions.set(key, { type: 'SUBSCRIBE_PRICE', params: msg.data });
    this.sendIfConnected(msg);
  }

  /** Unsubscribe from price updates */
  unsubscribePrice(tokenMint: string): void {
    const key = `price:${tokenMint}`;
    this.subscriptions.delete(key);
    this.sendIfConnected({ type: 'UNSUBSCRIBE_PRICE', data: { address: tokenMint, type: 'token' } });
  }

  /** Subscribe to real-time transaction updates for a token */
  subscribeTxs(tokenMint: string): void {
    const key = `txs:${tokenMint}`;
    const msg = { type: 'SUBSCRIBE_TXS', data: { address: tokenMint, type: 'token' } };
    this.subscriptions.set(key, { type: 'SUBSCRIBE_TXS', params: msg.data });
    this.sendIfConnected(msg);
  }

  /** Unsubscribe from transaction updates */
  unsubscribeTxs(tokenMint: string): void {
    const key = `txs:${tokenMint}`;
    this.subscriptions.delete(key);
    this.sendIfConnected({ type: 'UNSUBSCRIBE_TXS', data: { address: tokenMint, type: 'token' } });
  }

  /** Subscribe to new token listings (global) */
  subscribeNewListings(): void {
    const key = 'newListing:global';
    const msg = { type: 'SUBSCRIBE_TOKEN_NEW_LISTING', data: {} };
    this.subscriptions.set(key, { type: 'SUBSCRIBE_TOKEN_NEW_LISTING', params: {} });
    this.sendIfConnected(msg);
  }

  /** Subscribe to new pair creations (global) */
  subscribeNewPairs(): void {
    const key = 'newPair:global';
    const msg = { type: 'SUBSCRIBE_NEW_PAIR', data: {} };
    this.subscriptions.set(key, { type: 'SUBSCRIBE_NEW_PAIR', params: {} });
    this.sendIfConnected(msg);
  }

  /** Remove all subscriptions for a specific token */
  unsubscribeAll(tokenMint: string): void {
    this.unsubscribePrice(tokenMint);
    this.unsubscribeTxs(tokenMint);
  }

  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  // ─── Private ───

  private connect(): void {
    if (this.closing) return;

    const url = `${BIRDEYE_WS_URL}?x-api-key=${this.config.apiKey}`;
    log.info(`Connecting to Birdeye WS (attempt ${this.reconnectAttempts + 1})...`);

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      log.info(`Birdeye WS connected (${this.subscriptions.size} subscriptions to restore)`);
      this.emit('connected');
      this.resubscribeAll();
      this.startPing();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch {
        log.warn('Failed to parse WS message');
      }
    });

    this.ws.on('close', (code, reason) => {
      this.connected = false;
      this.stopPing();
      const reasonStr = reason?.toString() || `code=${code}`;
      log.warn(`Birdeye WS disconnected: ${reasonStr}`);
      this.emit('disconnected', reasonStr);
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      log.error(`Birdeye WS error: ${err.message}`);
      this.emit('error', err);
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string;
    const data = (msg.data ?? msg) as Record<string, unknown>;

    switch (type) {
      case 'PRICE_DATA':
      case 'PRICE_UPDATE':
        this.emit('price', this.parsePriceUpdate(data));
        break;
      case 'TXS_DATA':
      case 'TXS_UPDATE':
        this.emit('txs', this.parseTxsUpdate(data));
        break;
      case 'TOKEN_NEW_LISTING':
        this.emit('newListing', this.parseNewListing(data));
        break;
      case 'NEW_PAIR':
        this.emit('newPair', this.parseNewPair(data));
        break;
      case 'SUBSCRIBE_SUCCESS':
      case 'UNSUBSCRIBE_SUCCESS':
        log.debug(`WS ${type}: ${JSON.stringify(data)}`);
        break;
      case 'pong':
        break;
      default:
        log.debug(`Unknown WS message type: ${type}`);
    }
  }

  private parsePriceUpdate(data: Record<string, unknown>): WSPriceUpdate {
    return {
      type: 'PRICE_UPDATE',
      tokenMint: (data.address ?? data.mint ?? '') as string,
      price: Number(data.price ?? data.value ?? 0),
      priceChange24h: data.priceChange24h != null ? Number(data.priceChange24h) : undefined,
      volume24h: data.volume24h != null ? Number(data.volume24h) : undefined,
      timestamp: Number(data.unixTime ?? data.timestamp ?? Date.now() / 1000),
    };
  }

  private parseTxsUpdate(data: Record<string, unknown>): WSTransactionUpdate {
    return {
      type: 'TXS_UPDATE',
      tokenMint: (data.address ?? data.mint ?? '') as string,
      side: (data.side ?? data.txType ?? 'buy') as 'buy' | 'sell',
      amount: Number(data.volumeUSD ?? data.amount ?? 0),
      priceUsd: Number(data.price ?? data.priceUsd ?? 0),
      timestamp: Number(data.unixTime ?? data.blockUnixTime ?? Date.now() / 1000),
      txHash: data.txHash as string | undefined,
    };
  }

  private parseNewListing(data: Record<string, unknown>): WSNewListingUpdate {
    return {
      type: 'NEW_LISTING',
      address: (data.address ?? data.mint ?? '') as string,
      name: data.name as string | undefined,
      symbol: data.symbol as string | undefined,
      decimals: data.decimals != null ? Number(data.decimals) : undefined,
      liquidity: data.liquidity != null ? Number(data.liquidity) : undefined,
      liquidityAddedAt: data.liquidityAddedAt != null ? Number(data.liquidityAddedAt) : undefined,
    };
  }

  private parseNewPair(data: Record<string, unknown>): WSNewPairUpdate {
    return {
      type: 'NEW_PAIR',
      pairAddress: (data.pairAddress ?? data.address ?? '') as string,
      baseMint: (data.baseMint ?? data.base ?? '') as string,
      quoteMint: (data.quoteMint ?? data.quote ?? '') as string,
      liquidity: data.liquidity != null ? Number(data.liquidity) : undefined,
      dex: data.dex as string | undefined,
      timestamp: Number(data.unixTime ?? data.timestamp ?? Date.now() / 1000),
    };
  }

  private sendIfConnected(msg: Record<string, unknown>): void {
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private resubscribeAll(): void {
    for (const [, sub] of this.subscriptions) {
      this.sendIfConnected({ type: sub.type, data: sub.params });
    }
  }

  private scheduleReconnect(): void {
    if (this.closing) return;
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      log.error(`Max reconnect attempts (${this.config.maxReconnectAttempts}) reached. Giving up.`);
      this.emit('error', new Error('Max WS reconnect attempts exceeded'));
      return;
    }

    const delay = this.config.reconnectIntervalMs * Math.pow(1.5, Math.min(this.reconnectAttempts, 8));
    this.reconnectAttempts++;
    log.info(`Reconnecting in ${Math.round(delay)}ms...`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.sendIfConnected({ type: 'ping' });
    }, this.config.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearTimers(): void {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
