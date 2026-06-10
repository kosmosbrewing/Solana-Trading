# Phase 4 — Paper / Mirror / Live Translation Proof

> Data: kol-paper-trades + pure-ws-paper-trades + kol-live-trades, positionId dedup (n=5,709).
> Mirror pairing: parentPositionId 기반 21/21 = 100% (promotion-grade join).

## 4.1 Role 별 성과 (dedup)

| Role | N | Net SOL | Win rate | Max loss streak | MFE≥50% | MFE≥400% (5x) |
|---|---:|---:|---:|---:|---:|---:|
| shadow | 2,627 | +2.293 | 41.6% | 19 | 9.4% | 0.15% |
| unknown_role | 1,987 | +1.451 | 41.0% | 15 | 9.2% | 0.10% |
| fallback_execution_safety | 407 | +0.289 | 42.3% | 10 | 7.4% | 0% |
| research_arm | 184 | +0.214 | 54.3% | 5 | 7.6% | 0% |
| probe_policy_shadow | 158 | +0.065 | 43.7% | 8 | 5.1% | 0% |
| **mirror** | **21** | **−0.073** | **9.5%** | 9 | 9.5% | 0% |
| **live** | **325** | **−0.803** | **12.3%** | **32** | 5.5% | 0.31% (1건) |

## 4.2 Mirror/Live pairing

| Metric | 값 | Gate (≥) |
|---|---|---|
| paired rows | 21 | 30 — **미달** |
| sign agreement | **21/21 = 100%** | 85% — 통과 |
| live without mirror | 304 | 0 — **미달** |
| mirror net | −0.073 | >0 — **미달** |
| live wallet net | −0.803 | >0 — **미달** |

분류: paired 21건 전부 `strategy_loss` 방향 일치 (execution drag 가 아니라 양쪽 다 전략 손실). Mirror 는 live 를 정확히 추적했고, 추적한 결과가 "진다" 였다.

## 4.3 Paper headline 오염 선언

선언 조건 3개 전부 충족:

1. ✅ positive PnL 의 대부분 (3.96 of +4.31 SOL = 92%) 이 `shadow` / `unknown_role` / `research_arm` 에서 발생
2. ✅ mirror 음수 (−0.073)
3. ✅ paired rows 21 < 30

**Paper headline (+4.24 SOL) 은 live 예측력이 없다.** 원인은 Phase 2 와 정합적: paper 시뮬 fill 은 (a) entry drift +10.4% median 을 내지 않고, (b) 거래당 0.0027 SOL 고정 overhead 를 내지 않는다. paper win rate 41-54% vs live 12.3% 의 격차 대부분이 이 두 비용 축으로 설명된다. 이를 충실히 재현한 mirror 만 live 와 같은 부호를 냈다.

## 4.4 Phase 4 판정

Core question — *"Can paper results predict live wallet-truth results?"*

- **Raw paper: NO** (부호 자체가 반대) → 어떤 paper headline 도 live 승격 근거 불가 (기존 정책과 일치, 재확인).
- **Mirror: YES (100% sign agreement)** — 단 표본 21 < 30 이며, mirror 가 예측하는 내용이 "이 전략은 live 에서 진다" 이다.

따라서 "측정을 더 고쳐서 승격하자" 류의 경로는 닫힌다: 측정 (mirror) 은 이미 충분히 정확했고, 정확한 측정이 가리키는 결론은 전략 부재다.
