import {
  JUPITER_KEYED_SWAP_API_URL,
  JUPITER_KEYLESS_SWAP_API_URL,
  normalizeJupiterSwapApiUrl,
} from '../src/utils/jupiterApi';

describe('jupiterApi', () => {
  it('normalizes empty URL to the keyless swap host', () => {
    expect(normalizeJupiterSwapApiUrl('', '')).toBe(JUPITER_KEYLESS_SWAP_API_URL);
  });

  it('normalizes empty URL to the keyed swap host when API key is present', () => {
    expect(normalizeJupiterSwapApiUrl('', 'test-key')).toBe(JUPITER_KEYED_SWAP_API_URL);
  });

  it('downgrades root api.jup.ag to lite swap host when no API key is present', () => {
    expect(normalizeJupiterSwapApiUrl('https://api.jup.ag', '')).toBe(JUPITER_KEYLESS_SWAP_API_URL);
  });

  it('upgrades legacy quote-api v6 host to the modern swap host', () => {
    expect(normalizeJupiterSwapApiUrl('https://quote-api.jup.ag/v6', '')).toBe(
      JUPITER_KEYLESS_SWAP_API_URL
    );
  });

  it('keeps custom proxy URLs unchanged', () => {
    expect(normalizeJupiterSwapApiUrl('https://proxy.example.com/jupiter', '')).toBe(
      'https://proxy.example.com/jupiter'
    );
  });
});
