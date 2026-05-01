# Research Ledger Unification — ADR (2026-05-01)

> Status: 🟡 인프라 완성 / S3 보류 — S1 (ADR + types + fixtures + validator) + S2 (writer + quarantine) + S2.5 (Codex 보정 7건) **완료**. **S3 (dual-write wiring) 보류** (사유 + 재개 trigger §13). S4 (audit) / S5 (report) / S6 (deprecation) S3 후 follow-up.
> Authority: 본 문서는 schema v1 동결 기준. 변경 시 v2 ADR 별도 작성 + migration plan 필수.
> 상위: `mission-refinement-2026-04-21.md` (사명 §3 200-trade gate evidence 정합), `kol-academic-report-integration-2026-04-30.md` (DSR / cohort 측정 정합).

## §1. Goal / Non-goal

**Goal**
- 분석 truth 단일화 — `walletDeltaSol` (live) / `simulatedNetSol` (paper) 을 명시적으로 분리한 정합 dataset 으로 사명 §3 의 7 핵심 질문에 답할 수 있는 인프라.
- append-only JSONL primary research source, DB 보조.
- reject / no-trigger / cancel 까지 포함하는 end-to-end funnel.

**Non-goal**
- Postgres 도입 (필요 시 v2 별도 ADR).
- 옛 12 ledger 즉시 deprecation (Phase 5 acceptance 통과 후 결정).
- mission ADR 개정 (Phase 4 결과 후 follow-up).

## §2. Why now

- 현재 12+ jsonl 분산 — `kol-paper-trades` / `kol-live-trades` / `executed-buys` / `executed-sells` / `kol-policy-decisions` / `missed-alpha` / `kol-shadow-tx` / `kol-tx` / `kol-partial-takes` / `token-quality-observations` / `admission-skips-dex` / `pair-quarantine` / ...
- "어느 ledger 가 truth 인가" 가 매번 흔들림 → DSR / winner-kill / decay 분석마다 다른 join 로직.
- 사명 §3 의 200-trade gate / 5x winner 분포 측정은 reproducibility 필수 — 옛 ledger 들의 schema drift 위험.
- Codex 외부 피드백 (2026-05-01): "운영 연구 DB" 가 지금 필요하고, 처음부터 DB 보다 append-only JSONL standard truth 가 맞음.

## §3. Schema v1 — 동결 (변경 시 v2 ADR + migration)

### §3.1 `trade-outcome/v1`

paper + live 통합. `mode` 필드로 cohort 분리. PnL truth 와 price source 를 **분리** (Codex M2 보정).

