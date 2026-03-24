import {
  buildNewLpOrder,
  evaluateNewLpSniper,
  prepareNewLpCandidate,
} from '../src/strategy/newLpSniper';

describe('NewLpSniper async preparation', () => {
  const baseUpdate = {
    address: 'mint-1',
    symbol: 'TEST',
    liquidity: 12_000,
    liquidityAddedAt: Date.now() - 5 * 60_000,
    decimals: 6,
  };

  const safeSecurity = {
    isHoneypot: false,
    isFreezable: false,
    isMintable: false,
    hasTransferFee: false,
    freezeAuthorityPresent: false,
    top10HolderPct: 0.25,
    creatorPct: 0.05,
  };

  it('combines async security and quote gate results into a prepared candidate', async () => {
    const result = await prepareNewLpCandidate(baseUpdate, {
      getTokenSecurityDetailed: async () => safeSecurity,
      getExitLiquidity: async () => null,
      getTokenOverview: async () => ({ price: 0.123 }),
      evaluateQuoteGate: async () => ({
        approved: true,
        priceImpactPct: 0.03,
        routeFound: true,
        outAmountLamports: 5_000_000n,
        sizeMultiplier: 0.5,
      }),
    });

    expect(result.rejectionReason).toBeUndefined();
    expect(result.securityGate?.sizeMultiplier).toBe(0.5);
    expect(result.quoteGate?.sizeMultiplier).toBe(0.5);
    expect(result.candidate).toMatchObject({
      tokenMint: 'mint-1',
      tokenSymbol: 'TEST',
      price: 0.123,
      liquidityUsd: 12_000,
      jupiterRouteOk: true,
      priceImpactPct: 0.03,
    });
    expect(result.candidate?.recommendedTicketSizeSol).toBeCloseTo(0.005, 8);
  });

  it('falls back to quote-derived price when overview price is unavailable', async () => {
    const result = await prepareNewLpCandidate(baseUpdate, {
      getTokenSecurityDetailed: async () => safeSecurity,
      getExitLiquidity: async () => ({
        exitLiquidityUsd: 20_000,
        sellVolume24h: 10_000,
        buyVolume24h: 12_000,
        sellBuyRatio: 0.83,
      }),
      getTokenOverview: async () => ({}),
      evaluateQuoteGate: async () => ({
        approved: true,
        priceImpactPct: 0.01,
        routeFound: true,
        outAmountLamports: 4_000_000n,
        sizeMultiplier: 1,
      }),
    });

    expect(result.rejectionReason).toBeUndefined();
    expect(result.candidate?.price).toBeCloseTo(0.005, 8);
    expect(result.candidate?.recommendedTicketSizeSol).toBeCloseTo(0.02, 8);
  });

  it('does not require Birdeye overview when quote fallback is available', async () => {
    const result = await prepareNewLpCandidate(baseUpdate, {
      getTokenSecurityDetailed: async () => safeSecurity,
      getExitLiquidity: async () => ({
        exitLiquidityUsd: 18_000,
        sellVolume24h: 8_000,
        buyVolume24h: 10_000,
        sellBuyRatio: 0.8,
      }),
      evaluateQuoteGate: async () => ({
        approved: true,
        priceImpactPct: 0.015,
        routeFound: true,
        outAmountLamports: 4_000_000n,
        sizeMultiplier: 1,
      }),
    });

    expect(result.rejectionReason).toBeUndefined();
    expect(result.candidate?.price).toBeCloseTo(0.005, 8);
    expect(result.candidate?.liquidityUsd).toBe(12_000);
  });

  it('prefers listing-source price without overview or decimals', async () => {
    const result = await prepareNewLpCandidate({
      ...baseUpdate,
      price: 0.015,
      decimals: undefined,
    }, {
      getTokenSecurityDetailed: async () => safeSecurity,
      getExitLiquidity: async () => ({
        exitLiquidityUsd: 18_000,
        sellVolume24h: 8_000,
        buyVolume24h: 10_000,
        sellBuyRatio: 0.8,
      }),
      evaluateQuoteGate: async () => ({
        approved: true,
        priceImpactPct: 0.02,
        routeFound: true,
        outAmountLamports: 1_000_000n,
        sizeMultiplier: 1,
      }),
    });

    expect(result.rejectionReason).toBeUndefined();
    expect(result.candidate?.price).toBeCloseTo(0.015, 8);
    expect(result.candidate?.liquidityUsd).toBe(12_000);
  });

  it('propagates reduced ticket sizing into signal and order creation', () => {
    const signal = evaluateNewLpSniper({
      tokenMint: 'mint-1',
      tokenSymbol: 'TEST',
      pairAddress: 'mint-1',
      sourceLabel: 'scanner_dex_token_profile',
      liquidityUsd: 20_000,
      liquidityAddedAt: new Date(Date.now() - 5 * 60_000),
      price: 0.25,
      recommendedTicketSizeSol: 0.0075,
      securityPassed: true,
      exitLiquidityOk: true,
      jupiterRouteOk: true,
      priceImpactPct: 0.02,
    });

    expect(signal.action).toBe('BUY');
    expect(signal.meta.ticketSizeSol).toBeCloseTo(0.0075, 8);
    expect(signal.sourceLabel).toBe('scanner_dex_token_profile');

    const order = buildNewLpOrder(signal);
    expect(order.quantity).toBeCloseTo(0.0075, 8);
    expect(order.slippageBps).toBe(500);
    expect(order.sourceLabel).toBe('scanner_dex_token_profile');
  });

  it('preserves listing source label during async preparation', async () => {
    const result = await prepareNewLpCandidate({
      ...baseUpdate,
      source: 'scanner_dex_token_profile',
    }, {
      getTokenSecurityDetailed: async () => safeSecurity,
      getExitLiquidity: async () => ({
        exitLiquidityUsd: 18_000,
        sellVolume24h: 8_000,
        buyVolume24h: 10_000,
        sellBuyRatio: 0.8,
      }),
      evaluateQuoteGate: async () => ({
        approved: true,
        priceImpactPct: 0.015,
        routeFound: true,
        outAmountLamports: 4_000_000n,
        sizeMultiplier: 1,
      }),
    });

    expect(result.rejectionReason).toBeUndefined();
    expect(result.candidate?.sourceLabel).toBe('scanner_dex_token_profile');
  });
});
