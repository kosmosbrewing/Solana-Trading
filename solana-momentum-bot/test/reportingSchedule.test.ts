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

  it('does not send scheduled reports outside the exact minute or schedule', () => {
    expect(getScheduledReportType(new Date('2026-04-05T14:59:00.000Z'))).toBeNull(); // 23:59 KST
    expect(getScheduledReportType(new Date('2026-04-05T16:01:00.000Z'))).toBeNull(); // 01:01 KST
    expect(getScheduledReportType(new Date('2026-04-06T02:00:00.000Z'))).toBeNull(); // 11:00 KST
  });
});