```typescript
interface TradeOutcomeV1 {
  schemaVersion: "trade-outcome/v1";

  // ─── Identity ───
  recordId: string;                  // unique row id (UUID v4 또는 sha1(positionId|exitAtIso|emitNonce))
  positionId: string;                // join key (kol-call-funnel 의 entry_open positionId 와 정합)
  sessionId?: string;                // 재시작 사이 분리 — current-session.json 의 id 참조
  tokenMint: string;
  mode: "paper" | "live";
  wallet?: string;                   // live 시 'main' / 'sandbox' / etc

  // ─── KOL cohort (Codex M5 — participatingKols 필수, kols 는 derived) ───
  armName: string;                   // e.g. kol_hunter_smart_v3
  parameterVersion: string;
  participatingKols: Array<{
    id: string;
    tier: "S" | "A" | "B";
    timestamp: number;               // epoch ms — 진입 시각
  }>;
  kols: string[];                    // = participatingKols.map(k => k.id) — derived alias
  independentKolCount: number;
  effectiveIndependentCount?: number; // co-buy graph community 기반

  // smart-v3 이전 lane / legacy / swing-v2 / tail 은 nullable (Codex M8)
  kolEntryReason?: string | null;
  kolConvictionLevel?: string | null;
  kolReinforcementCount?: number;

  // ─── Position context (Codex M2 — swing-v2 / tail / partial 보존) ───
  isShadowArm: boolean;
  isTailPosition: boolean;
  parentPositionId: string | null;
  partialTakeRealizedSol: number;        // 0 if no partial
  partialTakeLockedTicketSol: number;    // 0 if no partial
  partialTakeAtSec?: number | null;

  // ─── Pricing / size (Codex M3 — actual vs nominal 분리) ───
  ticketSol: number;                     // config 기준 (의도된 size)
  actualInputSol?: number;               // live: 실 입력 SOL (Jupiter quote 의 inAmount 환산)
  receivedSol?: number;                  // live: sell 후 received (wallet truth 입력)
  solSpentNominal?: number;              // entryPrice * actualQuantity (pnl drift 비교용)
  effectiveTicketSol: number;            // partial 합산 기준 = runner ticket + partialTakeLockedTicket
  entryPrice: number;
  exitPrice: number;
  entrySlippageBps?: number;
  exitSlippageBps?: number;
  entryAdvantagePct?: number;
  buyExecutionMs?: number;
  sellExecutionMs?: number;

  // ─── PnL truth (Codex M2 — pnlTruthSource 분리) ───
  walletDeltaSol: number | null;         // live: 진실, paper: null
  simulatedNetSol: number | null;        // paper: 진실, live: null
  paperModelVersion: string | null;      // paper-only: e.g. 'paperRoundTripCost-v1'
  pnlTruthSource: "wallet_delta" | "paper_simulation";
  netSol: number;                        // mode 별 truth alias (downstream simplicity)
  netPct: number;                        // effective (partial 합산 / effectiveTicketSol)
  dbPnlSol?: number;                     // live only
  dbPnlDriftSol?: number;                // live only — dbPnl - walletDelta

  // ─── Price source (Codex M2 — pnl truth 와 분리) ───
  entryPriceSource?: "jupiter_quote" | "helius_ws" | "wallet_delta" | "kol_signal" | string;
  exitPriceSource?: "jupiter_quote" | "helius_ws" | "wallet_delta" | string;
  trajectoryPriceSource?: "helius_ws" | "jupiter_quote" | "mixed" | string;

  // ─── tx signatures (Codex M4 — audit / replay) ───
  entryTxSignature?: string;
  exitTxSignature?: string;
  dbTradeId?: string;

  // ─── Trajectory (Codex M6 — visit timestamps 보존) ───
  mfePctPeak: number;
  maePct: number;
  holdSec: number;
  exitReason: string;                    // CloseReason
  t1Visited: boolean;                    // = t1VisitAtSec != null (derived)
  t2Visited: boolean;
  t3Visited: boolean;
  t1VisitAtSec: number | null;
  t2VisitAtSec: number | null;
  t3VisitAtSec: number | null;
  actual5xPeak: boolean;                 // mfePctPeak >= 4.0 (5x = +400%)

  // ─── Survival / quality (Decu Phase B 통합) ───
  survivalFlags: string[];
  tokenQualityFlags?: string[];          // tokenQualityInspector 결과
  // Codex L1 — 명칭 단축
  top10HolderPct?: number;
  top1HolderPct?: number;
  top5HolderPct?: number;
  holderHhi?: number;

  // ─── Timestamps ───
  entryAtIso: string;
  exitAtIso: string;
  entryTimeSec: number;
  exitTimeSec: number;
}
```

### §3.2 `kol-call-funnel/v1`

KOL call → observe → reject/cancel → entry → close 의 모든 funnel 이벤트. 거래 안 한 CA / reject 도 기록.

**Codex M1 보정**: `eventId` (deterministic dedupe) / `emitNonce` (process-local uniqueness) / `recordId` (unique row id) **3개 분리**.

```typescript
type FunnelEventType =
  | "kol_call"
  | "pending_open"
  | "survival_reject"
  | "observe_open"
  | "smart_v3_no_trigger"
  | "kol_sell_cancel"
  | "trigger_fire"
  | "entry_open"
  | "entry_reject"
  | "position_close";

interface KolCallFunnelV1 {
  schemaVersion: "kol-call-funnel/v1";

  // ─── Identity (Codex M1 + S1.5 보정 분리) ───
  recordId: string;                      // unique row id (sha1(eventId|emitNonce))
  eventId: string;                       // deterministic dedupe key. **Codex S1.5 보정:**
                                         //   strong key (txSignature OR positionId) 있는 event:
                                         //     sha1(eventType | tokenMint | txSignature | positionId | rejectCategory)
                                         //     ※ bucket 미포함 → 재시작 후 1초 밖에서 같은 sig/positionId 재기록되어도 동일 eventId.
                                         //   strong key 없는 event (kol_call no-tx, smart_v3_no_trigger 등):
                                         //     sha1(eventType | tokenMint | rejectCategory | eventTsMsBucket)  — 1초 burst 흡수.
  emitNonce: string;                     // process-local uniqueness (pid + counter) — dedupe 미사용, debug 용
  emitTsMs: number;
  sessionId?: string;

  // ─── Event ───
  eventType: FunnelEventType;
  tokenMint: string;
  positionId?: string;                   // entry_open 이후만
  txSignature?: string;
  parentPositionId?: string;             // tail / shadow

  // ─── KOL ───
  kolId?: string;                        // kol_call / cancel 시
  kolTier?: "S" | "A" | "B";
  walletAddress?: string;
  action?: "buy" | "sell";
  solAmount?: number;
  isShadowKol?: boolean;                 // inactive KOL (shadow) tx 인지

  // ─── Decision context ───
  armName?: string;
  parameterVersion?: string;
  rejectCategory?: string;
  rejectReason?: string;
  signalSource?: string;                 // e.g. "kol_hunter:decu,dv"

  // ─── Free-form extras (eventType 별) ───
  extras?: Record<string, unknown>;
}
```

