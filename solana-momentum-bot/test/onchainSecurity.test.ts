import { OnchainSecurityClient } from '../src/ingester/onchainSecurity';

const VALID_MINT = 'So11111111111111111111111111111111111111112';

describe('OnchainSecurityClient', () => {
  it('parses mint authority, freeze authority, and top holder concentration from RPC data', async () => {
    const client = new OnchainSecurityClient('http://localhost:8899', {
      connection: {
        getParsedAccountInfo: async () => ({
          value: {
            data: {
              program: 'spl-token',
              parsed: {
                type: 'mint',
                info: {
                  mintAuthority: null,
                  freezeAuthority: 'freeze-auth',
                  supply: '1000',
                  extensions: [],
                },
              },
            },
          },
        }),
        getTokenLargestAccounts: async () => ({
          value: [{ amount: '250' }, { amount: '150' }, { amount: '50' }],
        }),
      },
    });

    const result = await client.getTokenSecurityDetailed(VALID_MINT);

    expect(result).toMatchObject({
      isHoneypot: false,
      isFreezable: true,
      isMintable: false,
      hasTransferFee: false,
      freezeAuthorityPresent: true,
      top10HolderPct: 0.45,
      creatorPct: 0,
      tokenProgram: 'spl-token',
    });
    expect(result?.extensions).toBeUndefined();
  });

  it('detects Token-2022 transfer fee extensions from parsed mint metadata', async () => {
    const client = new OnchainSecurityClient('http://localhost:8899', {
      connection: {
        getParsedAccountInfo: async () => ({
          value: {
            data: {
              program: 'spl-token-2022',
              parsed: {
                type: 'mint',
                info: {
                  mintAuthority: 'mint-auth',
                  freezeAuthority: null,
                  supply: '500',
                  extensions: [{ extension: 'transferFeeConfig' }],
                },
              },
            },
          },
        }),
        getTokenLargestAccounts: async () => ({
          value: [{ amount: '500' }],
        }),
      },
    });

    const result = await client.getTokenSecurityDetailed(VALID_MINT);

    expect(result?.isMintable).toBe(true);
    expect(result?.hasTransferFee).toBe(true);
    expect(result?.top10HolderPct).toBe(1);
    // P2-3: Token-2022 classification
    expect(result?.tokenProgram).toBe('spl-token-2022');
    expect(result?.extensions).toEqual(['transferFeeConfig']);
  });

  it('parses multiple Token-2022 extensions', async () => {
    const client = new OnchainSecurityClient('http://localhost:8899', {
      connection: {
        getParsedAccountInfo: async () => ({
          value: {
            data: {
              program: 'spl-token-2022',
              parsed: {
                type: 'mint',
                info: {
                  mintAuthority: null,
                  freezeAuthority: null,
                  supply: '1000',
                  extensions: [
                    { extension: 'mintCloseAuthority' },
                    { extension: 'interestBearingConfig' },
                  ],
                },
              },
            },
          },
        }),
        getTokenLargestAccounts: async () => ({
          value: [{ amount: '1000' }],
        }),
      },
    });

    const result = await client.getTokenSecurityDetailed(VALID_MINT);

    expect(result?.tokenProgram).toBe('spl-token-2022');
    expect(result?.extensions).toEqual(['mintCloseAuthority', 'interestBearingConfig']);
    expect(result?.hasTransferFee).toBe(false);
  });

  it('returns null exit liquidity to preserve existing soft-reduction behavior', async () => {
    const client = new OnchainSecurityClient('http://localhost:8899', {
      connection: {
        getParsedAccountInfo: async () => ({ value: null }),
        getTokenLargestAccounts: async () => ({ value: [] }),
      },
    });

    await expect(client.getExitLiquidity(VALID_MINT)).resolves.toBeNull();
  });
});
