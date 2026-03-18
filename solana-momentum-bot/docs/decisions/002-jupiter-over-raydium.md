# ADR-002: Jupiter API 선택 (vs Raydium 직접)

**상태:** 확정
**날짜:** 2026-02
**맥락:** Solana DEX 스왑 실행 경로 결정

## 선택지

1. **Jupiter v6 API** — DEX 애그리게이터, 최적 경로 자동 탐색
2. **Raydium SDK 직접** — 단일 DEX, 직접 풀 접근

## 결정: Jupiter v6 API

## 이유

- 최적 라우팅: 여러 DEX를 자동 비교하여 최적 가격
- 슬리피지/Price Impact 검증 API 내장
- 에이전트 학습 데이터 풍부 (공식 문서, 커뮤니티)
- Quote → Swap 2-step API가 게이트 시스템과 자연스럽게 통합
  (Quote에서 price impact 확인 → 통과 시 Swap 실행)

## 트레이드오프

- Jupiter API 장애 시 거래 불가 (SLA 의존)
- Rate limit 준수 필요 (600/min)
- Raydium 직접 대비 미세한 레이턴시 추가
