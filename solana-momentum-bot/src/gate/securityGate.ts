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
  /** Top 10 holder concentration hard reject threshold */
  maxTop10HolderPct: number;
}

const DEFAULT_CONFIG: SecurityGateConfig = {
  minExitLiquidityUsd: 10_000,
  minSellBuyRatio: 0.1,
  allowMintableWithReduction: false,
  maxTop10HolderPct: 0.80,
};

/**
 * 2026-04-21 Survival Layer: Token-2022 extension 중 hard reject 해야 하는 종류.
 * - `transferHook`: 매도/전송 시 외부 프로그램 호출 가능 → 임의 차단 위험
 * - `permanentDelegate`: authority 가 임의 토큰 이전 가능 → 보유량 회수 위험
 * - `nonTransferable`: 매도 불가 (soul-bound token)
 * - `defaultAccountState`: 기본 account state 가 Frozen 이면 매도 차단
 *
 * 대소문자 insensitive + 일부 extension 은 config 객체로 표현될 수 있어 이름 부분 일치 매치.
 */
const DANGEROUS_TOKEN_2022_EXTENSIONS = [
  'transferhook',
  'permanentdelegate',
  'nontransferable',
  'defaultaccountstate',
] as const;

function findDangerousExtensions(extensions: string[] | undefined): string[] {
  if (!extensions || extensions.length === 0) return [];
  const found: string[] = [];
  for (const ext of extensions) {
    const lower = ext.toLowerCase();
    for (const needle of DANGEROUS_TOKEN_2022_EXTENSIONS) {
      if (lower.includes(needle)) {
        found.push(ext);
        break;
      }
    }
  }
  return found;
}

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

  // ─── P2-3: Token-2022 classification flags (로깅 전용, hard reject 아님) ───
  if (security.tokenProgram === 'spl-token-2022') {
    flags.push('TOKEN_2022');
    if (security.extensions) {
      for (const ext of security.extensions) {
        flags.push(`EXT_${ext}`);
      }
    }
  }

  // ─── Hard rejects ───

  if (security.isHoneypot) {
    log.warn('REJECTED: honeypot detected');
    flags.push('HONEYPOT');
    return { approved: false, reason: 'Honeypot detected', sizeMultiplier: 0, flags };
  }

  if (security.isFreezable || security.freezeAuthorityPresent) {
    log.warn('REJECTED: freeze authority present');
    flags.push('FREEZABLE');
    return { approved: false, reason: 'Token is freezable', sizeMultiplier: 0, flags };
  }

  if (security.hasTransferFee) {
    log.warn('REJECTED: Token-2022 transfer fee detected');
    flags.push('TRANSFER_FEE');
    return { approved: false, reason: 'Transfer fee token (Token-2022)', sizeMultiplier: 0, flags };
  }

  // 2026-04-21 Survival Layer: Token-2022 dangerous extension hard reject.
  // transferHook / permanentDelegate / nonTransferable / defaultAccountState(Frozen).
  // 기존 `hasTransferFee` 는 transferFee 만 커버 — 매도 차단이 가능한 다른 extension 보호.
  const dangerousExts = findDangerousExtensions(security.extensions);
  if (dangerousExts.length > 0) {
    const extSummary = dangerousExts.join(',');
    log.warn(`REJECTED: dangerous Token-2022 extension(s): ${extSummary}`);
    flags.push('DANGEROUS_EXT');
    for (const ext of dangerousExts) flags.push(`DANGEROUS_${ext.toUpperCase()}`);
    return {
      approved: false,
      reason: `Dangerous Token-2022 extension(s): ${extSummary}`,
      sizeMultiplier: 0,
      flags,
    };
  }

  // ─── Soft checks ───

  if (security.isMintable) {
    if (cfg.allowMintableWithReduction) {
      sizeMultiplier *= 0.5;
      flags.push('MINTABLE_REDUCED');
      log.info('Mintable token — sizing reduced 50%');
    } else {
      log.warn('REJECTED: mintable token');
      flags.push('MINTABLE');
      return { approved: false, reason: 'Token is mintable', sizeMultiplier: 0, flags };
    }
  }

  if (security.top10HolderPct > cfg.maxTop10HolderPct) {
    log.warn(
      `REJECTED: holder concentration ${(security.top10HolderPct * 100).toFixed(1)}% ` +
      `> ${(cfg.maxTop10HolderPct * 100).toFixed(1)}%`
    );
    flags.push('HIGH_CONCENTRATION');
    return {
      approved: false,
      reason: `Top 10 holders own ${(security.top10HolderPct * 100).toFixed(1)}%`,
      sizeMultiplier: 0,
      flags,
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
      flags.push('LOW_EXIT_LIQUIDITY');
      return {
        approved: false,
        reason: `Exit liquidity too low: $${exitLiquidity.exitLiquidityUsd.toFixed(0)}`,
        sizeMultiplier: 0,
        flags,
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
