/**
 * KOL Swap Pool Extractor (2026-06-10, coverage repair lever 1)
 *
 * Why: edge-audit 07 — KOL candle coverage 1.81% 의 최대 버킷 (no_pairs 73.4%) 은
 * fresh pump.fun 토큰이 DexScreener 에 미색인이라 pair resolution 이 실패하는 것이었다.
 * 그런데 KOL swap tx 자체가 pool 주소를 이미 담고 있다 — getParsedTransaction 결과의
 * DEX instruction 계정 배열에서 pool 을 추출하면 DexScreener 를 거치지 않고
 * `kol_tx_pool` 직행 구독이 가능하다 (resolver 의 1순위 경로, 기존엔 dead).
 *
 * 안전 장치:
 *  - 해당 instruction 이 실제로 이 tokenMint 의 token account 를 만진 경우에만 추출
 *    (계정 인덱스 가정이 어긋난 프로그램 변형에서 임의 계정을 pool 로 오인하는 것 방지).
 *  - 추출된 계정이 mint/wallet/시스템 계정이면 기각.
 *  - pump.fun bonding curve 는 추출은 하되 `wsSupported=false` — WS candle parser 가
 *    미지원이므로 구독 gate 에서 차단 (provenance 기록 + lever 2 착륙 시 자동 활성).
 *
 * Pure function — 네트워크/사이드이펙트 없음.
 */
import {
  ORCA_WHIRLPOOL_PROGRAM,
  PUMP_SWAP_PROGRAM,
  RAYDIUM_CLMM_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  RAYDIUM_V4_PROGRAM,
} from './swapParser';
import {
  METEORA_DAMM_V1_PROGRAM,
  METEORA_DAMM_V2_PROGRAM,
  METEORA_DLMM_PROGRAM,
} from './meteoraPrograms';
import { PUMP_FUN_BONDING_CURVE_PROGRAM } from './migrationEventDetector';
import { isWsSupportedPoolProgram } from './realtimeEligibility';
import { SOL_MINT } from '../utils/constants';

export interface KolSwapPoolExtraction {
  poolAddress: string;
  dexProgram: string;
  dexId: string;
  routeKind: 'direct_pool' | 'aggregator';
  /** WS candle parser 가 이 pool 의 swap 을 해석 가능한가 (구독 가치 여부) */
  wsSupported: boolean;
}

// web3.js 타입에 대한 구조적 부분집합 — 테스트가 PublicKey 없이 fixture 를 만들 수 있게.
interface PubkeyLike { toBase58(): string }
interface InstructionLike {
  programId: PubkeyLike;
  /** PartiallyDecodedInstruction 만 보유 — parsed(spl-token 등) instruction 은 skip */
  accounts?: PubkeyLike[];
}
export interface ParsedTxLike {
  transaction: { message: { accountKeys: Array<{ pubkey: PubkeyLike }>; instructions: InstructionLike[] } };
  meta: {
    innerInstructions?: Array<{ instructions: InstructionLike[] }> | null;
    preTokenBalances?: Array<{ accountIndex: number; mint: string }> | null;
    postTokenBalances?: Array<{ accountIndex: number; mint: string }> | null;
  } | null;
}

// 프로그램별 swap instruction 의 pool 계정 인덱스 (변형 layout 은 후보 복수).
// 출처: 각 프로그램 IDL 의 swap 계정 순서. whirlpool 은 swap(2) / swapV2(4) 두 layout.
const POOL_ACCOUNT_TABLE: ReadonlyArray<{ program: string; dexId: string; indices: number[] }> = [
  { program: RAYDIUM_V4_PROGRAM, dexId: 'raydium', indices: [1] },
  { program: RAYDIUM_CLMM_PROGRAM, dexId: 'raydium', indices: [2] },
  { program: RAYDIUM_CPMM_PROGRAM, dexId: 'raydium', indices: [3] },
  { program: ORCA_WHIRLPOOL_PROGRAM, dexId: 'orca', indices: [2, 4] },
  { program: METEORA_DLMM_PROGRAM, dexId: 'meteora', indices: [0] },
  { program: METEORA_DAMM_V1_PROGRAM, dexId: 'meteora', indices: [0] },
  { program: METEORA_DAMM_V2_PROGRAM, dexId: 'meteora', indices: [1] },
  { program: PUMP_SWAP_PROGRAM, dexId: 'pumpswap', indices: [0] },
  { program: PUMP_FUN_BONDING_CURVE_PROGRAM, dexId: 'pumpfun', indices: [3] },
];
const POOL_TABLE_BY_PROGRAM = new Map(POOL_ACCOUNT_TABLE.map((entry) => [entry.program, entry]));

