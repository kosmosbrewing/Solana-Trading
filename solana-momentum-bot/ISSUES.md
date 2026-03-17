# Issues & Quality Tracker

> Last reviewed: 2026-03-17
> Mission: 1 SOL -> 100 SOL
> Scope: active issues only
> Completed archive: `ISSUES_CMPL.md`
> Audit follow-up: `ISSUES2.md`

---

## Mission Readiness: 9.5/10

코어 런타임, 전략 배선, 리스크 관리, 백테스트/리포팅 정리는 완료됐다.
현재 남은 항목은 외부 자격증명이 필요한 X Filtered Stream 실연동 1건뿐이다.

| Capability | Status |
|------|------|
| Multi-pair scanner | ✅ Birdeye WS + DexScreener 기반 동적 watchlist |
| Security / quote gate | ✅ honeypot/freeze/transfer_fee/exit-liquidity + Jupiter quote |
| Strategy wiring | ✅ A/C 코어 + D sandbox + E cascade |
| Risk / sizing | ✅ WalletManager, daily loss, DD guard, Kelly, demotion |
| Backtest / validation | ✅ 17 suites, 67 tests 기준 내부 검증 완료 |
| External social stream live check | ⏳ Bearer Token + X rule/live 검증 필요 |

---

## Active Issues

| ID | Category | Issue | Status | Next Step |
|----|----------|-------|--------|-----------|
| C-2 | External | X Filtered Stream 실연동 | 코드 준비 완료 | `TWITTER_BEARER_TOKEN` 설정 후 rule 등록 및 live smoke test |

---

## Backlog / Optional

### 운영 최적화

- Birdeye WS -> Helius WS 전환 검토
  - 상태: 아이디어 단계
  - 목적: 데이터/실행 인프라 단순화와 비용 최적화
  - 전제: 현 Birdeye WS 경로가 병목이 되거나 비용/안정성 이슈가 생길 때만 검토

---

## Notes

- 2026-03-17 full audit 결과와 완료 항목 상세는 `ISSUES_CMPL.md`로 이관.
- `ISSUES2.md`는 감사 후속 작업만 추적.
- 실운영 전 최종 외부 체크는 X API 자격증명, filtered stream rule, 실제 멘션 수신 로그 확인이다.
