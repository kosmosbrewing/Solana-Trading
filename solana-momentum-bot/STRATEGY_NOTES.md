# STRATEGY_NOTES.md

> Status: forward strategy memo
> Updated: 2026-03-31
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

## Open Questions

- v5 구조만으로 Strategy A 기대값이 살아나는가
- detection timing을 더 앞당겨야 하는가
- Strategy D를 언제 main live 후보로 올릴 것인가
- runner hold가 실제로 다수 손실을 덮는 구조를 만드는가

## One-Line Summary

> `STRATEGY_NOTES.md`는 현재 runtime이 왜 그런 형태인지와, 다음 전략 질문이 무엇인지를 분리해 적는 forward memo다.
