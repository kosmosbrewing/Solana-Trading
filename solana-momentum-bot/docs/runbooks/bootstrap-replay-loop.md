# Bootstrap Replay Loop Runbook

> Last updated: 2026-04-05
> Scope: live session dataset 기준 `bootstrap_10s` replay -> outlier 확인 -> token 분해 -> runner vs flat/noise 판정
> Primary refs: [`REALTIME.md`](../../REALTIME.md), [`MEASUREMENT.md`](../../MEASUREMENT.md), [`docs/exec-plans/active/1sol-to-100sol.md`](../exec-plans/active/1sol-to-100sol.md)

## Role

이 문서는 `bootstrap_10s`를 같은 기준으로 반복 검증하기 위한 runbook이다.

- 전체 live session 기준 `trigger-only` / `stored-gate` replay를 다시 돌린다
- 세션별 편차와 outlier 의존도를 확인한다
- token별 기여도를 분해한다
- `runner`, `flat/noise`, `negative churn`을 같은 축으로 비교한다
- 다음 액션을 `flat suppress / churn suppress / metadata 강화` 중 어디에 둘지 연결한다

이 문서는 전략 철학 문서가 아니다.
현재 전략 우선순위는 [`STRATEGY.md`](../../STRATEGY.md), 운영 우선순위는 [`docs/exec-plans/active/1sol-to-100sol.md`](../exec-plans/active/1sol-to-100sol.md)를 따른다.

주의:

- older stored session에는 bootstrap trigger가 아직 `strategy=volume_spike`로 남아 있을 수 있다
- pure strategy attribution 용도로 stored 결과를 해석할 때는 [`scripts/retag-legacy-strategy.ts`](../../scripts/retag-legacy-strategy.ts) 기준을 먼저 확인한다
- 따라서 이 문서의 `stored-gate` replay는 기본적으로 `운영 replay`로 읽고, `전략 귀속 확정치`로 읽을 때는 retag 여부를 같이 본다

---

## Standard Loop

반복 루프는 아래 순서로 고정한다.

1. live session 목록 확인
2. `trigger-only` aggregate replay
3. `stored-gate` aggregate replay
4. 세션별 상세 표 확인
5. outlier 제외 재집계
6. token별 기여도 분해
7. `runner vs flat/noise` 비교
8. 다음 액션을 정리

---

## 1. Session Check

저장소 루트에서 실행:

```bash
cd /Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot
```

전체 live session 목록:

```bash
find data/realtime/sessions -maxdepth 1 -type d -name '*-live' | sort
```

`realtime-signals.jsonl`가 있는 stored-gate 세션만 확인:

```bash
find data/realtime/sessions -maxdepth 2 -name 'realtime-signals.jsonl' | sort
```

의미:

- `trigger-only`는 `raw-swaps` / `micro-candles`만 있으면 가능
- `stored-gate`는 `realtime-signals.jsonl`가 있어야 가능

---

## 2. Trigger-Only Aggregate Replay

목적:

- `bootstrap_10s`가 가격 반응 자체는 있는지 확인
- runtime gate/risk 이전에 trigger efficacy를 본다

단일 세션:

```bash
npx tsx scripts/micro-backtest.ts \
  --dataset ./data/realtime/sessions/<session>-live \
  --trigger-type bootstrap \
  --gate-mode off \
  --horizon 300 \
  --estimated-cost-pct 0.003 \
  --json
```

전체 live 세션 aggregate:

```bash
node <<'NODE'
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const root = process.cwd();
const sessionsRoot = path.join(root, 'data/realtime/sessions');
const sessions = fs.readdirSync(sessionsRoot).filter((d) => d.endsWith('-live')).sort();
const totals = {
  sessionCount: sessions.length,
  signalSessions: 0,
  totalSignals: 0,
  raw: 0,
  adj: 0,
  mfe: 0,
  mae: 0,
};

for (const session of sessions) {
  const dataset = path.join(sessionsRoot, session);
  const cmd =
    `npx tsx scripts/micro-backtest.ts --dataset ${JSON.stringify(dataset)} ` +
    `--trigger-type bootstrap --gate-mode off --horizon 300 --estimated-cost-pct 0.003 --json`;
  const out = cp.execSync(cmd, { cwd: root, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  const data = JSON.parse(out.slice(out.indexOf('{')));
  if ((data.summary?.totalSignals ?? 0) > 0) totals.signalSessions += 1;
  totals.totalSignals += data.summary?.totalSignals ?? 0;
  totals.raw += (data.summary?.avgReturnPct ?? 0) * (data.summary?.totalSignals ?? 0);
  totals.adj += (data.summary?.avgAdjustedReturnPct ?? 0) * (data.summary?.totalSignals ?? 0);
  totals.mfe += (data.summary?.avgMfePct ?? 0) * (data.summary?.totalSignals ?? 0);
  totals.mae += (data.summary?.avgMaePct ?? 0) * (data.summary?.totalSignals ?? 0);
}

const n = totals.totalSignals || 1;
console.log(JSON.stringify({
  sessionCount: totals.sessionCount,
  signalSessions: totals.signalSessions,
  totalSignals: totals.totalSignals,
  avgRawPct: 100 * totals.raw / n,
  avgAdjustedPct: 100 * totals.adj / n,
  avgMfePct: 100 * totals.mfe / n,
  avgMaePct: 100 * totals.mae / n,
}, null, 2));
NODE
```

