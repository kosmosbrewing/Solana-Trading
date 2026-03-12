import axios, { AxiosInstance } from 'axios';
import {
  Connection,
  Keypair,
  VersionedTransaction,
  TransactionMessage,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { createModuleLogger } from '../utils/logger';
import { Order, Trade } from '../utils/types';

const log = createModuleLogger('Executor');

export interface ExecutorConfig {
  solanaRpcUrl: string;
  walletPrivateKey: string;  // Base58 encoded — 이 모듈에서만 접근
  jupiterApiUrl: string;
  maxSlippage: number;       // 0.01 = 1%
  maxRetries: number;
  txTimeoutMs: number;
}

interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  routePlan: unknown[];
}

export class Executor {
  private connection: Connection;
  private wallet: Keypair;
  private jupiterClient: AxiosInstance;
  private maxSlippageBps: number;
  private maxRetries: number;
  private txTimeoutMs: number;

  constructor(executorConfig: ExecutorConfig) {
    this.connection = new Connection(executorConfig.solanaRpcUrl, 'confirmed');
    this.wallet = Keypair.fromSecretKey(bs58.decode(executorConfig.walletPrivateKey));
    this.jupiterClient = axios.create({
      baseURL: executorConfig.jupiterApiUrl,
      timeout: 15000,
    });
    this.maxSlippageBps = Math.round(executorConfig.maxSlippage * 10000);
    this.maxRetries = executorConfig.maxRetries;
    this.txTimeoutMs = executorConfig.txTimeoutMs;

    log.info(`Executor initialized. Wallet: ${this.wallet.publicKey.toBase58().slice(0, 6)}...`);
  }

  /**
   * Jupiter Swap 실행
   * @returns 트랜잭션 서명
   */
  async executeSwap(
    inputMint: string,
    outputMint: string,
    amountLamports: bigint
  ): Promise<string> {
    // 1. Jupiter Quote 요청
    const quote = await this.getQuote(inputMint, outputMint, amountLamports);
    log.info(
      `Quote: ${quote.inAmount} → ${quote.outAmount} (slippage: ${quote.slippageBps}bps)`
    );

    // 2. Swap Transaction 생성
    const swapTx = await this.getSwapTransaction(quote);

    // 3. 트랜잭션 서명 및 전송 (재시도 포함)
    return this.sendWithRetry(swapTx);
  }

  /**
   * 주문 기반 매수 실행
   */
  async executeBuy(order: Order): Promise<string> {
    const SOL_MINT = 'So11111111111111111111111111111111111111112';

    // quantity를 SOL lamports로 변환 (1 SOL = 1e9 lamports)
    const amountLamports = BigInt(Math.floor(order.quantity * 1e9));

    log.info(
      `Executing BUY: ${order.quantity} SOL → ${order.pairAddress} (strategy: ${order.strategy})`
    );

    return this.executeSwap(SOL_MINT, order.pairAddress, amountLamports);
  }

  /**
   * 포지션 매도 (토큰 → SOL)
   */
  async executeSell(
    tokenMint: string,
    amountRaw: bigint
  ): Promise<string> {
    const SOL_MINT = 'So11111111111111111111111111111111111111112';

    log.info(`Executing SELL: ${tokenMint} → SOL`);

    return this.executeSwap(tokenMint, SOL_MINT, amountRaw);
  }

  /**
   * SOL 잔고 조회 (lamports)
   */
  async getBalance(): Promise<number> {
    const balance = await this.connection.getBalance(this.wallet.publicKey);
    return balance / 1e9; // SOL 단위 반환
  }

  private async getQuote(
    inputMint: string,
    outputMint: string,
    amount: bigint
  ): Promise<JupiterQuote> {
    const response = await this.jupiterClient.get('/quote', {
      params: {
        inputMint,
        outputMint,
        amount: amount.toString(),
        slippageBps: this.maxSlippageBps,
        onlyDirectRoutes: false,
      },
    });
    return response.data;
  }

  private async getSwapTransaction(quote: JupiterQuote): Promise<Buffer> {
    const response = await this.jupiterClient.post('/swap', {
      quoteResponse: quote,
      userPublicKey: this.wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    });

    return Buffer.from(response.data.swapTransaction, 'base64');
  }

  private async sendWithRetry(txBuffer: Buffer): Promise<string> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const tx = VersionedTransaction.deserialize(txBuffer);
        tx.sign([this.wallet]);

        const signature = await this.connection.sendTransaction(tx, {
          maxRetries: 2,
          skipPreflight: false,
        });

        // 체결 확인
        const confirmation = await this.connection.confirmTransaction(
          signature,
          'confirmed'
        );

        if (confirmation.value.err) {
          throw new Error(`TX failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
        }

        log.info(`TX confirmed: ${signature} (attempt ${attempt})`);
        return signature;
      } catch (error) {
        lastError = error as Error;
        log.warn(`TX attempt ${attempt}/${this.maxRetries} failed: ${lastError.message}`);

        if (attempt < this.maxRetries) {
          // Exponential backoff
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(`TX failed after ${this.maxRetries} attempts: ${lastError?.message}`);
  }
}
