/**
 * KOL swap pool extractor tests (2026-06-10, coverage repair lever 1).
 * 핵심 계약: DEX instruction 이 tokenMint 의 token account 를 실제로 만진 경우에만
 * 프로그램별 인덱스로 pool 을 추출하고, 미지원 프로그램은 wsSupported=false 로 표시.
 */
import { extractKolSwapPool, type ParsedTxLike } from '../src/realtime/kolSwapPoolExtractor';
import {
  ORCA_WHIRLPOOL_PROGRAM,
  RAYDIUM_V4_PROGRAM,
} from '../src/realtime/swapParser';
import { PUMP_SWAP_PROGRAM } from '../src/realtime/pumpSwapParser';
import { PUMP_FUN_BONDING_CURVE_PROGRAM } from '../src/realtime/migrationEventDetector';

const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TySNcWxMyWCqXgDLGmfcHr';

// base58-safe fixture key 생성 (0/O/I/l 제외 문자만 사용)
const TOKEN_MINT = 'Mint' + 'x'.repeat(40);
const WALLET = 'WaQQet' + 'x'.repeat(38);
const POOL = 'Poo' + 'z'.repeat(41);
const USER_TOKEN_ACCOUNT = 'UserTok' + 'x'.repeat(37);
const POOL_TOKEN_VAULT = 'Vau1t' + 'x'.repeat(39);
const OTHER_ACCOUNT = 'And' + 'y'.repeat(41);

const pk = (value: string) => ({ toBase58: () => value });

function buildTx(options: {
  topInstructions: Array<{ program: string; accounts: string[] }>;
  innerInstructions?: Array<{ program: string; accounts: string[] }>;
  tokenBalanceAccounts?: string[];
}): ParsedTxLike {
  // accountKeys 는 instruction 계정 + token balance 계정의 합집합으로 구성
  const allAccounts = new Set<string>([
    ...options.topInstructions.flatMap((ix) => ix.accounts),
    ...(options.innerInstructions ?? []).flatMap((ix) => ix.accounts),
    ...(options.tokenBalanceAccounts ?? [USER_TOKEN_ACCOUNT, POOL_TOKEN_VAULT]),
  ]);
  const accountKeys = [...allAccounts].map((value) => ({ pubkey: pk(value) }));
  const indexOf = (value: string) => [...allAccounts].indexOf(value);
  const balanceAccounts = options.tokenBalanceAccounts ?? [USER_TOKEN_ACCOUNT, POOL_TOKEN_VAULT];
  return {
    transaction: {
      message: {
        accountKeys,
        instructions: options.topInstructions.map((ix) => ({
          programId: pk(ix.program),
          accounts: ix.accounts.map(pk),
        })),
      },
    },
    meta: {
      innerInstructions: options.innerInstructions
        ? [{ instructions: options.innerInstructions.map((ix) => ({ programId: pk(ix.program), accounts: ix.accounts.map(pk) })) }]
        : [],
      preTokenBalances: [],
      postTokenBalances: balanceAccounts.map((account) => ({
        accountIndex: indexOf(account),
        mint: TOKEN_MINT,
      })),
    },
  };
}

