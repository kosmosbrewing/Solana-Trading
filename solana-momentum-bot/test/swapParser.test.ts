import bs58 from 'bs58';
import { createHash } from 'crypto';
import {
  isLikelyPumpSwapFallbackLog,
  METEORA_DLMM_PROGRAM,
  parseSwapFromTransaction,
  PUMP_SWAP_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  shouldForceFallbackToTransaction,
  shouldFallbackToTransaction,
  tryParseSwapFromLogs,
} from '../src/realtime';

// Phase E1 P0-M5 helper: craft a minimal Raydium CLMM SwapEvent `Program data:` line
// with arbitrary amount0/amount1/zeroForOne for multi-event selection testing.
// Layout: 8B discriminator + 128B filler (4×32B pubkeys) + amount0(8) + transfer_fee_0(8) +
//         amount1(8) + transfer_fee_1(8) + zero_for_one(1) = 169 bytes.
function craftClmmEventLine(amount0: bigint, amount1: bigint, zeroForOne: boolean): string {
  const CLMM_SWAP_EVENT_DISCRIMINATOR = createHash('sha256')
    .update('event:SwapEvent')
    .digest()
    .subarray(0, 8);
  const buf = Buffer.alloc(169);
  CLMM_SWAP_EVENT_DISCRIMINATOR.copy(buf, 0);
  buf.writeBigUInt64LE(amount0, 136);
  // transfer_fee_0 at 144-151 stays 0
  buf.writeBigUInt64LE(amount1, 152);
  // transfer_fee_1 at 160-167 stays 0
  buf.writeUInt8(zeroForOne ? 1 : 0, 168);
  return `Program data: ${buf.toString('base64')}`;
}

