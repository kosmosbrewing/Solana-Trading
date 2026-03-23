# ADR-005: Jupiter Ultra를 Jito 보완재로 포지셔닝

**상태:** Accepted
**날짜:** 2026-03-18
**맥락:** 실행 인프라에서 Jito 번들과 Jupiter Ultra의 MEV 방어 역할이 중복됨

## 결정

Jupiter Ultra API는 Jito 번들 미사용 경로의 **보완재**로 도입한다.
Jito가 주 경로(Primary MEV Protection)로 유지되며, Ultra는 다음 경우에만 활성화:

1. `USE_JITO_BUNDLES=false`이고 `USE_JUPITER_ULTRA=true`인 경우
2. Jito 번들 제출이 실패한 경우의 fallback 경로

전면 전환은 Paper Trade A/B 비교 후 결정한다.

## 근거

### Jito 번들 (현재 구현 완료)
- DontFront MEV 보호 + 동적 팁 관리 + 번들 상태 추적
- `src/executor/jitoClient.ts` 337줄, Phase 3 완성
- 장점: 원자적(atomic) 실행, MEV 차단 명시적
- 단점: 팁 비용 발생, 블록 엔진 가용성에 의존

### Jupiter Ultra
- Predictive Execution, RTSE, 인하우스 트랜잭션 랜딩 엔진
- 장점: 체결 품질 개선 가능성, 내부 시뮬레이션으로 pre-flight 실패율 감소
- 단점: API 인터페이스 변경 빈도 높음, 실행 우위 보장 아닌 가능성, Jito와 MEV 방어 중복
- 주의: 개별 트레이드의 속도나 수익을 보장하지는 않음

### 결론
- Jito: 검증된 MEV 방어 → 유지
- Ultra: Jito 미사용/실패 시 보완 → 점진적 도입
- A/B 비교: 50+ paper trade 후 체결 품질 비교 → 전환 여부 결정

## 구현 계획

1. **Phase 1** (현재): config 토글 추가 (`USE_JUPITER_ULTRA=false`)
2. **Phase 2**: executor에 Ultra 경로 추가 (Jito fallback)
3. **Phase 3**: Paper Trade A/B 비교 → 데이터 기반 전환 결정

## 참고
- [Jupiter Ultra Swap API](https://dev.jup.ag/docs/ultra)
- ADR-002: Jupiter over Raydium 결정과 일관
