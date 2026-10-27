import { afterEach, describe, expect, it, vi } from 'vitest';
import { previousToElapsed } from './previous-period.fork';

const TZ = 'Europe/Stockholm';

// 2026-10-22 07:45 UTC = 09:45 Stockholm. "Last 7 days" runs 10-15 00:00 to
// 10-23 00:00, so the previous period is 10-07 00:00 to 10-15 00:00.
const LAST_7_DAYS = { startDate: '2026-10-15 00:00:00', endDate: '2026-10-23 00:00:00' };
const PREVIOUS = { startDate: '2026-10-07 00:00:00', endDate: '2026-10-15 00:00:00' };

afterEach(() => {
  vi.useRealTimers();
});

describe('previousToElapsed', () => {
  it('ends the previous period at the same elapsed time as now', () => {
    vi.useFakeTimers({ now: new Date('2026-10-22T07:45:30Z') });
    expect(previousToElapsed(LAST_7_DAYS, PREVIOUS, TZ, false)).toEqual({
      startDate: '2026-10-07 00:00:00',
      endDate: '2026-10-14 09:45:30',
    });
  });

  it('rounds to the hour for cached ranges', () => {
    vi.useFakeTimers({ now: new Date('2026-10-22T07:45:30Z') });
    expect(previousToElapsed(LAST_7_DAYS, PREVIOUS, TZ, true).endDate).toBe(
      '2026-10-14 09:00:00',
    );
  });

  it('leaves a past range whole', () => {
    vi.useFakeTimers({ now: new Date('2026-10-22T07:45:30Z') });
    const week = { startDate: '2026-10-15 00:00:00', endDate: '2026-10-21 23:59:59' };
    const prev = { startDate: '2026-10-08 00:00:01', endDate: '2026-10-15 00:00:00' };
    expect(previousToElapsed(week, prev, TZ, true)).toEqual(prev);
  });
});
