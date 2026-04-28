/**
 * KOL Classification Helper (Phase 0A, 2026-04-28)
 *
 * Why: Phase 1 (style-aware insider_exit) 의 효과는 KOL DB 의 `lane_role` + `trading_style`
 *   분류에 비례. 39 active KOL 중 28명 (72%) notes 에 style 키워드 보유 / 11명 미분류.
 *
 * 본 script 는 wallets.json 의 `notes` 텍스트 → `lane_role / trading_style / avg_hold_days /
 *   avg_ticket_sol` 추정값을 출력. 운영자 review 후 manual edit 필요 (자동 수정 안 함).
 *
 * Usage:
 *   ts-node scripts/kol-classify-helper.ts          → 모든 active KOL 의 추정값 + 미분류 11명 highlight
 *   ts-node scripts/kol-classify-helper.ts --json   → JSON dump (자동화 hook)
 *   ts-node scripts/kol-classify-helper.ts --diff   → wallets.json 의 기존 분류 vs 추정 diff
 *
 * 안전:
 *   - wallets.json 직접 수정 안 함 (read-only)
 *   - 운영자가 review 후 jq 또는 직접 편집
 *   - 미분류 11명 manual decision 필수 (notes 가 모호한 경우)
 */
import { readFile } from 'fs/promises';
import path from 'path';

interface KolWallet {
  id: string;
  tier: 'S' | 'A' | 'B';
  notes: string;
  is_active: boolean;
  lane_role?: 'copy_core' | 'discovery_canary' | 'observer' | 'unknown';
  trading_style?: 'longhold' | 'swing' | 'scalper' | 'unknown';
  avg_hold_days?: number;
  avg_ticket_sol?: number;
  recent_30d_pnl_sol?: number;
}

interface ClassificationGuess {
  laneRole: KolWallet['lane_role'];
  tradingStyle: KolWallet['trading_style'];
  avgHoldDays?: number;
  avgTicketSol?: number;
  confidence: 'high' | 'medium' | 'low';
  matchedKeywords: string[];
}

/**
 * Notes 텍스트 → 추정 분류.
 * 우선순위: 명시 키워드 → 행동 패턴 → tier-기반 fallback.
 */