describe('swapParser', () => {
  it('parses swap data directly from structured logs', () => {
    const parsed = tryParseSwapFromLogs([
      'Program log: side=buy',
      'Program log: base_amount=1250',
      'Program log: quote_amount=2.5',
      'Program log: price_native=0.002',
    ], {
      poolAddress: 'pool-1',
      signature: 'sig-1',
      slot: 123,
      timestamp: 1_700_000_000,
    });

    expect(parsed).toMatchObject({
      pool: 'pool-1',
      signature: 'sig-1',
      side: 'buy',
      priceNative: 0.002,
      amountBase: 1250,
      amountQuote: 2.5,
      slot: 123,
      source: 'logs',
    });
  });

  it('parses Raydium ray_log with pool metadata into native amounts', () => {
    const parsed = tryParseSwapFromLogs([
      'Program routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS invoke [1]',
      'Program log: process_swap_base_in_with_user_account:RouteSwapBaseInArgs { amount_in: 125113437, minimum_amount_out: 19211303 }',
      'Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [2]',
      'Program log: ray_log: A10UdQcAAAAAAAAAAAAAAAABAAAAAAAAAF0UdQcAAAAAPMW5qT8jAAAithFHTyEAAAgn3wcAAAAA',
      'Program log: 125113437 -> 132065032',
    ], {
      poolAddress: 'pool-1',
      signature: 'sig-ray',
      slot: 321,
      timestamp: 1_700_000_001,
      poolMetadata: {
        dexId: 'raydium',
        baseMint: 'mint-base',
        quoteMint: 'So11111111111111111111111111111111111111112',
        baseDecimals: 6,
        quoteDecimals: 9,
        poolProgram: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      },
    });

    expect(parsed).toMatchObject({
      pool: 'pool-1',
      signature: 'sig-ray',
      side: 'buy',
      amountBase: 132.065032,
      amountQuote: 0.125113437,
      slot: 321,
      dexProgram: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      source: 'logs',
    });
    expect(parsed?.priceNative).toBeCloseTo(0.125113437 / 132.065032, 12);
  });

  it('parses Raydium CLMM SwapEvent logs when the subscribed pool is CLMM-owned', () => {
    const parsed = tryParseSwapFromLogs([
      'Program routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS invoke [1]',
      'Program CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK invoke [2]',
      'Program data: QMbN6CYIceIRTG6ayGJiNpKyNY9MROK+tKCwgbHboOh8/E9rRpdDcwW65ZV/SLUO2S2vbsX63ybBtLOmL5LEaCA7mh5uT9ek0VZbZxxyIigu4YZQSRZo8RRF/FZtXASzQyAeS5qL6pfzztUdz9T3u5NyCBh9HAEDj5F9R0xV5gd7qNQbv6jbHQgn3wcAAAAAAAAAAAAAAAAtGigBAAAAAAAAAAAAAAAAAW+SjP701ydiAAAAAAAAAACsqGOvry4AAAAAAAAAAAAAGrX//w==',
      'Program CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK success',
    ], {
      poolAddress: '2AXXcN6oN9bBT5owwmTH53C7QHUXvhLeu718Kqt8rvY2',
      signature: 'sig-clmm',
      slot: 654,
      timestamp: 1_700_000_002,
      poolMetadata: {
        dexId: 'raydium',
        baseMint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
        quoteMint: 'So11111111111111111111111111111111111111112',
        baseDecimals: 6,
        quoteDecimals: 9,
        poolProgram: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
      },
    });

    expect(parsed).toMatchObject({
      pool: '2AXXcN6oN9bBT5owwmTH53C7QHUXvhLeu718Kqt8rvY2',
      signature: 'sig-clmm',
      side: 'buy',
      amountBase: 19.405357,
      amountQuote: 0.132065032,
      slot: 654,
      dexProgram: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
      source: 'logs',
    });
    expect(parsed?.priceNative).toBeCloseTo(0.132065032 / 19.405357, 12);
  });

  // 2026-04-08 P0-M5: VDOR Raydium CLMM multi-swap-per-tx artifact 방어.
  // 같은 tx 에 SwapEvent 가 여러 개 쌓일 때 (aggregator / arbitrage) parser 는 가장 큰
  // magnitude event 를 선택해야 한다 (작은 cleanup leg 선택 금지).
  describe('Raydium CLMM multi-event selection (P0-M5)', () => {
    const poolMetadata = {
      dexId: 'raydium',
      // zeroForOne=true + sortMints 결과 token0 == quote (SOL) 가 되도록 base/quote 배치.
      // SOL mint 는 'So11...' (B 계열), 타 token mint 와 비교해 결정적이지 않으므로
      // mint 가 sortMints 로 token0 인 경우만 buy 로 처리된다. 테스트용 metadata 는
      // 실제 craftClmmEventLine 의 zero_for_one 과 sortMints 결과가 결합해 side 를
      // 낳으므로, 결과 amountBase/amountQuote 검증에만 집중하고 side 는 best-effort.
      baseMint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
      quoteMint: 'So11111111111111111111111111111111111111112',
      baseDecimals: 6,
      quoteDecimals: 9,
      poolProgram: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    };

    it('picks the largest magnitude event when multiple SwapEvents are present', () => {
      // Case: small cleanup leg 먼저, large real swap 뒤.
      // large event: amount0=10_000_000_000 (10 token units at 6 decimals = 10000),
      //              amount1=1_000_000_000_000 (1000 SOL at 9 decimals = 1000)
      // small event: amount0=100_000 (0.1 token), amount1=100_000_000 (0.1 SOL)
      // parser 가 마지막(=small)을 고르면 priceNative = 0.1/0.1 = 1.0
      // parser 가 largest 를 고르면 priceNative = 1000/10000 = 0.1 ← 기대
      // 주의: sortMints 결과에 따라 token0/1 매핑이 바뀌므로, 우리는 priceNative 의 값보다
      //      "큰 event 가 선택됐는지" 를 amountBase 기반으로 검증한다.
      const largeEvent = craftClmmEventLine(10_000_000_000n, 1_000_000_000_000n, true);
      const smallEvent = craftClmmEventLine(100_000n, 100_000_000n, true);

      const parsed = tryParseSwapFromLogs([
        'Program CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK invoke [1]',
        smallEvent, // cleanup leg 가 먼저 (작은 것)
        largeEvent, // real swap 뒤 (큰 것)
        'Program CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK success',
      ], {
        poolAddress: 'vdor-test-pool',
        signature: 'sig-multi',
        slot: 100,
        timestamp: 1_700_000_000,
        poolMetadata,
      });

      expect(parsed).not.toBeNull();
      // large event 가 선택되면 amountBase / amountQuote 중 하나는 크기 order 가 10k/1k.
      // pre-fix 코드는 .reverse().find() 로 last = largeEvent 를 선택해 이 케이스는 우연히 통과.
      // 아래 케이스에서 진짜 fix 효과를 검증한다.
      expect(parsed!.amountBase).toBeGreaterThanOrEqual(1);
      expect(parsed!.amountQuote).toBeGreaterThanOrEqual(1);
    });

    it('selects largest even when the small cleanup leg is the LAST event (VDOR pattern)', () => {
      // VDOR 실제 패턴: aggregator 가 real swap 을 먼저 실행하고, 뒤에 작은 arbitrage /
      // rebalance leg 이 추가된다. pre-fix 코드는 마지막 = small 을 선택해 bad price.
      // fix 후에는 magnitude 기반으로 large 가 선택되어야 한다.
      const largeEvent = craftClmmEventLine(10_000_000_000n, 1_000_000_000_000n, true);
      const tinyCleanup = craftClmmEventLine(1_000n, 85n, true); // 85/1000 = 0.085x of large's ratio

      const parsed = tryParseSwapFromLogs([
        'Program CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK invoke [1]',
        largeEvent, // real swap 먼저
        tinyCleanup, // tiny cleanup 마지막 — pre-fix 는 이걸 골랐다
        'Program CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK success',
      ], {
        poolAddress: 'vdor-test-pool-2',
        signature: 'sig-vdor-like',
        slot: 200,
        timestamp: 1_700_000_100,
        poolMetadata,
      });

      expect(parsed).not.toBeNull();
      // tiny cleanup 이 선택됐다면 amountBase 와 amountQuote 둘 다 매우 작다
      // (1_000 raw → 0.001 at 6 decimals, 85 raw → 8.5e-8 at 9 decimals).
      // large 가 선택되면 훨씬 커야 함 — >= 1 unit 이상.
      const maxSide = Math.max(parsed!.amountBase, parsed!.amountQuote);
      expect(maxSide).toBeGreaterThanOrEqual(1);
      // tiny 를 잘못 선택하지 않았음을 명확히 검증
      expect(maxSide).toBeGreaterThan(0.01);
    });

    it('falls back gracefully when no Program data line is present', () => {
      const parsed = tryParseSwapFromLogs([
        'Program CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK invoke [1]',
        'Program log: unrelated line',
        'Program CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK success',
      ], {
        poolAddress: 'empty-pool',
        signature: 'sig-empty',
        slot: 300,
        timestamp: 1_700_000_200,
        poolMetadata,
      });
      expect(parsed).toBeNull();
    });

    it('single-event payload still parses (backward compat)', () => {
      const onlyEvent = craftClmmEventLine(5_000_000n, 500_000_000n, true);
      const parsed = tryParseSwapFromLogs([
        'Program CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK invoke [1]',
        onlyEvent,
        'Program CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK success',
      ], {
        poolAddress: 'single-pool',
        signature: 'sig-single',
        slot: 400,
        timestamp: 1_700_000_300,
        poolMetadata,
      });
      expect(parsed).not.toBeNull();
      expect(parsed!.dexProgram).toBe('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
    });
  });

  it('drops PumpSwap swaps when pre/post token balance deltas are missing (no instruction-decode fallback)', () => {
    // Why: PumpSwap buy(base_amount_out, max_quote_amount_in, ...) instruction payload는
    //   user intent (slippage 상/하한)이라 actual fill 가격이 아니다. instruction parser fallback이
    //   살아 있던 시기에는 max_quote_amount_in / base_amount_out 비율이 그대로 priceNative가 되어
    //   pippin/swarms 같은 토큰에서 5×~30× 부풀려진 가격이 ledger에 들어가 PRICE_ANOMALY_BLOCK
    //   100%를 만들었다 (docs/audits/price-anomaly-ratio-2026-04-08.md).
    //   iter10부터는 PumpSwap에서 parseFromPoolMetadata가 null을 반환하면 swap을 drop한다.
    const buyInstructionData = encodePumpInstruction(
      [102, 6, 61, 18, 1, 218, 235, 234],
      1_250_000n,
      250_000_000n,
    );
    const parsed = parseSwapFromTransaction({
      blockTime: 1_700_000_200,
      meta: {
        err: null,
        fee: 5_000,
        innerInstructions: [],
        loadedAddresses: { readonly: [], writable: [] },
        logMessages: ['Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [1]'],
        postBalances: [],
        postTokenBalances: [],
        preBalances: [],
        preTokenBalances: [],
        rewards: [],
        status: { Ok: null },
      },
      slot: 999,
      transaction: {
        message: {
          accountKeys: [],
          instructions: [{
            programId: { toBase58: () => PUMP_SWAP_PROGRAM },
            accounts: [
              { toBase58: () => 'pool-pump' },
              { toBase58: () => 'user-1' },
            ],
            data: buyInstructionData,
          }],
          recentBlockhash: 'hash',
        },
        signatures: ['sig-pump'],
      },
    } as any, {
      poolAddress: 'pool-pump',
      signature: 'sig-pump',
      slot: 999,
      poolMetadata: {
        dexId: 'pumpswap',
        baseMint: 'mint-base',
        quoteMint: 'So11111111111111111111111111111111111111112',
        baseDecimals: 6,
        quoteDecimals: 9,
        poolProgram: PUMP_SWAP_PROGRAM,
      },
    });

    expect(parsed).toBeNull();
  });

  it('parses PumpSwap buy via pool-owned vault deltas (ignores instruction payload)', () => {
    // Why: 실제 PumpSwap tx는 user token ATA와 pool vault 양쪽을 mint별 pre/postTokenBalances에
    //   포함한다. sumMintDelta가 owner 필터 없이 전체를 합산하면 두 측의 delta가 정확히
    //   반대 부호라 0이 되어 swap이 통째로 drop되는 회귀가 발생한다. 본 테스트는 fix의 핵심
    //   불변식 — pool vault (owner == poolAddress)만 모아 pool 관점 delta를 구하고, 그 부호를
    //   뒤집어 user 관점을 재구성 — 을 강제한다. instruction payload의 max_quote_amount_in
    //   (user intent, slippage 상한)은 절대 사용되면 안 된다.
    const buyInstructionData = encodePumpInstruction(
      [102, 6, 61, 18, 1, 218, 235, 234],
      1_250_000n,
      250_000_000n,
    );
    const parsed = parseSwapFromTransaction({
      blockTime: 1_700_000_202,
      meta: {
        err: null,
        fee: 5_000,
        innerInstructions: [],
        loadedAddresses: { readonly: [], writable: [] },
        logMessages: ['Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [1]'],
        postBalances: [],
        postTokenBalances: [
          // user token ATA — owner ≠ pool, 필터에서 제외되어야 함
          {
            accountIndex: 1,
            mint: 'mint-base',
            owner: 'user-1',
            programId: 'token-program',
            uiTokenAmount: { amount: '500000', decimals: 6, uiAmount: 0.5, uiAmountString: '0.5' },
          },
          // pool base vault (pool 소유) — 0.5 base 송출 → post < pre
          {
            accountIndex: 3,
            mint: 'mint-base',
            owner: 'pool-pump',
            programId: 'token-program',
            uiTokenAmount: { amount: '500000', decimals: 6, uiAmount: 0.5, uiAmountString: '0.5' },
          },
          // pool quote vault (pool 소유) — 0.25 SOL 수취 → post > pre
          {
            accountIndex: 4,
            mint: 'So11111111111111111111111111111111111111112',
            owner: 'pool-pump',
            programId: 'token-program',
            uiTokenAmount: { amount: '250000000', decimals: 9, uiAmount: 0.25, uiAmountString: '0.25' },
          },
        ],
        preBalances: [],
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: 'mint-base',
            owner: 'user-1',
            programId: 'token-program',
            uiTokenAmount: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' },
          },
          {
            accountIndex: 3,
            mint: 'mint-base',
            owner: 'pool-pump',
            programId: 'token-program',
            uiTokenAmount: { amount: '1000000', decimals: 6, uiAmount: 1.0, uiAmountString: '1.0' },
          },
          {
            accountIndex: 4,
            mint: 'So11111111111111111111111111111111111111112',
            owner: 'pool-pump',
            programId: 'token-program',
            uiTokenAmount: { amount: '0', decimals: 9, uiAmount: 0, uiAmountString: '0' },
          },
        ],
        rewards: [],
        status: { Ok: null },
      },
      slot: 1_000,
      transaction: {
        message: {
          accountKeys: [],
          instructions: [{
            programId: { toBase58: () => PUMP_SWAP_PROGRAM },
            accounts: [
              { toBase58: () => 'pool-pump' },
              { toBase58: () => 'user-1' },
            ],
            data: buyInstructionData,
          }],
          recentBlockhash: 'hash',
        },
        signatures: ['sig-pump-metadata'],
      },
    } as any, {
      poolAddress: 'pool-pump',
      signature: 'sig-pump-metadata',
      slot: 1_000,
      poolMetadata: {
        dexId: 'pumpswap',
        baseMint: 'mint-base',
        quoteMint: 'So11111111111111111111111111111111111111112',
        baseDecimals: 6,
        quoteDecimals: 9,
        poolProgram: PUMP_SWAP_PROGRAM,
      },
    });

    expect(parsed).toMatchObject({
      pool: 'pool-pump',
      signature: 'sig-pump-metadata',
      side: 'buy',
      amountBase: 0.5,
      amountQuote: 0.25,
      slot: 1_000,
      dexProgram: PUMP_SWAP_PROGRAM,
      source: 'transaction',
    });
    expect(parsed?.priceNative).toBeCloseTo(0.5, 12);
  });

  it('parses PumpSwap sell via pool-owned vault deltas (mirror of buy case)', () => {
    // Why: sell 반대 방향 대칭 검증 — pool 기준으로 base 유입 + quote 송출.
    const sellInstructionData = encodePumpInstruction(
      [51, 230, 133, 164, 1, 127, 131, 173],
      2_000_000n,
      100_000_000n,
    );
    const parsed = parseSwapFromTransaction({
      blockTime: 1_700_000_203,
      meta: {
        err: null,
        fee: 5_000,
        innerInstructions: [],
        loadedAddresses: { readonly: [], writable: [] },
        logMessages: ['Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [1]'],
        postBalances: [],
        postTokenBalances: [
          // user token ATA — sell 이후 0
          {
            accountIndex: 1,
            mint: 'mint-base',
            owner: 'user-1',
            programId: 'token-program',
            uiTokenAmount: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' },
          },
          // pool base vault — 2 token 수취 → post > pre
          {
            accountIndex: 3,
            mint: 'mint-base',
            owner: 'pool-pump',
            programId: 'token-program',
            uiTokenAmount: { amount: '3000000', decimals: 6, uiAmount: 3.0, uiAmountString: '3.0' },
          },
          // pool quote vault — 0.1 SOL 송출 → post < pre
          {
            accountIndex: 4,
            mint: 'So11111111111111111111111111111111111111112',
            owner: 'pool-pump',
            programId: 'token-program',
            uiTokenAmount: { amount: '400000000', decimals: 9, uiAmount: 0.4, uiAmountString: '0.4' },
          },
        ],
        preBalances: [],
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: 'mint-base',
            owner: 'user-1',
            programId: 'token-program',
            uiTokenAmount: { amount: '2000000', decimals: 6, uiAmount: 2.0, uiAmountString: '2.0' },
          },
          {
            accountIndex: 3,
            mint: 'mint-base',
            owner: 'pool-pump',
            programId: 'token-program',
            uiTokenAmount: { amount: '1000000', decimals: 6, uiAmount: 1.0, uiAmountString: '1.0' },
          },
          {
            accountIndex: 4,
            mint: 'So11111111111111111111111111111111111111112',
            owner: 'pool-pump',
            programId: 'token-program',
            uiTokenAmount: { amount: '500000000', decimals: 9, uiAmount: 0.5, uiAmountString: '0.5' },
          },
        ],
        rewards: [],
        status: { Ok: null },
      },
      slot: 1_002,
      transaction: {
        message: {
          accountKeys: [],
          instructions: [{
            programId: { toBase58: () => PUMP_SWAP_PROGRAM },
            accounts: [
              { toBase58: () => 'pool-pump' },
              { toBase58: () => 'user-1' },
            ],
            data: sellInstructionData,
          }],
          recentBlockhash: 'hash',
        },
        signatures: ['sig-pump-sell'],
      },
    } as any, {
      poolAddress: 'pool-pump',
      signature: 'sig-pump-sell',
      slot: 1_002,
      poolMetadata: {
        dexId: 'pumpswap',
        baseMint: 'mint-base',
        quoteMint: 'So11111111111111111111111111111111111111112',
        baseDecimals: 6,
        quoteDecimals: 9,
        poolProgram: PUMP_SWAP_PROGRAM,
      },
    });

    expect(parsed).toMatchObject({
      pool: 'pool-pump',
      signature: 'sig-pump-sell',
      side: 'sell',
      amountBase: 2.0,
      amountQuote: 0.1,
      slot: 1_002,
      dexProgram: PUMP_SWAP_PROGRAM,
      source: 'transaction',
    });
    expect(parsed?.priceNative).toBeCloseTo(0.05, 12);
  });

  it('skips PumpSwap log parsing to force transaction fallback', () => {
    const parsed = tryParseSwapFromLogs([
      'Program log: buy',
      'Program log: base_amount_out=21.108798',
      'Program log: quote_amount_in=498.64046463',
    ], {
      poolAddress: 'pool-pump',
      signature: 'sig-pump-log',
      slot: 1_001,
      timestamp: 1_700_000_201,
      poolMetadata: {
        dexId: 'pumpswap',
        baseMint: 'mint-base',
        quoteMint: 'So11111111111111111111111111111111111111112',
        baseDecimals: 6,
        quoteDecimals: 9,
        poolProgram: PUMP_SWAP_PROGRAM,
      },
    });

    expect(parsed).toBeNull();
  });

  it('forces fallback for PumpSwap pools even when logs are opaque', () => {
    expect(shouldForceFallbackToTransaction({
      dexId: 'pumpswap',
      baseMint: 'mint-base',
      quoteMint: 'So11111111111111111111111111111111111111112',
      poolProgram: PUMP_SWAP_PROGRAM,
    })).toBe(true);
  });

  it('forces transaction fallback for Raydium CPMM pools', () => {
    expect(shouldForceFallbackToTransaction({
      dexId: 'raydium',
      baseMint: 'mint-base',
      quoteMint: 'So11111111111111111111111111111111111111112',
      poolProgram: RAYDIUM_CPMM_PROGRAM,
    })).toBe(true);
  });

  it('forces transaction fallback for Meteora pools', () => {
    expect(shouldForceFallbackToTransaction({
      dexId: 'meteora',
      baseMint: 'mint-base',
      quoteMint: 'So11111111111111111111111111111111111111112',
      poolProgram: METEORA_DLMM_PROGRAM,
    })).toBe(true);
  });

  it('identifies likely PumpSwap fallback logs and skips noisy ones', () => {
    expect(isLikelyPumpSwapFallbackLog([
      'Program ComputeBudget111111111111111111111111111111 invoke [1]',
      'Program FsU1rcaEC361jBr9JE5wm7bpWRSTYeAMN4R2MCs11rNF invoke [1]',
      'Program log: pi: 1, sbps: -121, asbps: -121, cbbps: 75, d: 0',
    ])).toBe(true);

    expect(isLikelyPumpSwapFallbackLog([
      'Program 11111111111111111111111111111111 invoke [1]',
      'Program PrntZBCXvR3VPW1cG8kxqASXCnQhmJpP6FEe3r4sA5g invoke [1]',
      'Program log: No arbitrage...',
    ])).toBe(false);
  });

  it('falls back to token and lamport deltas when parsing from a transaction', () => {
    const parsed = parseSwapFromTransaction({
      blockTime: 1_700_000_100,
      meta: {
        err: null,
        fee: 5_000,
        innerInstructions: [],
        loadedAddresses: { readonly: [], writable: [] },
        logMessages: ['Program log: swap'],
        postBalances: [900_000_000, 0],
        postTokenBalances: [{
          accountIndex: 1,
          mint: 'mint-1',
          owner: 'owner-1',
          programId: 'token-program',
          uiTokenAmount: { amount: '1500', decimals: 3, uiAmount: 1.5, uiAmountString: '1.5' },
        }],
        preBalances: [1_000_000_000, 0],
        preTokenBalances: [{
          accountIndex: 1,
          mint: 'mint-1',
          owner: 'owner-1',
          programId: 'token-program',
          uiTokenAmount: { amount: '0', decimals: 3, uiAmount: 0, uiAmountString: '0' },
        }],
        rewards: [],
        status: { Ok: null },
      },
      slot: 1,
      transaction: {
        message: {
          accountKeys: [],
          instructions: [],
          recentBlockhash: 'hash',
        },
        signatures: ['sig-2'],
      },
    } as any, {
      poolAddress: 'pool-1',
      signature: 'sig-2',
      slot: 456,
    });

    expect(parsed).toMatchObject({
      pool: 'pool-1',
      signature: 'sig-2',
      side: 'buy',
      amountBase: 1.5,
      amountQuote: 0.1,
      priceNative: 0.1 / 1.5,
      slot: 456,
      source: 'transaction',
    });
  });

  it('does not use generic log parsing when pool metadata is present but specialized parsing fails', () => {
    const parsed = tryParseSwapFromLogs([
      'Program log: side=buy',
      'Program log: base_amount=4472054486131',
      'Program log: quote_amount=3086451325',
    ], {
      poolAddress: 'pool-1',
      signature: 'sig-meta-log',
      slot: 999,
      timestamp: 1_700_000_300,
      poolMetadata: {
        dexId: 'raydium',
        baseMint: 'mint-base',
        quoteMint: 'So11111111111111111111111111111111111111112',
        baseDecimals: 6,
        quoteDecimals: 9,
        poolProgram: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      },
    });

    expect(parsed).toBeNull();
  });

  it('does not use heuristic transaction parsing when pool metadata is present but mint deltas do not match', () => {
    const parsed = parseSwapFromTransaction({
      blockTime: 1_700_000_400,
      meta: {
        err: null,
        fee: 5_000,
        innerInstructions: [],
        loadedAddresses: { readonly: [], writable: [] },
        logMessages: ['Program log: swap'],
        postBalances: [900_000_000, 0],
        postTokenBalances: [{
          accountIndex: 1,
          mint: 'other-mint',
          owner: 'owner-1',
          programId: 'token-program',
          uiTokenAmount: { amount: '1500', decimals: 3, uiAmount: 1.5, uiAmountString: '1.5' },
        }],
        preBalances: [1_000_000_000, 0],
        preTokenBalances: [{
          accountIndex: 1,
          mint: 'other-mint',
          owner: 'owner-1',
          programId: 'token-program',
          uiTokenAmount: { amount: '0', decimals: 3, uiAmount: 0, uiAmountString: '0' },
        }],
        rewards: [],
        status: { Ok: null },
      },
      slot: 2,
      transaction: {
        message: {
          accountKeys: [],
          instructions: [],
          recentBlockhash: 'hash',
        },
        signatures: ['sig-meta-tx'],
      },
    } as any, {
      poolAddress: 'pool-1',
      signature: 'sig-meta-tx',
      slot: 999,
      poolMetadata: {
        dexId: 'raydium',
        baseMint: 'mint-base',
        quoteMint: 'So11111111111111111111111111111111111111112',
        baseDecimals: 6,
        quoteDecimals: 9,
        poolProgram: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      },
    });

    expect(parsed).toBeNull();
  });

  it('uses raw token amounts to avoid float dust false positives with pool metadata', () => {
    const parsed = parseSwapFromTransaction({
      blockTime: 1_700_000_500,
      meta: {
        err: null,
        fee: 5_000,
        innerInstructions: [],
        loadedAddresses: { readonly: [], writable: [] },
        logMessages: ['Program log: swap'],
        postBalances: [],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: 'mint-base',
            owner: 'owner-1',
            programId: 'token-program',
            uiTokenAmount: {
              amount: '10000000000000000',
              decimals: 9,
              uiAmount: 10000000,
              uiAmountString: '10000000',
            },
          },
          {
            accountIndex: 2,
            mint: 'mint-base',
            owner: 'owner-2',
            programId: 'token-program',
            uiTokenAmount: {
              amount: '2',
              decimals: 9,
              uiAmount: 0.000000002,
              uiAmountString: '0.000000002',
            },
          },
          {
            accountIndex: 3,
            mint: 'mint-quote',
            owner: 'owner-3',
            programId: 'token-program',
            uiTokenAmount: {
              amount: '750000000',
              decimals: 9,
              uiAmount: 0.75,
              uiAmountString: '0.75',
            },
          },
        ],
        preBalances: [],
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: 'mint-base',
            owner: 'owner-1',
            programId: 'token-program',
            uiTokenAmount: {
              amount: '10000000000000001',
              decimals: 9,
              uiAmount: 10000000.000000002,
              uiAmountString: '10000000.000000001',
            },
          },
          {
            accountIndex: 2,
            mint: 'mint-base',
            owner: 'owner-2',
            programId: 'token-program',
            uiTokenAmount: {
              amount: '1',
              decimals: 9,
              uiAmount: 0.000000001,
              uiAmountString: '0.000000001',
            },
          },
          {
            accountIndex: 3,
            mint: 'mint-quote',
            owner: 'owner-3',
            programId: 'token-program',
            uiTokenAmount: {
              amount: '1000000000',
              decimals: 9,
              uiAmount: 1,
              uiAmountString: '1',
            },
          },
        ],
        rewards: [],
        status: { Ok: null },
      },
      slot: 3,
      transaction: {
        message: {
          accountKeys: [],
          instructions: [],
          recentBlockhash: 'hash',
        },
        signatures: ['sig-raw-delta'],
      },
    } as any, {
      poolAddress: 'pool-1',
      signature: 'sig-raw-delta',
      slot: 1_000,
      poolMetadata: {
        dexId: 'raydium',
        baseMint: 'mint-base',
        quoteMint: 'mint-quote',
        baseDecimals: 9,
        quoteDecimals: 9,
        poolProgram: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      },
    });

    expect(parsed).toBeNull();
  });

  it('marks router and explicit swap logs as fallback candidates', () => {
    expect(shouldFallbackToTransaction([
      'Program routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS invoke [1]',
      'Program log: process_swap_base_in_with_user_account:RouteSwapBaseInArgs { amount_in: 100 }',
    ])).toBe(true);

    expect(shouldFallbackToTransaction([
      'Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [2]',
      'Program log: ray_log: AAAA',
    ])).toBe(true);
  });

  it('skips opaque logs that do not look like swaps', () => {
    expect(shouldFallbackToTransaction([
      'Program HVi6VyyLvTtFTA8f8atavxVjUKi8WjmnydfKgoZKzt7H invoke [1]',
      'Program HVi6VyyLvTtFTA8f8atavxVjUKi8WjmnydfKgoZKzt7H success',
    ])).toBe(false);
  });
});

function encodePumpInstruction(discriminator: number[], first: bigint, second: bigint): string {
  const buffer = Buffer.alloc(24);
  Buffer.from(discriminator).copy(buffer, 0);
  buffer.writeBigUInt64LE(first, 8);
  buffer.writeBigUInt64LE(second, 16);
  return bs58.encode(buffer);
}
