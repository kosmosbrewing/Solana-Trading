export interface ObservedPairCandidate {
  pairAddress: string;
  dexId?: string;
  baseTokenAddress: string;
  baseTokenSymbol?: string;
  quoteTokenAddress: string;
  quoteTokenSymbol?: string;
  priceUsd?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  marketCap?: number;
  fdv?: number;
  pairCreatedAt?: number;
  buys24h?: number;
  sells24h?: number;
}