function inferClassification(wallet: KolWallet): ClassificationGuess {
  const notes = wallet.notes.toLowerCase();
  const matched: string[] = [];

  // 1) Lane role — 명시 키워드 우선
  let laneRole: KolWallet['lane_role'] = 'unknown';
  if (/copy[\s-]?core/i.test(notes)) { laneRole = 'copy_core'; matched.push('copy_core'); }
  else if (/discovery|canary/i.test(notes)) { laneRole = 'discovery_canary'; matched.push('discovery_canary'); }
  else if (/observer|benchmark|watch/i.test(notes)) { laneRole = 'observer'; matched.push('observer'); }

  // 2) Trading style — hold time keyword
  let tradingStyle: KolWallet['trading_style'] = 'unknown';
  let avgHoldDays: number | undefined;
  // 한국어 + 영어 keyword
  const longholdMatch = notes.match(/(\d+)\s*(?:일|day|days)/);
  const longholdSecMatch = notes.match(/(\d+)\s*(?:시간|hour|h\b)/);
  const scalpMatch = /(?:scalp|5\s*분|단기|flip|초단기)/.test(notes);
  const swingMatch = /(?:swing|중기|day[-\s]?trade)/.test(notes);
  const longholdMatchKw = /(?:longhold|long[-\s]?hold|장기|보유)/.test(notes);

  if (longholdMatch) {
    avgHoldDays = parseInt(longholdMatch[1], 10);
    if (avgHoldDays >= 1) {
      tradingStyle = 'longhold';
      matched.push(`hold_${avgHoldDays}days`);
    }
  } else if (longholdSecMatch) {
    const hours = parseInt(longholdSecMatch[1], 10);
    avgHoldDays = hours / 24;
    if (hours >= 24) tradingStyle = 'longhold';
    else if (hours >= 4) tradingStyle = 'swing';
    else tradingStyle = 'scalper';
    matched.push(`hold_${hours}h`);
  } else if (scalpMatch) {
    tradingStyle = 'scalper';
    avgHoldDays = 0.05;  // ~1h
    matched.push('scalper_kw');
  } else if (swingMatch) {
    tradingStyle = 'swing';
    avgHoldDays = 0.5;
    matched.push('swing_kw');
  } else if (longholdMatchKw) {
    tradingStyle = 'longhold';
    matched.push('longhold_kw');
  }

  // 3) Lane role fallback — style 만 있고 lane 없으면 추론
  if (laneRole === 'unknown') {
    if (tradingStyle === 'longhold') laneRole = 'copy_core';
    else if (tradingStyle === 'scalper') laneRole = 'discovery_canary';
    else if (tradingStyle === 'swing') laneRole = 'copy_core';
  }

  // 4) avg ticket sol — notes 에서 ticket 정보 추출
  let avgTicketSol: number | undefined;
  const ticketMatch = notes.match(/(?:ticket|티켓)\s*(?:~|약)?\s*(\d+(?:\.\d+)?)\s*sol/i);
  if (ticketMatch) {
    avgTicketSol = parseFloat(ticketMatch[1]);
    matched.push(`ticket_${avgTicketSol}SOL`);
  }

  // 5) Confidence — 매칭 정도
  let confidence: 'high' | 'medium' | 'low' = 'low';
  if (matched.length >= 3 || (laneRole !== 'unknown' && tradingStyle !== 'unknown' && avgHoldDays != null)) {
    confidence = 'high';
  } else if (matched.length >= 1) {
    confidence = 'medium';
  }

  return { laneRole, tradingStyle, avgHoldDays, avgTicketSol, confidence, matchedKeywords: matched };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outputJson = args.includes('--json');
  const showDiff = args.includes('--diff');

  const dbPath = path.resolve(process.cwd(), 'data/kol/wallets.json');
  const raw = await readFile(dbPath, 'utf8');
  const db = JSON.parse(raw) as { kols: KolWallet[] };

  const active = db.kols.filter((k) => k.is_active);
  const results = active.map((wallet) => ({
    wallet,
    guess: inferClassification(wallet),
  }));

  const unclassified = results.filter((r) => !r.wallet.lane_role && !r.wallet.trading_style);
  const lowConfidence = results.filter((r) => r.guess.confidence === 'low');

  if (outputJson) {
    console.log(JSON.stringify({
      total: active.length,
      unclassified_count: unclassified.length,
      low_confidence_count: lowConfidence.length,
      results: results.map((r) => ({
        id: r.wallet.id,
        tier: r.wallet.tier,
        existing: {
          lane_role: r.wallet.lane_role,
          trading_style: r.wallet.trading_style,
          avg_hold_days: r.wallet.avg_hold_days,
          avg_ticket_sol: r.wallet.avg_ticket_sol,
        },
        suggested: r.guess,
      })),
    }, null, 2));
    return;
  }

  // Human-readable report
  console.log(`\n=== KOL Classification Helper (Phase 0A) ===`);
  console.log(`Active KOLs: ${active.length}`);
  console.log(`  fully classified (lane + style 모두 set):   ${results.filter((r) => r.wallet.lane_role && r.wallet.trading_style).length}`);
  console.log(`  partially classified (lane OR style set):  ${results.filter((r) => (r.wallet.lane_role || r.wallet.trading_style) && !(r.wallet.lane_role && r.wallet.trading_style)).length}`);
  console.log(`  unclassified (둘 다 set 안 됨):            ${unclassified.length}`);
  console.log();

  console.log(`=== 추천 분류 (high confidence — notes 키워드 충분) ===`);
  for (const r of results.filter((x) => x.guess.confidence === 'high' && (!x.wallet.lane_role || !x.wallet.trading_style))) {
    console.log(`  ${r.wallet.id} (${r.wallet.tier}): lane=${r.guess.laneRole} style=${r.guess.tradingStyle} hold=${r.guess.avgHoldDays ?? '?'}d ticket=${r.guess.avgTicketSol ?? '?'}SOL  [matched: ${r.guess.matchedKeywords.join(', ')}]`);
  }
  console.log();

  console.log(`=== 미분류 / low confidence — 운영자 manual review 필수 (${unclassified.length + lowConfidence.length}건) ===`);
  for (const r of [...unclassified, ...lowConfidence].filter((v, i, a) => a.findIndex((x) => x.wallet.id === v.wallet.id) === i)) {
    const notesPreview = r.wallet.notes.length > 100 ? r.wallet.notes.slice(0, 100) + '...' : r.wallet.notes;
    console.log(`  ${r.wallet.id} (${r.wallet.tier}):`);
    console.log(`    notes: ${notesPreview}`);
    console.log(`    suggested (low conf): lane=${r.guess.laneRole} style=${r.guess.tradingStyle}  [matched: ${r.guess.matchedKeywords.join(', ') || 'none'}]`);
  }
  console.log();

  if (showDiff) {
    console.log(`=== Diff: existing vs suggested (분류 mismatch) ===`);
    for (const r of results) {
      const existing = `${r.wallet.lane_role ?? '?'}/${r.wallet.trading_style ?? '?'}`;
      const suggested = `${r.guess.laneRole}/${r.guess.tradingStyle}`;
      if (r.wallet.lane_role && r.wallet.trading_style && existing !== suggested) {
        console.log(`  ${r.wallet.id}: existing=${existing} → suggested=${suggested}  [matched: ${r.guess.matchedKeywords.join(', ')}]`);
      }
    }
  }

  console.log(`\n=== 운영자 액션 ===`);
  console.log(`1. data/kol/wallets.json 의 각 active KOL 에 다음 fields 추가:`);
  console.log(`     "lane_role": "copy_core" | "discovery_canary" | "observer"`);
  console.log(`     "trading_style": "longhold" | "swing" | "scalper"`);
  console.log(`     "avg_hold_days": <number>`);
  console.log(`     "avg_ticket_sol": <number>`);
  console.log(`2. 위 'high confidence' 추천은 notes 와 정합. 단 운영자 review 권장.`);
  console.log(`3. '미분류 / low confidence' 는 Solscan/Kolscan 직접 보고 결정 필수.`);
  console.log(`4. 분류 후: ts-node scripts/kol-classify-helper.ts --diff 로 정합 확인.`);
  console.log(`5. ts-node scripts/env-catalog.ts --check 로 schema validation.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