### §3.3 Required field 정의 (validator 입력)

| Schema | 필수 (모든 row) | mode-conditional 필수 |
|---|---|---|
| `trade-outcome/v1` | schemaVersion, recordId, positionId, tokenMint, mode, armName, parameterVersion, participatingKols, kols, isShadowArm, isTailPosition, ticketSol, effectiveTicketSol, entryPrice, exitPrice, netSol, netPct, pnlTruthSource, mfePctPeak, maePct, holdSec, exitReason, t1Visited, t2Visited, t3Visited, actual5xPeak, survivalFlags, entryAtIso, exitAtIso, entryTimeSec, exitTimeSec | mode='live' → walletDeltaSol non-null + pnlTruthSource='wallet_delta' + simulatedNetSol=null + paperModelVersion=null + **netSol === walletDeltaSol** (truth alias) / mode='paper' → simulatedNetSol non-null + paperModelVersion non-null + pnlTruthSource='paper_simulation' + walletDeltaSol=null + **netSol === simulatedNetSol** |
| `kol-call-funnel/v1` | schemaVersion, recordId, eventId, emitNonce, emitTsMs, eventType, tokenMint | eventType in (entry_open, position_close) → positionId 필수 / eventType in (survival_reject, entry_reject) → rejectCategory 필수 |

**Codex S1.5 보정 (Major)**:
- `mode` ↔ truth source mismatch 는 **error** (이전 warning). paper 가 walletDeltaSol non-null 또는 live 가 simulatedNetSol non-null 이면 row reject.
- `netSol` 은 mode 별 truth field (walletDeltaSol / simulatedNetSol) 와 **bit-identical** 해야 함. validator 가 `Math.abs(netSol - truth) > 1e-9` 시 error.
- numeric 필드 NaN / Infinity / 음수 size / 0 이하 price 모두 error.
- `participatingKols[i].tier` 가 'S'|'A'|'B' 외면 error / `timestamp` <= 0 이면 error / `survivalFlags[i]` 가 string 아니면 error.

## §4. PnL truth 정책

원칙 (4-29 ground truth 정책 그대로 유지):

| mode | truth field | source | 검증 |
|---|---|---|---|
| `live` | `walletDeltaSol` | sell tx 의 SOL receipt - actualInputSol | `dbPnlDriftSol = dbPnlSol - walletDeltaSol`, |drift| > 0.001 SOL → log warn |
| `paper` | `simulatedNetSol` | `effectiveTicketSol * (netPct - paperRoundTripCostPct)` | `paperModelVersion` 변경 시 backfill 불가 — 새 row 부터 적용 |

**`pnlTruthSource` 필드는 truth source 명시용** — `priceSource` 와 분리됨 (Codex M2). 가격 source 는 `entryPriceSource` / `exitPriceSource` / `trajectoryPriceSource` 별도 필드.

## §5. Cohort 차원 — 7 핵심 질문 매핑

