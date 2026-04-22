import { evaluateSecurityGate } from '../src/gate/securityGate';
import { TokenSecurityData } from '../src/ingester/onchainSecurity';

// Why: Token-2022 flag 보존 + hard reject 시 flag 유실 방지 검증

const BASE_SECURITY: TokenSecurityData = {
  isHoneypot: false,
  isFreezable: false,
  isMintable: false,
  hasTransferFee: false,
  freezeAuthorityPresent: false,
  top10HolderPct: 0.2,
  creatorPct: 0,
};

describe('evaluateSecurityGate', () => {
  it('adds TOKEN_2022 + EXT flags for approved Token-2022 tokens', () => {
    const security: TokenSecurityData = {
      ...BASE_SECURITY,
      tokenProgram: 'spl-token-2022',
      extensions: ['mintCloseAuthority', 'interestBearingConfig'],
    };
    const result = evaluateSecurityGate(security, null);

    expect(result.approved).toBe(true);
    expect(result.flags).toContain('TOKEN_2022');
    expect(result.flags).toContain('EXT_mintCloseAuthority');
    expect(result.flags).toContain('EXT_interestBearingConfig');
  });

  it('preserves TOKEN_2022 flag when hard-rejected for transfer fee', () => {
    const security: TokenSecurityData = {
      ...BASE_SECURITY,
      tokenProgram: 'spl-token-2022',
      extensions: ['transferFeeConfig'],
      hasTransferFee: true,
    };
    const result = evaluateSecurityGate(security, null);

    expect(result.approved).toBe(false);
    expect(result.flags).toContain('TOKEN_2022');
    expect(result.flags).toContain('TRANSFER_FEE');
    expect(result.flags).toContain('EXT_transferFeeConfig');
  });

  it('preserves TOKEN_2022 flag when hard-rejected for freezable', () => {
    const security: TokenSecurityData = {
      ...BASE_SECURITY,
      tokenProgram: 'spl-token-2022',
      extensions: ['permanentDelegate'],
      isFreezable: true,
      freezeAuthorityPresent: true,
    };
    const result = evaluateSecurityGate(security, null);

    expect(result.approved).toBe(false);
    expect(result.flags).toContain('TOKEN_2022');
    expect(result.flags).toContain('FREEZABLE');
  });

  it('does not add TOKEN_2022 flag for spl-token', () => {
    const security: TokenSecurityData = {
      ...BASE_SECURITY,
      tokenProgram: 'spl-token',
    };
    const result = evaluateSecurityGate(security, null);

    expect(result.approved).toBe(true);
    expect(result.flags).not.toContain('TOKEN_2022');
  });

  it('rejects honeypot', () => {
    const security: TokenSecurityData = {
      ...BASE_SECURITY,
      isHoneypot: true,
    };
    const result = evaluateSecurityGate(security, null);

    expect(result.approved).toBe(false);
    expect(result.flags).toContain('HONEYPOT');
  });

  it('rejects null security data', () => {
    const result = evaluateSecurityGate(null, null);
    expect(result.approved).toBe(false);
    expect(result.flags).toContain('NO_SECURITY_DATA');
  });

  // ─── 2026-04-21 Survival Layer — dangerous Token-2022 extensions ───

  it('[2026-04-21 survival] rejects transferHook extension as dangerous', () => {
    const security: TokenSecurityData = {
      ...BASE_SECURITY,
      tokenProgram: 'spl-token-2022',
      extensions: ['transferHook', 'metadataPointer'],
    };
    const result = evaluateSecurityGate(security, null);

    expect(result.approved).toBe(false);
    expect(result.flags).toContain('DANGEROUS_EXT');
    expect(result.flags).toContain('DANGEROUS_TRANSFERHOOK');
    expect(result.reason).toMatch(/Dangerous Token-2022 extension/);
  });

  it('[2026-04-21 survival] rejects permanentDelegate (authority 토큰 임의 회수 가능)', () => {
    const security: TokenSecurityData = {
      ...BASE_SECURITY,
      tokenProgram: 'spl-token-2022',
      extensions: ['permanentDelegate'],
    };
    const result = evaluateSecurityGate(security, null);

    expect(result.approved).toBe(false);
    expect(result.flags).toContain('DANGEROUS_EXT');
  });

  it('[2026-04-21 survival] rejects nonTransferable (soul-bound)', () => {
    const security: TokenSecurityData = {
      ...BASE_SECURITY,
      tokenProgram: 'spl-token-2022',
      extensions: ['nonTransferable'],
    };
    const result = evaluateSecurityGate(security, null);
    expect(result.approved).toBe(false);
    expect(result.flags).toContain('DANGEROUS_EXT');
  });

  it('[2026-04-21 survival] rejects defaultAccountState (기본 Frozen 가능)', () => {
    const security: TokenSecurityData = {
      ...BASE_SECURITY,
      tokenProgram: 'spl-token-2022',
      extensions: ['defaultAccountState'],
    };
    const result = evaluateSecurityGate(security, null);
    expect(result.approved).toBe(false);
    expect(result.flags).toContain('DANGEROUS_EXT');
  });

  it('[2026-04-21 survival] allows benign Token-2022 extensions (metadataPointer/tokenMetadata)', () => {
    const security: TokenSecurityData = {
      ...BASE_SECURITY,
      tokenProgram: 'spl-token-2022',
      extensions: ['metadataPointer', 'tokenMetadata', 'mintCloseAuthority'],
    };
    const result = evaluateSecurityGate(security, null);

    expect(result.approved).toBe(true);
    expect(result.flags).not.toContain('DANGEROUS_EXT');
  });

  it('[2026-04-21 T1] dangerous extension match is case-insensitive', () => {
    // 운영 환경에서 Token-2022 extension 이 CamelCase 로 올 수도 있음 (e.g. TransferHook).
    // findDangerousExtensions 는 lowercase 후 includes 매치 — case-insensitive 보장.
    const variants = ['TransferHook', 'PERMANENTDELEGATE', 'nonTransferable', 'DefaultAccountState'];
    for (const ext of variants) {
      const security: TokenSecurityData = {
        ...BASE_SECURITY,
        tokenProgram: 'spl-token-2022',
        extensions: [ext],
      };
      const result = evaluateSecurityGate(security, null);
      expect(result.approved).toBe(false);
      expect(result.flags).toContain('DANGEROUS_EXT');
    }
  });

  it('[2026-04-21 survival] top10HolderPct threshold respects config override (60% cap)', () => {
    const security: TokenSecurityData = {
      ...BASE_SECURITY,
      top10HolderPct: 0.65, // 65% — default 80% 하에선 통과, 60% override 하에선 reject
    };
    const loose = evaluateSecurityGate(security, null);
    expect(loose.approved).toBe(true);

    const strict = evaluateSecurityGate(security, null, { maxTop10HolderPct: 0.60 });
    expect(strict.approved).toBe(false);
    expect(strict.flags).toContain('HIGH_CONCENTRATION');
  });
});
