# ADR-004: Risk Tier 단계적 리스크 확대 모델

**상태:** 확정
**날짜:** 2026-03
**맥락:** 봇 초기 운영 시 리스크를 제한하고, 성과 검증 후 점진적으로 확대

## 선택지

1. **고정 리스크:** 전 기간 동일 리스크 파라미터
2. **수동 조절:** 운영자가 성과 보고 판단하여 수동 변경
3. **자동 Tier:** EdgeTracker 기반 자동 단계 조정

## 결정: 자동 Tier (Bootstrap → Calibration → Confirmed → Proven)

## 이유

- 24/7 무인 운영 전제 — 수동 개입 최소화
- 통계적 근거 기반: 트레이드 수 + Kelly + Sharpe로 객관적 판단
- 자본 보존 우선: 초기 Bootstrap에서 1% 리스크로 시작
- 자동 강등(demotion): 성과 악화 시 즉시 리스크 축소

## 트레이드오프

- 초기 Bootstrap 기간(~20 trades)에 수익 기회 제한
- Tier 전환 로직 복잡성 증가
- 시장 레짐 변화 시 Tier가 늦게 반응할 수 있음

## 관련 문서

- `../design-docs/risk-tier-system.md` — 상세 설계
- `../../src/risk/riskTier.ts` — 구현