| 질문 | dataset | cohort 차원 | metric (Phase 4 report) |
|---|---|---|---|
| 1. 어떤 KOL 조합이 돈을 버는가 | trade-outcomes | `kols` set (정렬) × `effectiveIndependentCount` | n / mean netSol / 5x rate / DSR |
| 2. 어떤 dev / CA 가 반복 손실 | trade-outcomes ⨝ token-quality observations | `tokenQualityFlags` × dev wallet | n / cum netSol / loss rate |
| 3. pullback vs velocity | trade-outcomes (kolEntryReason 있는 row) | `kolEntryReason × kolConvictionLevel` | n / mean netSol / hold p50 / 5x rate |
| 4. holder concentration % vs 손실 | trade-outcomes | `top10HolderPct` 5% 버킷 | n / mean netSol / loss rate |
| 5. entry advantage % 임계 | trade-outcomes | `entryAdvantagePct` 1% 버킷 | n / mean netSol / mfe peak |
| 6. winner 죽이는 exitReason | trade-outcomes (mfePctPeak ≥ 1) | `exitReason` × `mfePctPeak` 버킷 | winner-kill rate (mfe>1 close yet net < 0.5*mfe) |
| 7. live vs paper drift | trade-outcomes | `mode` 동일 token / KOL pair | netSol drift / fill rate / decision delay |

## §6. Funnel event lifecycle (10 event)

| eventType | trigger 조건 | emit site (S2 wiring) | positionId | 필수 extras |
|---|---|---|---|---|
| `kol_call` | KOL buy tx 도착 (active or shadow) | `kolWalletTracker` | — | kolId, walletAddress, solAmount |
| `pending_open` | KOL Hunter pending 후보 등록 | `kolSignalHandler:registerPending` | — | armName |
| `survival_reject` | smart-v3 survival gate 실패 | `kolSignalHandler:smartV3SurvivalReject` | — | rejectReason, survivalFlags |
| `observe_open` | smart-v3 관찰 시작 | `kolSignalHandler:openSmartV3Observe` | — | observeWindowMs |
| `smart_v3_no_trigger` | observe 종료 + trigger 미발화 | `kolSignalHandler:smartV3NoTrigger` | — | observeMs, peakPrice |
| `kol_sell_cancel` | observe 중 KOL sell 도착 → 진입 cancel | `kolSignalHandler:kolSellCancel` | — | sellingKolId |
| `trigger_fire` | smart-v3 trigger 발화 (entry attempt 직전) | `kolSignalHandler:fireTrigger` | — | triggerType (pullback/velocity 등) |
| `entry_open` | paper / live entry 성공 | `kolSignalHandler:enterPaperPosition` / `enterLivePosition` | ✅ 필수 | actualInputSol, entryPrice |
| `entry_reject` | gate (ticket / canary / wallet) 통과 후 fail | 동일 | — | rejectCategory |
| `position_close` | paper / live close | `closePosition` / `closeLivePosition` | ✅ 필수 | exitReason, mode, netSol |

## §7. Dual-write 정책 + Deprecation Acceptance (Codex C4)

**Phase 2 (S3)**: 신규 ledger 와 옛 ledger 병렬 write — 기존 12 writer 그대로 유지.

**Phase 3 (S4)**: 1주 audit (`scripts/research-dual-write-audit.ts`) — 다음 6 criteria **모두 통과** 시 옛 ledger writer deprecation 결정 가능:

1. **Coverage** ≥ 99% — 옛 ledger 의 close row 99% 이상이 unified ledger 에 대응 row.
2. **netSol drift** ≤ 0.000001 SOL — paper / live 각각 row-by-row.
3. **Close count 3-way 정합 (Codex L1 보정)** — 다음 셋이 모두 동일:
   - 옛 (`kol-paper-trades` + `kol-live-trades`) close 행 수
   - unified `trade-outcomes.jsonl` 의 row 수 (mode 별 분리)
   - unified `kol-call-funnel.jsonl` 의 `position_close` event 수 (eventId distinct 후)
4. **positionId join miss** = 0 — funnel `entry_open` 의 모든 positionId 가 outcomes 에서 발견됨 (정상 종료 후).
5. **Schema 필수 필드 missing** = 0 — Phase 1 의 fixture test 통과율 100% × dual-write 기간.
6. **Truth alias 정합** — outcomes row 중 mode='live' 에서 `|netSol - walletDeltaSol|` > 1e-9 인 row = 0 / mode='paper' 에서 `|netSol - simulatedNetSol|` > 1e-9 인 row = 0.

**미통과 시**: 옛 ledger 영구 dual-write 도 OK (unified 가 추가 source of truth) — 강제 deprecation 안 함.

## §8. Phase / Sprint plan

