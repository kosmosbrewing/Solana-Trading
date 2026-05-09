import { Connection, PublicKey } from '@solana/web3.js';
import { createModuleLogger } from '../utils/logger';
import { recordHeliusRpcCredit } from '../observability/heliusRpcAttribution';

const log = createModuleLogger('RealtimePoolOwnerResolver');

export class RealtimePoolOwnerResolver {
  private readonly connection: Connection;
  private readonly cache = new Map<string, string | null>();

  constructor(rpcHttpUrl: string) {
    this.connection = new Connection(rpcHttpUrl, 'confirmed');
  }

  async resolveOwners(poolAddresses: string[]): Promise<Map<string, string | null>> {
    const uniquePools = [...new Set(poolAddresses)];
    const unresolved = uniquePools.filter((pool) => !this.cache.has(pool));

    if (unresolved.length > 0) {
      try {
        const accountInfos = await this.connection.getMultipleAccountsInfo(
          unresolved.map((pool) => new PublicKey(pool)),
          'confirmed'
        );
        recordHeliusRpcCredit({
          purpose: 'pool_prewarm',
          method: 'getMultipleAccounts',
          requestCount: unresolved.length,
          feature: 'realtime_pool_owner_resolver',
          traceId: `pool-owner-${unresolved.length}`,
        });
        unresolved.forEach((pool, index) => {
          this.cache.set(pool, accountInfos[index]?.owner.toBase58() ?? null);
        });
      } catch (error) {
        log.warn(`Failed to resolve pool owners for ${unresolved.length} pools: ${error}`);
        unresolved.forEach((pool) => {
          this.cache.set(pool, null);
        });
      }
    }

    return new Map(uniquePools.map((pool) => [pool, this.cache.get(pool) ?? null]));
  }
}
