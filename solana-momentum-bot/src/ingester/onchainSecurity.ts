import { Commitment, Connection, ParsedAccountData, PublicKey } from '@solana/web3.js';
import { createModuleLogger } from '../utils/logger';
import { recordHeliusRpcCredit } from '../observability/heliusRpcAttribution';
import { computeHolderDistribution } from '../observability/holderDistribution';

const log = createModuleLogger('OnchainSecurity');
const RATIO_SCALE = 1_000_000n;
const SECURITY_POSITIVE_TTL_MS = 5 * 60 * 1000;
const SECURITY_NEGATIVE_TTL_MS = 30 * 60 * 1000;
const DECIMALS_TTL_MS = 24 * 60 * 60 * 1000;

export interface TokenSecurityData {
  isHoneypot: boolean;
  isFreezable: boolean;
  isMintable: boolean;
  hasTransferFee: boolean;
  freezeAuthorityPresent: boolean;
  top10HolderPct: number;
  creatorPct: number;
  ownerAddress?: string;
  creatorAddress?: string;
  // P2-3: Token-2022 classification
  tokenProgram?: string;   // 'spl-token' | 'spl-token-2022'
  extensions?: string[];   // Token-2022 extension 이름 목록

  // 2026-05-01 (Helius Stream B) — holder distribution enrichment
  // ADR: docs/exec-plans/active/helius-credit-edge-plan-2026-05-01.md §6 Stream B
  // 정책: observe-only — 신규 hard reject 안 함. tokenQualityInspector + cohort 분석용.
  // 산출: computeHolderDistribution(largestAccounts, totalSupply) (holderDistribution.ts)
  /** Top-1 holder 비율 (0-1, e.g. 0.45 = 45%). 산출 실패 시 undefined. */
  top1HolderPct?: number;
  /** Top-5 holders 합 비율 (0-1). */
  top5HolderPct?: number;
  /** Herfindahl-Hirschman Index (0-1) — sample 안 분포 집중도. 1 = single holder. */
  holderHhi?: number;
  /** 산출 sample 의 holder 수 (largestAccounts 반환 row 수, 보통 ≤20). */
  holderCountApprox?: number;
  /** 분모 sample 합계 fallback 사용 여부 (true 면 supply 미제공 — 정확도 낮음). */
  holderSampleBased?: boolean;
}

export interface ExitLiquidityData {
  exitLiquidityUsd: number | null;
  sellVolume24h: number;
  buyVolume24h: number;
  sellBuyRatio: number;
}

interface MintSecurityConnection {
  getParsedAccountInfo(pubkey: PublicKey, commitment?: Commitment): Promise<{ value: { data: unknown } | null }>;
  // 2026-05-01 (Helius Stream B): Solana web3.js Connection 은 `address: PublicKey` 반환,
  //   test mock 은 `address: string` 으로 mock 가능 — `unknown` 으로 받고 normalize 시 toString().
  //   detectTopHolderOverlap (holderDistribution) 의 dev/pool overlap 검증 입력.
  getTokenLargestAccounts(pubkey: PublicKey, commitment?: Commitment): Promise<{
    value: Array<{ amount: string; address?: unknown }>;
  }>;
}

interface ParsedMintInfo {
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  supply?: string;
  decimals?: number;
  extensions?: unknown[];
}

export class OnchainSecurityClient {
  private readonly commitment: Commitment;
  private readonly connection: MintSecurityConnection;
  private readonly securityCache = new Map<string, { expiresAt: number; data: TokenSecurityData | null }>();
  private readonly decimalsCache = new Map<string, { expiresAt: number; decimals: number | null }>();

  constructor(
    rpcUrl: string,
    options: { commitment?: Commitment; connection?: MintSecurityConnection } = {}
  ) {
    this.commitment = options.commitment ?? 'confirmed';
    this.connection = options.connection ?? new Connection(rpcUrl, this.commitment);
  }

