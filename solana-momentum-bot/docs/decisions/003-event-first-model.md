# ADR-003: Event-First 2-Stage 진입 모델

**상태:** 확정
**날짜:** 2026-02
**맥락:** Meme/event 토큰 트레이딩에서 가짜 펌프 필터링 전략 필요

## 선택지

1. **Price-First:** 가격 움직임 감지 → 진입 (일반 모멘텀 봇)
2. **Event-First:** 이벤트/컨텍스트 확인 → 가격 트리거 확인 → 진입

## 결정: Event-First

## 이유

- "뉴스 없는 급등 = 조작 가능성" — Price-First는 가짜 펌프에 취약
- AttentionScore로 선행 컨텍스트를 정량화
- 2단계 필터로 진입 품질 향상: Context(왜?) → Trigger(지금?)
- 브레이크아웃은 "메인 전략"이 아니라 "트리거" — 엣지는 이벤트 선별에서 발생

## 트레이드오프

- 순수 온체인 급등 기회 일부 놓침 (이벤트 미감지 시)
- AttentionScore 계산에 외부 API 의존 (Birdeye trending)
- 이벤트 감지 지연 시 최적 진입 시점 놓칠 수 있음

## 관련 문서

- `docs/design-docs/2-stage-entry.md` — 상세 설계
- `src/event/eventScorer.ts` — AttentionScore 구현