| Phase | Sprint | 상태 | 산출 | LOC | Acceptance |
|---|---|---|---|---|---|
| 1.A | S1 | ✅ 완료 (2026-05-01) | 본 ADR + types + fixtures + lightweight runtime validator | ~470 docs + ~270 code + ~430 test | Schema v1 동결 / fixture 4 (paper/live/shadow/tail) jest pass / dedupe key determinism 검증 |
| 1.B | S2 | ✅ 완료 (2026-05-01) | `src/research/researchLedger.ts` 본 writer — append helper + recordId 산출 + quarantine 분기 | ~270 + 14 test | jest pass / append fail-open / quarantineAppendFailed 노출 |
| 1.C | S2.5 | ✅ 완료 (2026-05-01) | Codex 보정 7건 (eventId / netSol truth alias / mode-conditional error / boolean-typed / non-empty string conditional / event enum / quarantine boolean) | ~120 + 11 test | jest 1481/1481 pass |
| 2 | **S3** | 🟡 **보류 (2026-05-01)** | `kolSignalHandler` / `closeLivePosition` / reject site 4 / smart-v3 cancel 에 dual-write 연결 | ~400 (예상) | dual-write row count drift = 0 jest 자동검증 |
| 3 | S4 (1주 측정) | ⏳ 대기 (S3 후) | `scripts/research-dual-write-audit.ts` | ~300 | §7 acceptance 6 criteria 충족 |
| 4 | S5 | ⏳ 대기 | `scripts/research-report.ts` | ~400 | 7 핵심 질문 답변 markdown + csv |
| 5 | S6+ | ⏳ 대기 | Reader migration + 옛 writer deprecation 결정 | ~300 | drift 0 후 결정 |

**S3 보류 사유 (2026-05-01)**: 운영자 판단 — 옛 12 ledger 만으로 1차 운영 데이터 누적 후 emit site 우선순위 재평가 권고. S1+S2 인프라는 완성 — 재개 시 §13 의 결정 항목 3개만 답하면 즉시 wiring 가능.

## §9. Risk + Mitigation

| Risk | Mitigation |
|---|---|
| schema v1 후 변경 → migration 지옥 | `schemaVersion` 필드 + S1 fixture 동결 + 변경 시 v2 ADR + reader 가 `schemaVersion` 분기 |
| dual-write disk I/O 부담 | append-only fs.appendFile 1회/이벤트, 기존 writer 와 동급 — 영향 무시 가능 |
| audit 실패 시 deprecation 지연 | acceptance 5 criteria 명시 — 미통과 시 dual-write 영구 OK |
| `eventId` collision | deterministic sha1 + 1초 bucket — 동일 event 중복 흡수 (Codex M1 의도). 정상 distinct event 는 `txSignature` / `positionId` / `rejectCategory` 차원으로 분리됨 |
| `recordId` collision | UUIDv4 또는 sha1(eventId|emitNonce) — process-local nonce 가 collision rate ~ 0 |
| paper vs live mode 혼동 | validator 가 mode-conditional 필수 필드 검증 (§3.3) — paper 가 walletDeltaSol non-null 이면 reject |
| participatingKols schema drift | tier enum 'S\|A\|B' 으로 동결, kolDb 의 `lane_role` / `trading_style` 은 별도 cohort dimension (snapshot 시점 기록 안 함 — 분석 시 KOL DB 상태 + 시각 join) |

## §10. 7 질문 답변 정의 (Phase 4 report metric)

각 질문에 대해 Phase 4 의 `research-report.ts` 가 **반드시 생성** 해야 할 metric:

1. **KOL 조합 PnL**: `kols.sort().join(',')` × `effectiveIndependentCount` 버킷 → n / mean netSol / median netSol / 5x rate / DSR (n>=30 시).
2. **Dev / CA 반복 손실**: `tokenMint` × dev wallet (token-quality observation join) → n / cum netSol / loss rate / 평균 hold.
3. **pullback vs velocity**: `kolEntryReason='pullback'` vs `'velocity'` × `kolConvictionLevel` → n / mean netSol / hold p50 / 5x rate / DSR.
4. **holder % 손실 임계**: `top10HolderPct` 0~100% 5% 버킷 → 손실률 곡선 + 임계 추정 (loss rate 첫 50% 초과 버킷).
5. **entry advantage % 임계**: `entryAdvantagePct` -10~+10% 1% 버킷 → mean netSol / mfe peak / "피해야 하는 임계" (mean netSol 음수 첫 버킷).
6. **winner-kill exitReason**: `mfePctPeak >= 1` row 의 `exitReason` × `mfePctPeak/netPct` ratio → winner-kill rate (`net < 0.5 * mfe`) top 5.
7. **live-paper drift**: `mode='paper'` vs `mode='live'` 의 동일 (`armName`, `kolEntryReason`, `kolConvictionLevel`, `kols`) cohort → mean netSol drift / fill rate drift / decision delay.