  async getTokenSecurityDetailed(tokenMint: string): Promise<TokenSecurityData | null> {
    const cached = this.securityCache.get(tokenMint);
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    try {
      const mint = new PublicKey(tokenMint);
      recordHeliusRpcCredit({
        purpose: 'token_quality',
        method: 'getParsedAccountInfo',
        feature: 'onchain_security',
        tokenMint,
        traceId: `security-account-${tokenMint.slice(0, 8)}`,
      });
      recordHeliusRpcCredit({
        purpose: 'token_quality',
        method: 'getTokenLargestAccounts',
        feature: 'onchain_security',
        tokenMint,
        traceId: `security-largest-${tokenMint.slice(0, 8)}`,
      });
      const [parsedAccount, largestAccounts] = await Promise.all([
        this.connection.getParsedAccountInfo(mint, this.commitment),
        this.connection.getTokenLargestAccounts(mint, this.commitment),
      ]);
      const accountData = parsedAccount.value?.data as ParsedAccountData | undefined;
      const mintInfo = extractMintInfo(accountData);
      if (!mintInfo) {
        log.warn(`Mint account parsing unavailable for ${tokenMint}`);
        this.securityCache.set(tokenMint, { expiresAt: Date.now() + SECURITY_NEGATIVE_TTL_MS, data: null });
        return null;
      }

      const freezeAuthorityPresent = mintInfo.freezeAuthority != null;
      const mintAuthorityPresent = mintInfo.mintAuthority != null;

      // P2-3: Token-2022 classification
      const tokenProgram = typeof accountData?.program === 'string' ? accountData.program : undefined;
      const extensions = parseExtensionNames(mintInfo.extensions);

      // 2026-05-01 (Helius Stream B): holder distribution enrichment.
      //   기존 top10 산식 (`computeTop10HolderPct`) 은 supply 분모 — 그대로 유지.
      //   추가로 `computeHolderDistribution` (sampleSum/supply 분모 자동 분기) 호출 → top1/top5/HHI.
      //   RPC 신규 호출 0 (largestAccounts 재사용).
      const supplyNum = parseSupplyToNumber(mintInfo.supply);
      const holderEntries = largestAccounts.value.map((a) => ({
        amount: parseAmountToNumber(a.amount),
        // address 는 PublicKey | string | undefined 모두 가능 — string 으로 normalize.
        address: normalizeAddress(a.address),
      }));
      const holderDist = computeHolderDistribution(holderEntries, supplyNum);

      const data: TokenSecurityData = {
        isHoneypot: false,
        isFreezable: freezeAuthorityPresent,
        isMintable: mintAuthorityPresent,
        hasTransferFee: hasTransferFeeExtension(mintInfo.extensions),
        freezeAuthorityPresent,
        top10HolderPct: computeTop10HolderPct(mintInfo.supply, largestAccounts.value),
        creatorPct: 0,
        tokenProgram,
        extensions: extensions.length > 0 ? extensions : undefined,
        // Stream B: holder distribution observe-only enrich
        top1HolderPct: holderDist.top1HolderPct,
        top5HolderPct: holderDist.top5HolderPct,
        holderHhi: holderDist.holderHhi,
        holderCountApprox: holderDist.holderCountApprox,
        holderSampleBased: holderDist.sampleBased,
      };
      this.securityCache.set(tokenMint, { expiresAt: Date.now() + SECURITY_POSITIVE_TTL_MS, data });
      return data;
    } catch (error) {
      log.warn(`Onchain security fetch failed for ${tokenMint}: ${error}`);
      this.securityCache.set(tokenMint, { expiresAt: Date.now() + SECURITY_NEGATIVE_TTL_MS, data: null });
      return null;
    }
  }

  async getExitLiquidity(_tokenMint: string): Promise<ExitLiquidityData | null> {
    return null;
  }

