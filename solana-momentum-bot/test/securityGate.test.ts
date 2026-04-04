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
});
