const mockGetMultipleAccountsInfo = jest.fn();

jest.mock('@solana/web3.js', () => {
  class PublicKey {
    constructor(private readonly value: string) {}

    toBase58(): string {
      return this.value;
    }
  }

  class Connection {
    getMultipleAccountsInfo = mockGetMultipleAccountsInfo;

    constructor(_url: string, _config: unknown) {}
  }

  return {
    Connection,
    PublicKey,
  };
});

import { RealtimePoolOwnerResolver } from '../src/realtime';

describe('RealtimePoolOwnerResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null owners instead of throwing when RPC owner lookup fails', async () => {
    mockGetMultipleAccountsInfo.mockRejectedValueOnce(
      new Error('429 Too Many Requests')
    );
    const resolver = new RealtimePoolOwnerResolver('https://rpc.example.com');

    const owners = await resolver.resolveOwners(['pool-1', 'pool-2']);

    expect(owners.get('pool-1')).toBeNull();
    expect(owners.get('pool-2')).toBeNull();
  });
});