해석:

- `avgAdjustedPct > 0`면 trigger 자체는 죽지 않았을 가능성이 있다
- 다만 이 단계는 `runtime gate/risk/execution`을 반영하지 않는다

---

## 3. Stored-Gate Aggregate Replay

목적:

- 저장된 gate/processing 상태를 부분 반영한 더 현실적인 replay를 본다

단일 세션:

```bash
npx tsx scripts/micro-backtest.ts \
  --dataset ./data/realtime/sessions/<session>-live \
  --trigger-type bootstrap \
  --gate-mode stored \
  --horizon 300 \
  --estimated-cost-pct 0.003 \
  --json
```

전체 stored 세션 aggregate:

```bash
node <<'NODE'
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const root = process.cwd();
const sessionsRoot = path.join(root, 'data/realtime/sessions');
const sessions = fs.readdirSync(sessionsRoot)
  .filter((d) => d.endsWith('-live'))
  .sort()
  .filter((d) => fs.existsSync(path.join(sessionsRoot, d, 'realtime-signals.jsonl')));

const totals = {
  sessionCount: sessions.length,
  signalSessions: 0,
  totalSignals: 0,
  executedSignals: 0,
  gateRejectedSignals: 0,
  raw: 0,
  adj: 0,
  mfe: 0,
  mae: 0,
};

for (const session of sessions) {
  const dataset = path.join(sessionsRoot, session);
  const cmd =
    `npx tsx scripts/micro-backtest.ts --dataset ${JSON.stringify(dataset)} ` +
    `--trigger-type bootstrap --gate-mode stored --horizon 300 --estimated-cost-pct 0.003 --json`;
  const out = cp.execSync(cmd, { cwd: root, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  const data = JSON.parse(out.slice(out.indexOf('{')));
  if ((data.summary?.totalSignals ?? 0) > 0) totals.signalSessions += 1;
  totals.totalSignals += data.summary?.totalSignals ?? 0;
  totals.executedSignals += data.summary?.executedSignals ?? 0;
  totals.gateRejectedSignals += data.summary?.gateRejectedSignals ?? 0;
  totals.raw += (data.summary?.avgReturnPct ?? 0) * (data.summary?.totalSignals ?? 0);
  totals.adj += (data.summary?.avgAdjustedReturnPct ?? 0) * (data.summary?.totalSignals ?? 0);
  totals.mfe += (data.summary?.avgMfePct ?? 0) * (data.summary?.totalSignals ?? 0);
  totals.mae += (data.summary?.avgMaePct ?? 0) * (data.summary?.totalSignals ?? 0);
}

const n = totals.totalSignals || 1;
console.log(JSON.stringify({
  sessionCount: totals.sessionCount,
  signalSessions: totals.signalSessions,
  totalSignals: totals.totalSignals,
  executedSignals: totals.executedSignals,
  gateRejectedSignals: totals.gateRejectedSignals,
  avgRawPct: 100 * totals.raw / n,
  avgAdjustedPct: 100 * totals.adj / n,
  avgMfePct: 100 * totals.mfe / n,
  avgMaePct: 100 * totals.mae / n,
}, null, 2));
NODE
```

해석:

- 이 단계는 `trigger-only`보다 현실적이다
- 그래도 완전한 live-equivalent expectancy는 아니다
- 이유: runtime state 일부는 `realtime-signals`에 안 남는다
- older session은 bootstrap trigger가 `volume_spike`로 저장됐을 수 있으므로, pure strategy attribution에는 contamination 주의를 둔다

---

## 4. Session Detail Table

세션별 편차를 먼저 본다.

