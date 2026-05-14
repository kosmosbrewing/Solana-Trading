/**
 * Policy Guards (2026-04-21 QA F5)
 *
 * Mission refinement (2026-04-21) 의 Real Asset Guard 중 `fixed ticket = 0.01 SOL` 정책값을
 * **코드 레벨에서 강제** 하기 위한 모듈. 운영자 behavioral drift 방지 장치.
 *
 * Why: 과거 트레이더 실패의 가장 큰 벡터는 전략이 아니라 **본인 규율 붕괴**.
 *   - 3개월 bleeding 중 "한 번만" ticket 확대 → convexity 파괴 → ruin
 *   - Paper / 소액 실전에서는 모두 규율 지키지만, 실제 손실 누적 중 유혹 증가
 *
 * 본 모듈은 ticket size override 를 할 때 **의도적인 마찰** 을 추가한다.
 *   - env 값만 바꾸면 안 되고
 *   - 별도 ack env 도 정확한 형식으로 세팅해야 하고
 *   - ack 없으면 startup 에서 강제 복원 + Telegram 알림
 *
 * Stage 4 (200 trades scale/retire decision gate) 통과 후 정식 ticket 확대 결정을
 * 내릴 때만 ack 를 세팅하여 한다. 지금 당장 쉽게 변경 가능하면 "지금 Stage 4" 라고
 * 속이게 된다 — 이게 구조적 drift 방지의 핵심.
 */
import { createModuleLogger } from './logger';

const log = createModuleLogger('PolicyGuard');

/**
 * 정책 상한 (default): 명시적 lane override 없으면 이 값 이하여야 함.
 * **env 로 override 불가 — 코드 상수**. 변경하려면 git commit 필요.
 */
export const POLICY_TICKET_MAX_SOL = 0.01;

/**
 * Lane 별 정책 상한 override (Stage 4 partial-pass lane 만).
 *
 * **2026-04-28 (B안 운영자 결정)**: KOL hunter 0.03 → **0.02 SOL** (33% 후퇴).
 *
 * 배경:
 *   1차 결정 (0.03): paper n=401 / 5x+ winner 1건 입증 후 3x scale.
 *   B안 (0.02): live 24h n=44 데이터 도착 후 재산정.
 *     - Live ROI = -2.55% (bleeding), avg loss -32.95% (paper -12.69% 의 2.6x)
 *     - Catastrophic rate 4.5% (-100% PNL_DRIFT events 2건/44)
 *     - 8JH1J6p4 incident 같은 5중 cascade (security + entry delay + dump + 429 sell + ticket scale)
 *     - Live raw Kelly = 0% (-100% tail 영향)
 *
 * 0.02 SOL 산정 근거 (200-trade Stage 4 여정):
 *   - Wallet floor 0.6 SOL (2026-05-14 override; 이전 0.7 → 0.4 SOL drawdown budget)
 *   - 200 trade × 4.5% catastrophic = 9 events × 0.02 = 0.18 SOL
 *   - 200 trade × -2.55% ROI bleed = 0.102 SOL
 *   - 합계 drawdown ≈ 0.282 SOL → wallet 0.718 SOL (floor 0.6 margin +0.118)
 *   - Catastrophic 견딤: 15 events (예상 9건 + 6 buffer)
 *
 * 100-trade 검증 조건 (Tier 2 승격):
 *   - catastrophic rate < 2% AND per-trade ROI > 0% → 0.025 검토
 *   - catastrophic rate ≥ 4% (개선 없음) → 0.015 후퇴
 *
 * 다른 lane (pure_ws / cupsey / migration / pure_ws_swing_v2) 은 0.01 유지.
 */
export const POLICY_TICKET_MAX_SOL_BY_LANE: Readonly<Record<string, number>> = {
  kol_hunter: 0.02,
};

/**
 * Override ack 포맷: `stage4_approved_YYYY_MM_DD`
 * - `stage4_approved_` prefix — Stage 4 통과 후 결정임을 의도적으로 적시
 * - `YYYY_MM_DD` — ack 날짜 기록 (stale ack 방지용 future 확장 여지)
 */
const ACK_PATTERN = /^stage4_approved_\d{4}_\d{2}_\d{2}$/;

export function isValidTicketOverrideAck(ack: string | undefined | null): boolean {
  if (!ack || typeof ack !== 'string') return false;
  return ACK_PATTERN.test(ack.trim());
}