const JUPITER_AGGREGATOR_PROGRAMS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // Jupiter v4 (legacy)
]);

// pool 일 수 없는 계정 — layout 변형에서 인덱스가 어긋났을 때의 오인 방지.
const KNOWN_NON_POOL_ACCOUNTS = new Set([
  SOL_MINT,
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // ATA program
  'MemoSq4gqABAXKb96qnH8TySNcWxMyWCqXgDLGmfcHr', // Memo
  '11111111111111111111111111111111', // System
  ...POOL_ACCOUNT_TABLE.map((entry) => entry.program),
  ...JUPITER_AGGREGATOR_PROGRAMS,
]);

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function extractKolSwapPool(
  tx: ParsedTxLike | null,
  tokenMint: string,
  walletAddress: string
): KolSwapPoolExtraction | null {
  if (!tx?.meta) return null;
  const accountKeys = tx.transaction.message.accountKeys;

  // 이 tokenMint 의 token account pubkey 집합 — DEX instruction 이 실제로
  // 이 토큰을 만졌는지 검증하는 기준 (pre/post 양쪽 합집합).
  const tokenAccounts = new Set<string>();
  for (const balance of [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]) {
    if (balance.mint !== tokenMint) continue;
    const key = accountKeys[balance.accountIndex]?.pubkey;
    if (key) tokenAccounts.add(key.toBase58());
  }
  if (tokenAccounts.size === 0) return null;

  // top-level 우선, 그 다음 inner (aggregator route 의 실제 DEX hop 은 inner 에 위치).
  const ordered: InstructionLike[] = [
    ...tx.transaction.message.instructions,
    ...(tx.meta.innerInstructions ?? []).flatMap((group) => group.instructions),
  ];

  let sawAggregator = false;
  let found: { pool: string; entry: { program: string; dexId: string } } | null = null;
  for (const ix of ordered) {
    const programId = ix.programId.toBase58();
    if (JUPITER_AGGREGATOR_PROGRAMS.has(programId)) sawAggregator = true;
    if (found) continue; // aggregator 여부 판별 위해 순회는 계속
    const entry = POOL_TABLE_BY_PROGRAM.get(programId);
    if (!entry || !ix.accounts || ix.accounts.length === 0) continue;
    const ixAccounts = ix.accounts.map((account) => account.toBase58());
    // 검증: 이 instruction 이 tokenMint 의 token account 를 하나 이상 포함해야 한다.
    if (!ixAccounts.some((account) => tokenAccounts.has(account))) continue;
    for (const index of entry.indices) {
      const candidate = ixAccounts[index];
      if (!candidate || !BASE58_RE.test(candidate)) continue;
      if (candidate === tokenMint || candidate === walletAddress) continue;
      if (KNOWN_NON_POOL_ACCOUNTS.has(candidate)) continue;
      if (tokenAccounts.has(candidate)) continue; // pool state 는 token account 가 아니다
      found = { pool: candidate, entry };
      break;
    }
  }

  if (!found) return null;
  return {
    poolAddress: found.pool,
    dexProgram: found.entry.program,
    dexId: found.entry.dexId,
    routeKind: sawAggregator ? 'aggregator' : 'direct_pool',
    wsSupported: isWsSupportedPoolProgram(found.entry.program),
  };
}
