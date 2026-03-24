import { createModuleLogger } from '../utils/logger';
import { TokenSecurityData, ExitLiquidityData } from '../ingester/onchainSecurity';

const log = createModuleLogger('SecurityGate');

export interface SecurityGateResult {
  approved: boolean;
  reason?: string;
  sizeMultiplier: number;
  flags: string[];
}

export interface SecurityGateConfig {
  /** Minimum exit-liquidity USD to allow entry */
  minExitLiquidityUsd: number;
  /** Minimum sell/buy ratio for exit-liquidity proxy */
  minSellBuyRatio: number;
  /** Allow mintable tokens with reduced sizing */
  allowMintableWithReduction: boolean;
}

const DEFAULT_CONFIG: SecurityGateConfig = {
  minExitLiquidityUsd: 10_000,
  minSellBuyRatio: 0.1,
  allowMintableWithReduction: false,
};

/**
 * Gate 0: Security Gate — 최우선 검사.
 * "팔 수 있는 것만 사는" 원칙 적용.
 *
 * Hard reject:
 *   - honeypot
 *   - freezable (freeze authority present)
 *   - transfer fee (Token-2022 TransferFeeExtension)
 *   - exit-liquidity 부족
 *
 * Soft reject (사이징 감소):
 *   - mintable → 50% (allowMintableWithReduction=true일 때만)
 *   - exit-liquidity null (데이터 없음) → 50%
 */
export function evaluateSecurityGate(
  security: TokenSecurityData | null,
  exitLiquidity: ExitLiquidityData | null,
  config: Partial<SecurityGateConfig> = {}
): SecurityGateResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const flags: string[] = [];
  let sizeMultiplier = 1.0;

  // ─── No security data → cautious reject ───
  if (!security) {
    return {
      approved: false,
      reason: 'Token security data unavailable',
      sizeMultiplier: 0,
      flags: ['NO_SECURITY_DATA'],
    };
  }

  // ─── Hard rejects ───

  if (security.isHoneypot) {
    log.warn('REJECTED: honeypot detected');
    return { approved: false, reason: 'Honeypot detected', sizeMultiplier: 0, flags: ['HONEYPOT'] };
  }

  if (security.isFreezable || security.freezeAuthorityPresent) {
    log.warn('REJECTED: freeze authority present');
    return { approved: false, reason: 'Token is freezable', sizeMultiplier: 0, flags: ['FREEZABLE'] };
  }

  if (security.hasTransferFee) {
    log.warn('REJECTED: Token-2022 transfer fee detected');
    return { approved: false, reason: 'Transfer fee token (Token-2022)', sizeMultiplier: 0, flags: ['TRANSFER_FEE'] };
  }

  // ─── Soft checks ───

  if (security.isMintable) {
    if (cfg.allowMintableWithReduction) {
      sizeMultiplier *= 0.5;
      flags.push('MINTABLE_REDUCED');
      log.info('Mintable token — sizing reduced 50%');
    } else {
      log.warn('REJECTED: mintable token');
      return { approved: false, reason: 'Token is mintable', sizeMultiplier: 0, flags: ['MINTABLE'] };
    }
  }

  if (security.top10HolderPct > 0.80) {
    log.warn(`REJECTED: holder concentration ${(security.top10HolderPct * 100).toFixed(1)}%`);
    return {
      approved: false,
      reason: `Top 10 holders own ${(security.top10HolderPct * 100).toFixed(1)}%`,
      sizeMultiplier: 0,
      flags: ['HIGH_CONCENTRATION'],
    };
  }

  // ─── Exit-liquidity checks ───

  if (!exitLiquidity) {
    // Data unavailable — proceed with caution
    sizeMultiplier *= 0.5;
    flags.push('EXIT_LIQUIDITY_UNKNOWN');
    log.info('Exit-liquidity data unavailable — sizing reduced 50%');
  } else {
    if (exitLiquidity.exitLiquidityUsd != null && exitLiquidity.exitLiquidityUsd < cfg.minExitLiquidityUsd) {
      log.warn(`REJECTED: exit-liquidity too low ($${exitLiquidity.exitLiquidityUsd.toFixed(0)})`);
      return {
        approved: false,
        reason: `Exit liquidity too low: $${exitLiquidity.exitLiquidityUsd.toFixed(0)}`,
        sizeMultiplier: 0,
        flags: ['LOW_EXIT_LIQUIDITY'],
      };
    }

    if (exitLiquidity.sellBuyRatio < cfg.minSellBuyRatio && exitLiquidity.buyVolume24h > 0) {
      sizeMultiplier *= 0.5;
      flags.push('LOW_SELL_BUY_RATIO');
      log.info(`Low sell/buy ratio (${exitLiquidity.sellBuyRatio.toFixed(2)}) — sizing reduced 50%`);
    }
  }

  return {
    approved: true,
    reason: flags.length > 0 ? `Security flags: ${flags.join(', ')}` : undefined,
    sizeMultiplier,
    flags,
  };
}
