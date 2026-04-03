# STRATEGY_NOTES.md

> Status: forward strategy memo
> Updated: 2026-04-03
> Purpose: 현재 전략 구조의 한계 가설, v5 방향성, 다음 전략 질문을 분리 관리한다.
> Runtime quick ref: [`STRATEGY.md`](./STRATEGY.md)

## Role

이 문서는 현재 runtime quick reference가 아니다.

- 현재 파라미터나 gate 순서를 확인할 때는 [`STRATEGY.md`](./STRATEGY.md)를 본다
- 이 문서는 왜 현재 구조가 그렇게 생겼는지와 다음 실험 질문을 기록한다
- 구현 완료 여부나 active execution work는 다루지 않는다

## Why v5 Exists

현재 Strategy A는 이미 움직인 뒤의 작은 ATR 움직임을 잡는 경향이 있었고,
Solana 밈코인 시장의 기대값은 소수의 fat-tail winner에서 나오는 경우가 많다.

그래서 현재 runtime은 아래 방향으로 정렬됐다.

- TP1 축소
- TP2 사실상 확장
- SL의 ATR 기준 정규화
- trailing을 TP1 이후로 지연
- execution RR을 TP2 기준으로 전환 (runner-centric 전략 정합)

## Current Strategic Thesis

- `effectiveRR` 문제는 단순 버그가 아니라 기존 구조의 한계를 gate가 드러낸 것일 수 있다.
- Strategy D는 장기적으로 더 mission-fit일 수 있지만, 아직 sandbox/live 검증이 부족하다.
- runner 중심 구조가 실제로 fat-tail을 포착하는지 계속 봐야 한다.

## Bootstrap Trigger Rationale

MomentumTrigger (core)는 3-AND (volume + 20봉 breakout + 3봉 confirm) 조건을 요구했으나,
live RejectStats에서 noBreakout=100%, confirmFail=100%로 signal 0을 생산했다.
밈코인 모멘텀은 1~2봉이면 끝나므로 3봉 confirm은 구조적으로 너무 늦다.

VolumeMcapSpikeTrigger (bootstrap)는 breakout/confirm을 제거하고 volume acceleration + buy ratio 2-gate만으로 발화한다.
Watchlist 내 토큰만 대상이므로 Mission Gate(설명된 진입 ≥90%) 위반 없음.

### 판단 보류 질문
- bootstrap trigger의 false positive rate가 실제로 어느 정도인가
- buy ratio 0.55 threshold가 적절한가, 시장 상황에 따라 조정이 필요한가
- bootstrap → core 전환 시점을 무엇으로 판단할 것인가
- mcap enrichment (volumeMcapPct)가 gate/scoring에서 추가 활용 가능한가

## Open Questions

- v5 구조만으로 Strategy A 기대값이 살아나는가
- detection timing을 더 앞당겨야 하는가
- Strategy D를 언제 main live 후보로 올릴 것인가
- runner hold가 실제로 다수 손실을 덮는 구조를 만드는가
- **TP2 10.0 vs 5.0**: sweep 최적 5.0 → v5 runner-centric 10.0 확장. config.ts 기본값은 10.0이나 검증 미완. Live 50-trade 후 TP2 도달률로 판단. 도달률 < 5%면 5.0 복원 검토.

## Future: 소셜/온체인 인텔리전스 플랫폼 (Phase 4+)

> 기록일: 2026-04-02 · 도입 시점: Phase 3~4 (5+ SOL, 안정 수익 확인 후)

온체인 지표가 폭발하기 전에 소셜 바이럴/인물 언급을 미리 캐치하는 별도 인텔리전스 플랫폼 구상.
트레이딩 봇이 아닌 정보 수집·분석 시스템. 현재 봇의 EventMonitor/EventScorer 확장 형태로 점진 도입.

### 4개 핵심 모듈

1. **이벤트 캐치** — X/TikTok/뉴스/인플루언서 실시간 모니터링 → AI 스코어링 (0-100)
   - 데이터 소스: X(30-60s), TikTok 트렌딩(5m, 크립토 필터 없이 전체), 뉴스 RSS(5-10m)
   - 인플루언서 티어: S(Elon/CZ 즉시분석), A(Sam Altman/Vitalik), B(바이럴 시만)
   - 80점+: 상세 AI 리포트 + TG 긴급 알림 / 미만: 대시보드 피드만
   - 핵심: 비크립토 밈(67밈 등)이 밈코인 재료가 되므로 TikTok 전체 트렌딩 대상

2. **급변 사례 캐치** — 온체인 급변 감지 → 소셜에서 원인 자동 탐색
   - 대상: pump.fun → Pumpswap 마이그레이션 완료 코인
   - 감지: 5분 거래량 N배, 홀더 N명 급증, 가격 N% 상승 (시총 구간별 차등)
   - 워크플로: 온체인 이상치 → X에서 CA/티커 검색 → pump.fun 소셜링크 → 문맥 보고
   - 스캠 필터: 번들링(동일블록 다수지갑), 봇 패턴(Axiom/Photon/BananaGun)

3. **신규 코인 필터링** — pump.fun WebSocket → 러프 필터 → 1시간 추적 → AI 리서치 리포트
   - 필터: mcap 마일스톤, 홀더 최소치, 봇 비율 상한, 번들링 체크
   - 리포트: 테마/내러티브, 소셜 존재, 번들링 여부, 밈코인 재료 점수, 스캠 점수

4. **전체 코인 트래킹** — watchlist + 조건 알림 (mcap/가격 도달)
   - 향후: 거래량/홀더 급등, 인플루언서 언급, AI 이벤트 예측

### 웹 대시보드
- 단일 피드(시간순) + 모듈별 필터, WebSocket 실시간 업데이트
- Config UI에서 모든 임계치 실시간 조정, 데이터소스 상태 표시

### 도입 전략
- 기존 `EventMonitor`/`EventScorer` 모듈 확장 형태로 점진 도입
- Module 2(급변 사례 캐치)를 가장 먼저 연결 — 봇이 이미 온체인 급변을 감지하므로 소셜 원인만 추가
- 예상 공수: 풀 구현 8-12주 (1인 개발자 기준)

---

## One-Line Summary

> `STRATEGY_NOTES.md`는 현재 runtime이 왜 그런 형태인지와, 다음 전략 질문이 무엇인지를 분리해 적는 forward memo다.
