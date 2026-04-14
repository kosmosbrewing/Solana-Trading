/**
 * CUSUM (Cumulative Sum) Volume Regime Change Detector
 *
 * Why: bootstrap trigger 는 단일 캔들이 threshold 를 초과해야 발화 → spike peak 에서 감지.
 * CUSUM 은 누적 편차를 추적하여 volume mean 이 shift 하는 시점을 조기 감지.
 * 여러 캔들에 걸쳐 evidence 를 축적하므로 개별 캔들이 multiplier 미만이어도
 * "평균이 이동하고 있다"는 것을 감지할 수 있다.
 *
 * Phase 0: observation-only. Gate log 에 strength 기록만 하고 trade 결정에 영향 없음.
 * Phase 1: 50+ trades 축적 후 strength-outcome 상관 분석 → gate factor 편입 여부 결정.
 *
 * 수학:
 *   logVol = log(volume + 1)
 *   Welford online update: mean, variance (σ²)
 *   allowance = k × σ
 *   threshold = h × σ
 *   S_t = max(0, S_{t-1} + (logVol - mean - allowance))
 *   signal = S_t > threshold
 *   strength = S_t / threshold (0~1+, 1 이상이면 signal)
 *   reset S_t = 0 after signal (cooldown 은 caller 가 관리)
 */

// ─── Types ───

export interface CusumConfig {
  kMultiplier: number;    // allowance = k × σ. 작을수록 민감. default: 0.3
  hMultiplier: number;    // threshold = h × σ. 클수록 신중. default: 4.0
  warmupPeriods: number;  // mean/std 안정화에 필요한 최소 캔들 수. default: 10
}

export interface CusumState {
  cumSum: number;         // 누적 편차 (upward CUSUM)
  logMean: number;        // running mean of log(volume+1)
  logM2: number;          // running M2 for Welford's variance
  sampleCount: number;    // 관찰된 캔들 수
}

export interface CusumResult {
  signal: boolean;        // threshold 초과 여부
  strength: number;       // cumSum / threshold (0~1+, 1 이상이면 signal)
  state: CusumState;      // 갱신된 state
}

// ─── Core Functions ───

export function initCusumState(): CusumState {
  return {
    cumSum: 0,
    logMean: 0,
    logM2: 0,
    sampleCount: 0,
  };
}

export function updateCusum(
  state: CusumState,
  volume: number,
  config: CusumConfig
): CusumResult {
  const logVol = Math.log(volume + 1);

  // Welford's online algorithm for running mean and variance
  const n = state.sampleCount + 1;
  const delta = logVol - state.logMean;
  const newMean = state.logMean + delta / n;
  const delta2 = logVol - newMean;
  const newM2 = state.logM2 + delta * delta2;

  const newState: CusumState = {
    cumSum: state.cumSum,
    logMean: newMean,
    logM2: newM2,
    sampleCount: n,
  };

  // Warmup: σ 안정화 전에는 signal 발생 안 함
  if (n < config.warmupPeriods) {
    return { signal: false, strength: 0, state: newState };
  }

  // Welford variance → σ
  const variance = newM2 / (n - 1);
  const sigma = Math.sqrt(Math.max(variance, 1e-12));

  const allowance = config.kMultiplier * sigma;
  const threshold = config.hMultiplier * sigma;

  // CUSUM update: S_t = max(0, S_{t-1} + (logVol - mean - allowance))
  const newCumSum = Math.max(0, state.cumSum + (logVol - newMean - allowance));
  newState.cumSum = newCumSum;

  // Signal detection
  const strength = threshold > 0 ? newCumSum / threshold : 0;
  const signal = newCumSum > threshold;

  // Reset after signal (caller manages cooldown)
  if (signal) {
    newState.cumSum = 0;
  }

  return { signal, strength, state: newState };
}
