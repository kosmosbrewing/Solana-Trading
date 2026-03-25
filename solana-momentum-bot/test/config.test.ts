describe('config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      SOLANA_RPC_URL: 'https://rpc.example.com',
      WALLET_PRIVATE_KEY: 'mock-private-key',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      JUPITER_API_URL: '',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('defaults Jupiter quote base URL to lite-api swap path when no API key is set', async () => {
    const { config } = await import('../src/utils/config');
    expect(config.jupiterApiUrl).toBe('https://lite-api.jup.ag/swap/v1');
  });

  it('defaults Jupiter quote base URL to keyed swap path when API key is set', async () => {
    process.env.JUPITER_API_KEY = 'test-jupiter-key';

    const { config } = await import('../src/utils/config');

    expect(config.jupiterApiUrl).toBe('https://api.jup.ag/swap/v1');
  });
});