```bash
node <<'NODE'
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const root = process.cwd();
const sessionsRoot = path.join(root, 'data/realtime/sessions');
const sessions = fs.readdirSync(sessionsRoot).filter((d) => d.endsWith('-live')).sort();

for (const session of sessions) {
  const dataset = path.join(sessionsRoot, session);
  const cmd =
    `npx tsx scripts/micro-backtest.ts --dataset ${JSON.stringify(dataset)} ` +
    `--trigger-type bootstrap --gate-mode off --horizon 300 --estimated-cost-pct 0.003 --json`;
  const out = cp.execSync(cmd, { cwd: root, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  const data = JSON.parse(out.slice(out.indexOf('{')));
  const signals = data.summary?.totalSignals ?? 0;
  if (signals === 0) continue;
  console.log(JSON.stringify({
    session,
    signals,
    avgAdjustedPct: 100 * (data.summary?.avgAdjustedReturnPct ?? 0),
    avgRawPct: 100 * (data.summary?.avgReturnPct ?? 0),
    avgMfePct: 100 * (data.summary?.avgMfePct ?? 0),
    avgMaePct: 100 * (data.summary?.avgMaePct ?? 0),
  }));
}
NODE
```

판정:

- 한두 세션이 전체 평균을 끌어올리는지 먼저 본다
- `signals`가 적은 극단 세션은 outlier로 따로 본다

---

## 5. Outlier Check

목적:

- 전체 플러스가 broad edge인지, 특정 세션 의존인지 구분한다

권장 순서:

1. baseline stored aggregate
2. 최고 수익 세션 제외
3. 최고+최저 세션 제외
4. `signals >= 10` 세션만 재집계

해석 기준:

- 최고 세션 하나 제외 시 전체 기대값이 음수면
  현재 전략은 broad edge보다 outlier dependence가 큰 상태다

---

## 6. Token Contribution

목적:

- 어떤 token이 수익을 만들고, 어떤 token이 비용만 먹는지 본다

단일 세션 token 분해:

```bash
npx tsx scripts/micro-backtest.ts \
  --dataset ./data/realtime/sessions/<session>-live \
  --trigger-type bootstrap \
  --gate-mode stored \
  --horizon 300 \
  --estimated-cost-pct 0.003 \
  --include-records \
  --json
```

위 결과의 `records`에서 아래를 본다.

- `tokenMint`
- `tokenSymbol`
- `processing.status`
- `adjustedReturnPct`
- `mfePct`
- `maePct`

권장 그룹:

- `runner`: 평균 adjusted가 크고 fat-tail upside가 큰 token
- `flat/noise`: `raw≈0`, `adjusted≈-0.3%`
- `negative churn`: 자주 잡히지만 평균 손실인 token

---

## 7. Runner vs Flat/Noise

현재 해석은 아래 세 질문으로 고정한다.

1. `runner`는 어떤 조건에서만 나오는가
2. `flat/noise`는 어떤 신호 구조를 가지는가
3. `negative churn`은 왜 반복 진입되는가

추천 비교 축:

- `trigger.volumeRatio`
- `atr / referencePrice`
- `processing.status`
- `attentionScore`
- `poolTvl`
- `currentVolume24hUsd`
- 세션 집중도

중요:

- `attention`이 높다고 좋은 token은 아니다
- `high liquidity`가 곧 runner는 아니다
- 지금까지는 `flat/noise suppress`가 `runner discovery`보다 우선순위가 높다

---

## 8. Decision Rules

분석 후 액션은 아래 순서로 둔다.

### A. Flat/noise suppress

아래가 보이면 가장 먼저 본다.

- `raw 0%`, `adjusted -0.3%`
- 특정 token이 여러 세션에서 같은 패턴 반복

후속 후보:

- replay blacklist
- per-token signal cap
- repeated flat suppress

### B. Negative churn suppress

아래가 보이면 다음으로 본다.

- 특정 token이 high attention/high liquidity인데 평균 손실
- same token 반복 진입

후속 후보:

- stronger cooldown
- per-token daily cap
- repeated-loss penalty

### C. Metadata gap close

아래가 비어 있으면 measurement 보강을 먼저 본다.

- `marketCapUsd`
- `volumeMcapRatio`
- provenance / discovery source

이 정보가 없으면 “왜 잡았는지” 복원이 약하다.

---

## Example Snapshot

2026-04-05 기준 최근 replay 예시는 아래와 같았다.

이 섹션은 절차 문서의 기준선이 아니라, 문서를 처음 여는 사람이 해석 방향을 빠르게 잡기 위한 예시 snapshot이다.
다음 분석에서 값이 바뀌면 이 섹션보다 위 절차를 우선한다.

- `bootstrap_10s`는 죽은 전략은 아니다
- 하지만 현재 플러스는 특정 runner 세션 의존이 크다
- `$slop`류 runner가 성과를 끌어올렸다
- `pippin`류는 high-attention/high-liquidity인데 평균 손실이었다
- `flat/noise` token은 raw가 0이라 비용만 손실로 남았다

즉 지금 우선순위는:

1. `flat/noise` 차단
2. `negative churn` 억제
3. signal-time metadata 강화

새 전략 추가는 그 다음이다.