  /**
   * Mint decimals — `getTokenSecurityDetailed` 에서 이미 read 한 mint account 의 decimals 를 노출.
   * KOL handler 의 size-aware sell-quote probe (2026-04-25 review fix) 에서 사용. 캐시 없음 — 호출자가
   * 필요 시 캐시. 실패 시 null.
   */
  async getMintDecimals(tokenMint: string): Promise<number | null> {
    const cached = this.decimalsCache.get(tokenMint);
    if (cached && cached.expiresAt > Date.now()) return cached.decimals;

    try {
      const mint = new PublicKey(tokenMint);
      recordHeliusRpcCredit({
        purpose: 'token_quality',
        method: 'getParsedAccountInfo',
        feature: 'onchain_security_decimals',
        tokenMint,
        traceId: `security-decimals-${tokenMint.slice(0, 8)}`,
      });
      const parsed = await this.connection.getParsedAccountInfo(mint, this.commitment);
      const data = parsed.value?.data as ParsedAccountData | undefined;
      const info = extractMintInfo(data);
      const decimals = info?.decimals as number | undefined;
      const normalized = typeof decimals === 'number' && Number.isFinite(decimals) ? decimals : null;
      this.decimalsCache.set(tokenMint, { expiresAt: Date.now() + DECIMALS_TTL_MS, decimals: normalized });
      return normalized;
    } catch (err) {
      log.warn(`Mint decimals fetch failed for ${tokenMint}: ${err}`);
      this.decimalsCache.set(tokenMint, { expiresAt: Date.now() + SECURITY_NEGATIVE_TTL_MS, decimals: null });
      return null;
    }
  }
}

function extractMintInfo(data: unknown): ParsedMintInfo | null {
  const parsedData = data as ParsedAccountData | undefined;
  if (!parsedData || typeof parsedData !== 'object') return null;
  if (!('parsed' in parsedData) || parsedData.parsed.type !== 'mint') return null;
  return parsedData.parsed.info as ParsedMintInfo;
}

function hasTransferFeeExtension(extensions?: unknown[]): boolean {
  if (!Array.isArray(extensions)) return false;
  return extensions.some((extension) =>
    JSON.stringify(extension).toLowerCase().includes('transferfee')
  );
}

// P2-3: Token-2022 extension 이름 추출
export function parseExtensionNames(extensions?: unknown[]): string[] {
  if (!Array.isArray(extensions)) return [];
  return extensions
    .map(ext => typeof ext === 'object' && ext !== null && 'extension' in ext
      ? String((ext as { extension: string }).extension) : undefined)
    .filter((name): name is string => name !== undefined);
}

function computeTop10HolderPct(
  totalSupplyRaw: string | undefined,
  largestAccounts: Array<{ amount: string }>
): number {
  const totalSupply = toBigInt(totalSupplyRaw);
  if (totalSupply <= 0n) return 0;

  const top10Balance = largestAccounts
    .slice(0, 10)
    .reduce((sum, account) => sum + toBigInt(account.amount), 0n);

  return clampRatio(top10Balance, totalSupply);
}

function clampRatio(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return 0;
  const scaledRatio = (numerator * RATIO_SCALE) / denominator;
  return Math.max(0, Math.min(1, Number(scaledRatio) / Number(RATIO_SCALE)));
}

function toBigInt(value: string | number | bigint | null | undefined): bigint {
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') return BigInt(Math.trunc(value));
    if (typeof value === 'string' && value.length > 0) return BigInt(value);
  } catch {
    return 0n;
  }
  return 0n;
}

/**
 * 2026-05-01 (Helius Stream B): supply / amount string → number 안전 변환.
 *   computeHolderDistribution 이 number 분모 — bigint 보다 정밀도 손실 있지만 비율 산출 (top1/5/HHI)
 *   에는 충분 (token 가량 ≥1e6 이라 1e15 까지 IEEE 754 안전).
 *   실패 시 0 반환 — caller (computeHolderDistribution) 가 sampleBased fallback 으로 처리.
 */
function parseSupplyToNumber(supply: string | undefined): number | undefined {
  if (typeof supply !== 'string' || supply.length === 0) return undefined;
  const n = Number(supply);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseAmountToNumber(amount: string): number {
  const n = Number(amount);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * 2026-05-01 (Helius Stream B): largestAccounts 의 address 는 Solana web3.js 가 PublicKey 반환,
 *   test mock 은 string. 양쪽 모두 string 으로 normalize.
 */
function normalizeAddress(address: unknown): string | undefined {
  if (typeof address === 'string') return address;
  if (address && typeof (address as { toString?: unknown }).toString === 'function') {
    const s = String(address);
    // PublicKey.toString() 은 base58, '[object Object]' 같은 default toString 은 거부
    if (s && s !== '[object Object]') return s;
  }
  return undefined;
}