export interface TicketPolicyResult {
  /** lane 이름 (pure_ws / cupsey / migration) */
  lane: string;
  /** env / code 에서 설정된 원본 ticket 값 */
  configuredTicketSol: number;
  /** 정책 적용 후 실제 사용될 ticket 값 */
  effectiveTicketSol: number;
  /** override ack 가 유효한 형식으로 제공됐는지 */
  ackProvided: boolean;
  /** 정책 위반 여부 (max 초과 + ack 부재/무효) */
  violation: boolean;
  /** override 되었지만 ack 가 있어 허용된 경우 true */
  overrideAcknowledged: boolean;
}

/**
 * Lane 별 정책 상한 lookup. POLICY_TICKET_MAX_SOL_BY_LANE 에 entry 있으면 그 값,
 * 없으면 default POLICY_TICKET_MAX_SOL.
 */
export function getPolicyMaxForLane(lane: string): number {
  return POLICY_TICKET_MAX_SOL_BY_LANE[lane] ?? POLICY_TICKET_MAX_SOL;
}

/**
 * lane 별 ticket 정책 체크. 반환값의 `effectiveTicketSol` 을 실제 설정에 반영.
 * startup 1회 호출 — 운영자 개입 의존.
 *
 * @param lane       - "pure_ws" | "cupsey" | "migration" | "pure_ws_swing_v2" | "kol_hunter"
 * @param configuredTicketSol - env override 또는 code default 로 결정된 값
 * @param overrideAck - 해당 lane 의 `{LANE}_TICKET_OVERRIDE_ACK` env 값
 */
export function checkTicketPolicy(
  lane: string,
  configuredTicketSol: number,
  overrideAck: string | undefined | null
): TicketPolicyResult {
  // 2026-04-28: per-lane policy max (KOL hunter 0.03, 그 외 0.01 default).
  const laneMax = getPolicyMaxForLane(lane);
  // 부동소수점 오차 고려 (0.01 + 1e-12 같은 것)
  const withinPolicy = configuredTicketSol <= laneMax + 1e-9;

  if (withinPolicy) {
    return {
      lane,
      configuredTicketSol,
      effectiveTicketSol: configuredTicketSol,
      ackProvided: false,
      violation: false,
      overrideAcknowledged: false,
    };
  }

  const ackValid = isValidTicketOverrideAck(overrideAck);
  if (ackValid) {
    // 정당하게 확대: 그대로 통과, 단 loud warn 으로 기록
    return {
      lane,
      configuredTicketSol,
      effectiveTicketSol: configuredTicketSol,
      ackProvided: true,
      violation: false,
      overrideAcknowledged: true,
    };
  }

  // Policy 위반 — 강제 lane max 로 복원
  return {
    lane,
    configuredTicketSol,
    effectiveTicketSol: laneMax,
    ackProvided: false,
    violation: true,
    overrideAcknowledged: false,
  };
}

/**
 * startup 에서 3 lane 일괄 체크 + log / notifier 부작용.
 * - violation 발생 시 `.violation=true` 반환값 + CRITICAL 메시지 문자열 생성.
 * - caller 가 반환값의 `effectiveTicketSol` 로 config 갱신 책임.
 */
export function enforceTicketPolicyForAllLanes(
  lanes: Array<{
    lane: string;
    configuredTicketSol: number;
    ackEnvName: string;
    ackEnvValue: string | undefined;
  }>
): Array<TicketPolicyResult & { criticalMessage?: string; ackEnvName: string }> {
  const results: Array<TicketPolicyResult & { criticalMessage?: string; ackEnvName: string }> = [];
  for (const entry of lanes) {
    const result = checkTicketPolicy(entry.lane, entry.configuredTicketSol, entry.ackEnvValue);

    if (result.violation) {
      const laneMax = getPolicyMaxForLane(result.lane);
      const msg =
        `[POLICY_VIOLATION] lane=${result.lane} ticket=${result.configuredTicketSol} SOL ` +
        `exceeds policy max ${laneMax} SOL. Force-reverting to ${laneMax}. ` +
        `To override, reach Stage 4 and set ${entry.ackEnvName}=stage4_approved_YYYY_MM_DD.`;
      log.error(msg);
      results.push({ ...result, criticalMessage: msg, ackEnvName: entry.ackEnvName });
    } else if (result.overrideAcknowledged) {
      const laneMax = getPolicyMaxForLane(result.lane);
      log.warn(
        `[POLICY_ACK] lane=${result.lane} ticket=${result.configuredTicketSol} SOL ` +
        `(> policy ${laneMax}) with valid ack=${entry.ackEnvValue}. ` +
        `Proceeding — this is your explicit Stage-4 ticket expansion decision.`
      );
      results.push({ ...result, ackEnvName: entry.ackEnvName });
    } else {
      // within policy — silent
      results.push({ ...result, ackEnvName: entry.ackEnvName });
    }
  }
  return results;
}