## §11. Mission §3 정합

- **0.7 SOL wallet floor**: live `walletDeltaSol` cumulative + survival 보호 (gate reject 가 funnel 에 기록되어 보호 효과 측정 가능).
- **200 trade gate**: `mode='live'` 의 `position_close` 누적 200 도달 시 Phase 4 report 의 DSR Prob>0 / fat tail (γ4) / fold k(5x rate) 자동 산출 → Stage 4 promote 결정 input.
- **5x+ winner**: `actual5xPeak=true` 의 `exitReason` × `netPct` 분포 → mission §3 의 "5x bucket alive" 정의 정합.

## §12. Open Items / Follow-up

- KOL DB 시점 join: `participatingKols` 에 진입 시점 KOL `tier` 만 snapshot. 진입 시점의 `lane_role` / `trading_style` 도 snapshot 할지는 v2 후보 (현재 KOL DB hot reload 가 60s 라 의미 불확실).
- `effectiveIndependentCount` 의 community cache 갱신 주기 (현 10분) 와 outcome row 의 동시성 정합 — Phase 2 wiring 시 확인.
- `paperModelVersion` 변경 정책: 비용 model 변경 시 새 version string 부여 + 옛 row 는 그대로 유지 (backfill 안 함).
- 사용자 7 질문 외 추가 cohort: `kolReinforcementCount` (재확인 카운트), `parameterVersion` × `armName` (parameter sweep 분석) 도 자동 cohort 추가 후보 (Phase 4 report 옵션).

### §12.A Quarantine 정책 (확정)

S2 writer 가 validator invalid row 를 처리하는 정책 — **Option A 확정** (2026-05-01).

**확정 spec**:

1. **격리 ledger 경로**: `data/realtime/research-quarantine.jsonl` (단일 파일, append-only, 신/구 schema 모두 흡수).
2. **격리 record schema**:
   ```jsonc
   {
     "quarantinedAtIso": "2026-05-01T05:00:00.000Z",
     "schemaTarget": "trade-outcome/v1" | "kol-call-funnel/v1",
     "errors": ["..."],          // validator.errors
     "warnings": ["..."],        // validator.warnings
     "rawRow": { ... }           // 원본 row (best-effort, JSON.stringify 가능한 부분만)
   }
   ```
3. **운영 path 정책 (fail-open 유지)**:
   - validator invalid → quarantine append + `log.warn`. **throw 안 함**, mission §3 wallet floor 보호 우선.
   - quarantine append 실패 (디스크 full / permission) → `log.error` + 정상 path 계속. ledger 손실 가능성 명시 (운영자 monitoring 책임).
   - 정상 row → unified ledger (`trade-outcomes.jsonl` / `kol-call-funnel.jsonl`) append.
4. **Audit script (S4)**:
   - `scripts/research-dual-write-audit.ts` 가 quarantine 비율 (전체 row 대비 %) + 사유 분포 (errors histogram) 별도 report.
   - quarantine 비율 > 1% 면 `mission_warn` 알림 (schema drift 신호).
   - quarantine row 의 `schemaTarget` 별 분리 — trade-outcome / funnel 각각 사유 top 5.
5. **재처리 정책 (Phase 5+)**:
   - validator 가 v2 로 변경되면 옛 quarantine row 를 backfill replay 가능 (`scripts/research-quarantine-replay.ts` follow-up).
   - 현재는 backfill 안 함 — invalid row 는 분석에서 제외 (cleansing 단계).
6. **Test 의무**:
   - S2 writer test 에서 invalid input → quarantine 만 append (정상 ledger append 안 됨) 검증.
   - 정상 input → 정상 ledger append + quarantine 비활성 검증.

---

## §13. S3 보류 기록 (2026-05-01)

**상태**: S3 dual-write wiring **보류**. S1 + S2 + S2.5 인프라는 완성 (코드 / test / quarantine / Codex 보정 모두 적용).

