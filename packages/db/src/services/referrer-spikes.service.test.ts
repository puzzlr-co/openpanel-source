/**
 * Regression coverage for the one thing referrer-spikes must get right about
 * the surface filter: hand the query's scope down to `getRawWhereClause`.
 * Omitting it shipped once (main-13e18da) and computed spike markers across
 * every surface while the chart line under them was scoped to one — wrong, and
 * invisibly so.
 *
 * The service builds its WHERE clause before touching ClickHouse, so the spy
 * below intercepts there, calls the real implementation to get the real emitted
 * SQL, and aborts — no ClickHouse required.
 */
import type { IChartEventFilter } from '@openpanel/validation';
import { describe, expect, it, vi } from 'vitest';
import { OverviewService, overviewService } from './overview.service';
import { getReferrerSpikes } from './referrer-spikes.service';

const PROJECT_ID = 'daily-mail';
const START = '2026-07-01 00:00:00';
const END = '2026-07-08 00:00:00';

const input = (filters: IChartEventFilter[]) => ({
  projectId: PROJECT_ID,
  filters,
  startDate: START,
  endDate: END,
  interval: 'day' as const,
  timezone: 'UTC',
});

/** Thrown by the spy to stop the service before it opens a ClickHouse client. */
const ABORT = new Error('abort: where clause captured');

/**
 * Runs getReferrerSpikes only as far as building its WHERE clause, and returns
 * both the arguments it passed and the clause the real implementation produced.
 */
async function captureWhereClause(filters: IChartEventFilter[]) {
  const real = OverviewService.prototype.getRawWhereClause;
  let args: unknown[] | undefined;
  let clause: string | undefined;

  const spy = vi
    .spyOn(overviewService, 'getRawWhereClause')
    .mockImplementation((...called) => {
      args = called;
      clause = real.apply(overviewService, called);
      throw ABORT;
    });

  try {
    await expect(getReferrerSpikes(input(filters))).rejects.toBe(ABORT);
  } finally {
    spy.mockRestore();
  }

  return { args, clause };
}

describe('referrer-spikes.service / surface filter', () => {
  it('threads the query scope into getRawWhereClause', async () => {
    const { args } = await captureWhereClause([]);

    expect(args).toEqual([
      'sessions',
      [],
      { projectId: PROJECT_ID, startDate: START, endDate: END },
    ]);
  });

  it('scopes its session queries by surface instead of discarding the filter', async () => {
    const { clause } = await captureWhereClause([
      { name: 'surface', operator: 'is', value: ['news_web'] },
    ]);

    expect(clause).toContain("embed_surface IN ('news_web')");
    expect(clause).toMatch(/^id IN \(SELECT DISTINCT session_id FROM events/);
    expect(clause).toContain(`project_id = '${PROJECT_ID}'`);
  });

  it('emits no extra SQL when no surface is selected (common path untouched)', async () => {
    const { clause } = await captureWhereClause([]);

    expect(clause).toBe('');
  });
});
