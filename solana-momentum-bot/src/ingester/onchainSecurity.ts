import { Commitment, Connection, ParsedAccountData, PublicKey } from '@solana/web3.js';
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('OnchainSecurity');
const RATIO_SCALE = 1_000_000n;

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
}

export interface ExitLiquidityData {
  exitLiquidityUsd: number | null;
  sellVolume24h: number;
  buyVolume24h: number;
  sellBuyRatio: number;
}

interface MintSecurityConnection {
  getParsedAccountInfo(pubkey: PublicKey, commitment?: Commitment): Promise<{ value: { data: unknown } | null }>;
  getTokenLargestAccounts(pubkey: PublicKey, commitment?: Commitment): Promise<{
    value: Array<{ amount: string }>;
  }>;
}

interface ParsedMintInfo {
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  supply?: string;
  extensions?: unknown[];
}

export class OnchainSecurityClient {
  private readonly commitment: Commitment;
  private readonly connection: MintSecurityConnection;

  constructor(
    rpcUrl: string,
    options: { commitment?: Commitment; connection?: MintSecurityConnection } = {}
  ) {
    this.commitment = options.commitment ?? 'confirmed';
    this.connection = options.connection ?? new Connection(rpcUrl, this.commitment);
  }

  async getTokenSecurityDetailed(tokenMint: string): Promise<TokenSecurityData | null> {
    try {
      const mint = new PublicKey(tokenMint);
      const [parsedAccount, largestAccounts] = await Promise.all([
        this.connection.getParsedAccountInfo(mint, this.commitment),
        this.connection.getTokenLargestAccounts(mint, this.commitment),
      ]);
      const accountData = parsedAccount.value?.data as ParsedAccountData | undefined;
      const mintInfo = extractMintInfo(accountData);
      if (!mintInfo) {
        log.warn(`Mint account parsing unavailable for ${tokenMint}`);
        return null;
      }

      const freezeAuthorityPresent = mintInfo.freezeAuthority != null;
      const mintAuthorityPresent = mintInfo.mintAuthority != null;

      // P2-3: Token-2022 classification
      const tokenProgram = typeof accountData?.program === 'string' ? accountData.program : undefined;
      const extensions = parseExtensionNames(mintInfo.extensions);

      return {
        isHoneypot: false,
        isFreezable: freezeAuthorityPresent,
        isMintable: mintAuthorityPresent,
        hasTransferFee: hasTransferFeeExtension(mintInfo.extensions),
        freezeAuthorityPresent,
        top10HolderPct: computeTop10HolderPct(mintInfo.supply, largestAccounts.value),
        creatorPct: 0,
        tokenProgram,
        extensions: extensions.length > 0 ? extensions : undefined,
      };
    } catch (error) {
      log.warn(`Onchain security fetch failed for ${tokenMint}: ${error}`);
      return null;
    }
  }

  async getExitLiquidity(_tokenMint: string): Promise<ExitLiquidityData | null> {
    return null;
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
