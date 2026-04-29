import { getScheduledReportType } from '../src/orchestration/reporting';

describe('report scheduling', () => {
  it('sends heartbeat at KST midnight and overnight even hours', () => {
    expect(getScheduledReportType(new Date('2026-04-05T15:00:00.000Z'))).toBe('heartbeat'); // 00:00 KST
    expect(getScheduledReportType(new Date('2026-04-05T17:00:00.000Z'))).toBe('heartbeat'); // 02:00 KST
    expect(getScheduledReportType(new Date('2026-04-05T21:00:00.000Z'))).toBe('heartbeat'); // 06:00 KST
  });

  it('prioritizes daily summary over heartbeat at 09:00 KST', () => {
    expect(getScheduledReportType(new Date('2026-04-06T00:00:00.000Z'))).toBe('daily');
  });

  // 2026-04-29: 매 KST 시간 hourly snapshot 추가. 짝수 시각은 heartbeat (더 자세) 우선.
  it('sends hourly snapshot at KST odd hours (heartbeat 가 아닌 시간대)', () => {
    expect(getScheduledReportType(new Date('2026-04-06T02:00:00.000Z'))).toBe('hourly'); // 11:00 KST
    expect(getScheduledReportType(new Date('2026-04-06T04:00:00.000Z'))).toBe('hourly'); // 13:00 KST (홀수 + non-09)
    expect(getScheduledReportType(new Date('2026-04-06T06:00:00.000Z'))).toBe('hourly'); // 15:00 KST
  });

  it('hourly 가 heartbeat 시간대 (짝수) 와 9:00 daily 와 충돌 안 함 (heartbeat/daily 우선)', () => {
    expect(getScheduledReportType(new Date('2026-04-06T00:00:00.000Z'))).toBe('daily'); // 09:00 KST
    expect(getScheduledReportType(new Date('2026-04-05T15:00:00.000Z'))).toBe('heartbeat'); // 00:00 KST (짝수)
  });

  // 2026-04-29 fix: minute-level filtering 이 getScheduledReportType 에서 제거됨.
  // 호출자 (scheduleDailySummary) 가 lastFiredUtcHour 로 fire-once-per-hour 보장 → event loop drift 무관.
  // getScheduledReportType 는 순수 KST hour → report type mapping 만 담당.
  it('returns the report type for any minute within the hour (caller dedups by hour)', () => {
    // 14:59 UTC = 23:59 KST → kstHour=23 (홀수, non-09) → 'hourly'
    expect(getScheduledReportType(new Date('2026-04-05T14:59:00.000Z'))).toBe('hourly');
    // 16:01 UTC = 01:01 KST → kstHour=1 (홀수, non-09) → 'hourly'
    expect(getScheduledReportType(new Date('2026-04-05T16:01:00.000Z'))).toBe('hourly');
    // 15:30 UTC = 00:30 KST → kstHour=0 (짝수) → 'heartbeat'
    expect(getScheduledReportType(new Date('2026-04-05T15:30:00.000Z'))).toBe('heartbeat');
  });
});