**보류 결정 사유**
- 옛 12 ledger (`kol-paper-trades` / `kol-live-trades` / `executed-buys` / `executed-sells` / `kol-policy-decisions` / `missed-alpha` / `kol-shadow-tx` / `kol-tx` / `kol-partial-takes` / `token-quality-observations` / `admission-skips-dex` / `pair-quarantine`) 만으로 1차 운영 데이터 누적 후 emit site 우선순위 재평가 권고 (운영자 판단).
- 사명 §3 200-trade gate 도달 시점에 unified ledger wiring 이 살아있어야 한다는 제약은 유효 — S3 재개 trigger 는 `mode='live'` 의 누적 close 100 row 도달 시점 또는 운영자 명시적 요청.
- S1+S2 코드는 그대로 유지 (rotting 안 함) — 운영 path 미연결 상태 (호출자 0).

**S3 재개 시 결정 필요 항목 (3가지)**
1. **dual-write 활성화 flag**: env `RESEARCH_LEDGER_DUAL_WRITE_ENABLED` (default `false`) 도입 — 권고 yes (운영 안전망, 미연결 상태로 코드 반영 후 운영자 toggle).
2. **sessionId 부여 정책**:
   - Option A: `current-session.json` 의 id 재사용 (기존 운영 데이터와 join 가능)
   - Option B: 부팅 시 신규 UUID v4 (research ledger 전용 격리)
   - **권고**: Option A.
3. **Emit site 우선순위**:
   - Option A (일괄): 10 emit site 전체 한 번에 wiring (~400 LOC)
   - Option B (Phase 분할): Phase B-1 = `entry_open` / `position_close` / `appendTradeOutcome` 3 site (~200 LOC, mission §3 200-trade gate 의 핵심) → Phase B-2 = funnel 7 site (`kol_call` / `pending_open` / `survival_reject` / `observe_open` / `smart_v3_no_trigger` / `kol_sell_cancel` / `trigger_fire` / `entry_reject`)
   - **권고**: Option B (200-trade gate 도달 시점 우선 + emit site 단계적 검증).

**S3 재개 절차 (재개 시 따라야 할 순서)**
1. 본 §13 의 3 결정 항목 답변
2. `RESEARCH_LEDGER_DUAL_WRITE_ENABLED` config 추가 (`src/config/operationalToggles.ts`)
3. `src/orchestration/kolSignalHandler.ts` 의 entry/close site 에 `appendTradeOutcome` + `appendFunnelEvent` wiring (옛 writer 유지, **dual-write**)
4. jest 회귀: 1) 옛 ledger row count == unified ledger row count / 2) mode-conditional truth alias 정합 / 3) quarantine 비율 < 1%
5. 운영 1주 dual-write 측정 → S4 audit script 입력

**S3 재개 trigger 신호**
- `mode='live'` 의 `kol-live-trades.jsonl` 누적 close 100 row 도달 (사명 §3 evidence-based gate 직전)
- 또는 운영자 명시적 재개 요청
- 또는 옛 12 ledger 의 schema drift 발견 (drift 1건 이상 시 즉시 unified ledger 전환 검토)

**Helius Credit-to-Edge plan 과의 정합 (2026-05-01)**
- `docs/exec-plans/active/helius-credit-edge-plan-2026-05-01.md` 가 도입하는 신규 sidecar ledger 들 (`data/realtime/helius-credit-usage.jsonl` / `data/research/helius-markouts.jsonl` / `data/research/kol-wallet-style-backfill.jsonl`) 은 **본 ADR §3 의 schema v1 (`trade-outcome/v1` + `kol-call-funnel/v1`) 와 분리된 namespace** — 각자 자체 schemaVersion 보유 (`helius-credit-usage/v1` / `helius-markout/v1` / `kol-wallet-style/v1`).
- S3 의 dual-write trigger (`mode='live'` close 100 row) 와 무관 — Helius plan 의 sidecar 들은 자체 적용 시점에 따라 독립적으로 운영.
- v2 schema 시 필요하면 흡수 검토 (현재는 별도 유지가 보수적).

**현 상태에서 영향**
- 운영 path: 영향 **0** (S2 writer 호출자 미존재)
- jest: **1481/1481 pass** (writer + validator 자체 test 만)
- 코드 rotting 위험: 낮음 — S1+S2 모두 self-contained, 외부 의존성은 `config.realtimeDataDir` (안정 필드) + `crypto.createHash` (Node std) 만
- 의존성 부담: 0 (신규 npm package 0)
- 기술 부채: 보류 1주 이상 시 ADR `last_verified` 갱신 + 운영자 재확인 권고
