import type { BirdeyeTrendingToken } from '../ingester/birdeyeClient';
import type {
  DexScreenerAd,
  DexScreenerBoost,
  DexScreenerCommunityTakeover,
  DexScreenerClient,
  DexScreenerPair,
  DexScreenerTokenProfile,
} from './dexScreenerClient';

type DexDiscoveryClient = Pick<DexScreenerClient, 'getTokenPairs' | 'getTokenOrders'>;

interface DexTokenDiscoverySeed {
  tokenAddress: string;
  symbol?: string;
  name?: string;
  rank?: number;
  liquidityUsd?: number;
  raw?: Record<string, unknown>;
}

export async function buildDexBoostDiscoveryCandidates(
  client: DexDiscoveryClient,
  boosts: DexScreenerBoost[],
  maxCandidates = 10
): Promise<BirdeyeTrendingToken[]> {
  const mergedBoosts = [...mergeBoosts(boosts).values()]
    .sort((left, right) => right.totalAmount - left.totalAmount)
    .slice(0, maxCandidates);
  const candidates: BirdeyeTrendingToken[] = [];

  for (const boost of mergedBoosts) {
    const candidate = await buildDexTokenDiscoveryCandidate(client, {
      tokenAddress: boost.tokenAddress,
      symbol: 'BOOSTED',
      name: 'BOOSTED',
      rank: 999,
      raw: {
        boost_total_amount: boost.totalAmount,
        discovery_source: 'dex_boost',
      },
    });
    if (candidate) candidates.push(candidate);
  }

  return candidates;
}

export async function buildDexProfileDiscoveryCandidates(
  client: DexDiscoveryClient,
  profiles: DexScreenerTokenProfile[],
  maxCandidates = 10
): Promise<BirdeyeTrendingToken[]> {
  const seeds = profiles
    .filter((profile) => profile.chainId === 'solana' && profile.tokenAddress)
    .slice(0, maxCandidates);
  const candidates: BirdeyeTrendingToken[] = [];

  for (const profile of seeds) {
    const candidate = await buildDexTokenDiscoveryCandidate(client, {
      tokenAddress: profile.tokenAddress,
      rank: 999,
      raw: {
        discovery_source: 'dex_token_profile',
        profile_url: profile.url,
      },
    });
    if (candidate) candidates.push(candidate);
  }

  return candidates;
}

export async function buildDexCommunityTakeoverDiscoveryCandidates(
  client: DexDiscoveryClient,
  takeovers: DexScreenerCommunityTakeover[],
  maxCandidates = 5
): Promise<BirdeyeTrendingToken[]> {
  const candidates: BirdeyeTrendingToken[] = [];

  for (const takeover of takeovers.slice(0, maxCandidates)) {
    const candidate = await buildDexTokenDiscoveryCandidate(client, {
      tokenAddress: takeover.tokenAddress,
      rank: 999,
      raw: {
        discovery_source: 'dex_community_takeover',
        profile_url: takeover.url,
        claim_date: takeover.claimDate,
      },
    });
    if (candidate) candidates.push(candidate);
  }

  return candidates;
}

export async function buildDexAdDiscoveryCandidates(
  client: DexDiscoveryClient,
  ads: DexScreenerAd[],
  maxCandidates = 5
): Promise<BirdeyeTrendingToken[]> {
  const candidates: BirdeyeTrendingToken[] = [];

  for (const ad of ads.slice(0, maxCandidates)) {
    const candidate = await buildDexTokenDiscoveryCandidate(client, {
      tokenAddress: ad.tokenAddress,
      rank: 999,
      raw: {
        discovery_source: 'dex_ad',
        ad_url: ad.url,
        ad_type: ad.type,
        ad_date: ad.date,
        ad_duration_hours: ad.durationHours,
        ad_impressions: ad.impressions,
      },
    });
    if (candidate) candidates.push(candidate);
  }

  return candidates;
}

export async function buildDexTokenDiscoveryCandidate(
  client: DexDiscoveryClient,
  seed: DexTokenDiscoverySeed
): Promise<BirdeyeTrendingToken | null> {
  const pairs = await client.getTokenPairs(seed.tokenAddress);
  const bestPair = pickBestDiscoveryPair(pairs, seed.tokenAddress);
  if (!bestPair) return null;

  const orders = await client.getTokenOrders(seed.tokenAddress);
  const matchedToken = resolveMatchedToken(bestPair, seed.tokenAddress);

  return {
    address: seed.tokenAddress,
    symbol: matchedToken.symbol || seed.symbol || 'UNKNOWN',
    name: matchedToken.name || seed.name || matchedToken.symbol || 'UNKNOWN',
    rank: seed.rank ?? 999,
    price: bestPair.priceUsd,
    priceChange24hPct: bestPair.priceChange.h24,
    volume24hUsd: bestPair.volume.h24,
    liquidityUsd: bestPair.liquidity.usd || seed.liquidityUsd,
    marketCap: bestPair.marketCap ?? bestPair.fdv,
    updatedAt: new Date().toISOString(),
    source: 'token_trending',
    raw: {
      ...seed.raw,
      pair_address: bestPair.pairAddress,
      dex_id: bestPair.dexId,
      base_token_address: bestPair.baseToken.address,
      quote_token_address: bestPair.quoteToken.address,
      pool_created_at: bestPair.pairCreatedAt ? new Date(bestPair.pairCreatedAt).toISOString() : undefined,
      buys_24h: bestPair.txns.h24?.buys ?? 0,
      sells_24h: bestPair.txns.h24?.sells ?? 0,
      has_paid_orders: orders.length > 0,
    },
  };
}

function mergeBoosts(boosts: DexScreenerBoost[]): Map<string, DexScreenerBoost> {
  const merged = new Map<string, DexScreenerBoost>();
  for (const boost of boosts) {
    const previous = merged.get(boost.tokenAddress);
    if (!previous || boost.totalAmount > previous.totalAmount) {
      merged.set(boost.tokenAddress, boost);
    }
  }
  return merged;
}

function pickBestDiscoveryPair(pairs: DexScreenerPair[], tokenAddress: string): DexScreenerPair | null {
  const solanaPairs = pairs.filter(
    (pair) => pair.chainId === 'solana'
      && (pair.baseToken.address === tokenAddress || pair.quoteToken.address === tokenAddress)
  );
  if (solanaPairs.length === 0) return null;

  return [...solanaPairs]
    .sort((left, right) =>
      (right.liquidity?.usd || 0) - (left.liquidity?.usd || 0)
      || (right.volume?.h24 || 0) - (left.volume?.h24 || 0)
    )[0] ?? null;
}

function resolveMatchedToken(
  pair: DexScreenerPair,
  tokenAddress: string
): DexScreenerPair['baseToken'] | DexScreenerPair['quoteToken'] {
  if (pair.baseToken.address === tokenAddress) {
    return pair.baseToken;
  }

  if (pair.quoteToken.address === tokenAddress) {
    return pair.quoteToken;
  }

  return pair.baseToken;
}