describe('extractKolSwapPool', () => {
  it('extracts a pumpswap pool from a direct top-level swap (index 0)', () => {
    const tx = buildTx({
      topInstructions: [{
        program: PUMP_SWAP_PROGRAM,
        accounts: [POOL, WALLET, OTHER_ACCOUNT, TOKEN_MINT, USER_TOKEN_ACCOUNT, POOL_TOKEN_VAULT],
      }],
    });
    expect(extractKolSwapPool(tx, TOKEN_MINT, WALLET)).toEqual({
      poolAddress: POOL,
      dexProgram: PUMP_SWAP_PROGRAM,
      dexId: 'pumpswap',
      routeKind: 'direct_pool',
      wsSupported: true,
    });
  });

  it('extracts a raydium v4 pool from a Jupiter inner instruction (aggregator route)', () => {
    const tx = buildTx({
      topInstructions: [{ program: JUPITER_V6, accounts: [WALLET, OTHER_ACCOUNT] }],
      innerInstructions: [{
        program: RAYDIUM_V4_PROGRAM,
        // [token_program(여기선 임의), amm=POOL, ...] + token account 포함
        accounts: [OTHER_ACCOUNT, POOL, USER_TOKEN_ACCOUNT, POOL_TOKEN_VAULT],
      }],
    });
    expect(extractKolSwapPool(tx, TOKEN_MINT, WALLET)).toEqual({
      poolAddress: POOL,
      dexProgram: RAYDIUM_V4_PROGRAM,
      dexId: 'raydium',
      routeKind: 'aggregator',
      wsSupported: true,
    });
  });

  it('marks pump.fun bonding curve pools as not WS-supported (bonding_curve = index 3)', () => {
    const tx = buildTx({
      topInstructions: [{
        program: PUMP_FUN_BONDING_CURVE_PROGRAM,
        // [global, fee_recipient, mint, bonding_curve, associated_bonding_curve(token acct), user_ata]
        accounts: [OTHER_ACCOUNT, OTHER_ACCOUNT, TOKEN_MINT, POOL, POOL_TOKEN_VAULT, USER_TOKEN_ACCOUNT],
      }],
    });
    expect(extractKolSwapPool(tx, TOKEN_MINT, WALLET)).toMatchObject({
      poolAddress: POOL,
      dexId: 'pumpfun',
      wsSupported: false,
    });
  });

  it('skips whirlpool swapV2 memo program at index 2 and picks the pool at index 4', () => {
    const tx = buildTx({
      topInstructions: [{
        program: ORCA_WHIRLPOOL_PROGRAM,
        // swapV2: [token_program_a, token_program_b, memo, token_authority, whirlpool]
        accounts: [OTHER_ACCOUNT, OTHER_ACCOUNT, MEMO_PROGRAM, WALLET, POOL, USER_TOKEN_ACCOUNT],
      }],
    });
    expect(extractKolSwapPool(tx, TOKEN_MINT, WALLET)).toMatchObject({
      poolAddress: POOL,
      dexId: 'orca',
    });
  });

  it('rejects DEX instructions that never touch a token account of the mint', () => {
    const tx = buildTx({
      topInstructions: [{
        program: PUMP_SWAP_PROGRAM,
        // POOL 은 있으나 이 mint 의 token account 가 instruction 계정에 없음
        accounts: [POOL, WALLET, OTHER_ACCOUNT],
      }],
    });
    expect(extractKolSwapPool(tx, TOKEN_MINT, WALLET)).toBeNull();
  });

  it('returns null without DEX instructions, token balances, or meta', () => {
    expect(extractKolSwapPool(null, TOKEN_MINT, WALLET)).toBeNull();
    const noDex = buildTx({ topInstructions: [{ program: JUPITER_V6, accounts: [WALLET, USER_TOKEN_ACCOUNT] }] });
    expect(extractKolSwapPool(noDex, TOKEN_MINT, WALLET)).toBeNull();
    const noBalances = buildTx({
      topInstructions: [{ program: PUMP_SWAP_PROGRAM, accounts: [POOL, USER_TOKEN_ACCOUNT] }],
      tokenBalanceAccounts: [],
    });
    expect(extractKolSwapPool(noBalances, TOKEN_MINT, WALLET)).toBeNull();
  });

  it('never returns the mint, wallet, or a token account itself as the pool', () => {
    const tx = buildTx({
      topInstructions: [{
        program: PUMP_SWAP_PROGRAM,
        // index 0 이 token account 인 비정상 layout — pool 로 오인하면 안 됨
        accounts: [USER_TOKEN_ACCOUNT, WALLET, TOKEN_MINT],
      }],
    });
    expect(extractKolSwapPool(tx, TOKEN_MINT, WALLET)).toBeNull();
  });
});
