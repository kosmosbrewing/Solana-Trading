# Issues & Quality Tracker

> Last reviewed: 2026-03-15 HB13
> Mission: 1 SOL -> 100 SOL
> Scope: active issues only
> Archive: `ISSUES_CMPL.md`

---

## Mission Readiness: 6/10

| Capability | Status | Remaining Gap |
|------|------|------|
| Drawdown protection | ✅ | mark-to-market DD 반영 완료 |
| Risk tier quality gates | ✅ | 강등 메커니즘, Kelly cap 재조정 잔여 |
| TP1 partial + trailing | ✅ | TP1 폭 재튜닝 여지 |
| Event/attention gating | ⚠️ | 외생 이벤트가 아니라 가격 파생 지표 |
| Slippage-aware RR gate | ✅ | 예상 포지션 사이즈 기반 early probe 구현 (C-6) |
| Kelly activation | ⚠️ | 샘플 안정성, 최근 성과 기반 강등 필요 |
| Backtest parity | ⚠️ | historical EventScore dataset 미완료 |
| Pair-level controls | ✅ | decay window 기반 재활성화 구현 (C-3) |
| Social event detection | ❌ | Phase 2 미착수 |
| Market regime filter | ❌ | 없음 |

---

## Active Issues

### Critical

#### C-1. Historical EventScore replay 미완료

> 상태: 부분 해결

- shared gate, static EventScore, time-series EventScore file replay는 구현됨
- 실제 과거 시점별 dataset 수집/적재가 없어 live와 완전 동일한 backtest는 아님

영향:
- backtest 결과를 live 기대값으로 과신할 수 있음

남은 작업:
- pair/time 기준 historical EventScore dataset 수집
- backtest input pipeline에 운영 데이터셋 연결

#### C-2. 외생 이벤트 소스 부재

현재 EventScore는 Birdeye Trending 단일 소스 + 30분 폴링이다.

영향:
- 밈코인 초기 이벤트를 후행적으로만 감지

남은 작업:
- Twitter/X, Discord, Telegram, listing, influencer mention 등 실시간 이벤트 파이프라인 추가

### High

#### H-2. Spread proxy 정확도 한계

> 상태: 부분 해결

완료:
- UniverseEngine에서 1분봉 high/low 기반 spread proxy 계산

남은 작업:
- bid/ask 또는 swap quote 기반 source로 교체

#### H-3. Pool fee 실측값 반영 미완료

> 상태: 부분 해결

완료:
- execution viability 비용 설정 가능화
- 기본값 보수적 상향

남은 작업:
- pool별 `ammFeePct`를 안정적으로 실측/주입

### Medium

#### M-1. TP1 폭이 마이크로캡에 비해 보수적

가설:
- TP1 = 1.5x ATR가 너무 이른 이익 실현일 수 있음

후속:
- 2.0x ATR, 2.5x ATR 시나리오 backtest 비교

#### M-2. 전략별 EdgeState 분리 미흡

현재 일부 risk resolution은 전략 기준이지만, 운영 시야에서는 pair/strategy 교차 성과를 더 분리할 여지가 있다.

후속:
- 전략별 edge state와 포트폴리오 edge state 역할 재정리

#### M-4. 시장 레짐 감지 없음

후속:
- SOL/BTC, 변동성, 상관관계 기반 risk mode 전환 검토

#### M-5. MEV 보호 없음

후속:
- Jito bundle, private routing, sandwich 방어 검토

#### M-6. 포지션 모니터링은 여전히 5초 polling

후속:
- websocket 기반 가격 스트림 검토

---

## Priority Order

1. C-1 historical AttentionScore dataset 수집
2. C-2 외생 이벤트 파이프라인
3. H-2 / H-3 market microstructure 정밀화
4. M-1 ~ M-6 backtest 결과 기반 순차 개선

---

## Notes

- 완료 이력, 해결된 항목 상세, 과거 결정 로그는 `ISSUES_CMPL.md`로 이동
- 현재 `ISSUES.md`는 "지금 남은 것"만 관리한다
