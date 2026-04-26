# scripts/archive/pre-pivot-2026-04-18

> 2026-04-26 cleanup 시 archive 된 pre-pivot 시기 (2026-04-18 mission pivot 이전) 의 ad-hoc / one-off 스크립트.

## 분류

### One-off 마이그레이션
- `patch-inverted-prices.sh` — 2026-04-08 가격 반전 마이그레이션 1회용
- `patch-swaps-fields.sh` — 1회용 schema 패치
- `backfill-birdeye-v3.ts` — 일회성 데이터 backfill
- `retag-legacy-strategy.ts` — 1회 strategy 라벨 마이그레이션

### Pre-pivot 자동화 (cupsey 동결 후 무효)
- `auto-backtest.{sh,ts}`, `auto-backtest-report.ts`
- `bootstrap-replay-report.sh`, `bootstrap-token-leaderboard.ts`
- `cron-backtest.sh`, `cron-equity-check.sh`, `cron-watch-collector.sh`
- `analyze-vol-distribution.js`

### Cupsey / pure_ws 3-week aggregation (paradigm 변경 후 무효)
- `aggregate-cupsey-3week.ts`, `run-cupsey-3week.sh`, `cupsey-backtest.ts`
- `aggregate-pure-ws-3week.ts`, `run-pure-ws-3week.sh`, `pure-ws-backtest.ts`

### Sweep / scoreboard / param tooling (mission pivot 후 미사용)
- `multi-token-sweep.ts`, `param-sweep.ts`, `session-replay-sweep.ts`
- `backtestTp1Tuning.ts`, `strategy-scoreboard.ts`, `parameter-change-log.ts`

## 사용 정책

- **현 운영 코드 경로에서 import 금지** (이미 disconnect 됨).
- 과거 분석 결과 재현이 필요할 때만 참고.
- `tsconfig.scripts.json` 의 `exclude` 에 `scripts/archive/**` 가 박혀 있어 typecheck:scripts 에서 제외됨.
- 추후 영구 삭제 가능. **Phase 5 SCALE 이후** 재현 필요 없으면 commit 통해 영구 제거.
