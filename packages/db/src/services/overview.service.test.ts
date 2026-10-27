/**
 * Coverage for the surface filter's session-id sub-select (`getSurfaceConds`,
 * private, so driven through the public `getRawWhereClause` the way every call
 * site does) — see SURFACE_FILTER in overview.service.ts.
 *
 * Most assertions are plain string checks. The `itCH` ones additionally EXPLAIN
 * the emitted WHERE against the real tables, which works here because
 * `embed_surface` is a MATERIALIZED column (code-migration 22) present on local
 * dev CH; they auto-skip without one (`pnpm dock:up`). Mirrors chart-sql.test.ts.
 */
import type { IChartEventFilter } from '@openpanel/validation';
import sqlstring from 'sqlstring';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ch } from '../clickhouse/client';
import { clix } from '../clickhouse/query-builder';
import { OverviewService } from './overview.service';

const svc = new OverviewService(ch);

const PROJECT_ID = 'daily-mail';
const START = '2026-07-01 00:00:00';
const END = '2026-07-08 00:00:00';
const scope = { projectId: PROJECT_ID, startDate: START, endDate: END };

const surfaceFilter = (
  value: IChartEventFilter['value'],
): IChartEventFilter => ({ name: 'surface', operator: 'is', value });

let chReachable = false;

async function explain(sql: string): Promise<void> {
  await ch.command({ query: `EXPLAIN ${sql}` });
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await ch.command({ query: 'SELECT 1' });
    chReachable = true;
  } catch {
    chReachable = false;
  }
});

afterAll(() => {
  vi.restoreAllMocks();
});

const itCH = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!chReachable) {
      console.warn(
        '[overview.service] skipping: ClickHouse not reachable at CLICKHOUSE_URL',
      );
      return;
    }
    await fn();
  });

describe('overview.service / getRawWhereClause (surface filter)', () => {
  it('emits no SQL when no surface filter is present (common path untouched)', () => {
    const where = svc.getRawWhereClause('sessions', [], scope);
    expect(where).toBe('');
  });

  // No "scope is absent" case: `scope` is required, so omitting it is a compile
  // error. See the fork note on getRawWhereClause.

  it('passes a single raw value straight through, unbucketed', () => {
    const where = svc.getRawWhereClause(
      'sessions',
      [surfaceFilter(['news_web'])],
      scope,
    );
    expect(where).toContain("embed_surface IN ('news_web')");
  });

  it('unions multiple values with IN, not a single equality', () => {
    const where = svc.getRawWhereClause(
      'sessions',
      [surfaceFilter(['app', 'news_web'])],
      scope,
    );
    expect(where).toContain("embed_surface IN ('app', 'news_web')");
  });

  it('never maps a value into a fixed bucket — an arbitrary host vocabulary passes untouched', () => {
    const where = svc.getRawWhereClause(
      'sessions',
      [surfaceFilter(['game_app'])],
      scope,
    );
    expect(where).toContain("embed_surface IN ('game_app')");
  });

  it('matches the sessions table on `id`', () => {
    const where = svc.getRawWhereClause(
      'sessions',
      [surfaceFilter(['app'])],
      scope,
    );
    expect(where).toMatch(/^id IN \(SELECT DISTINCT session_id FROM events/);
  });

  it('matches the events table on `session_id`', () => {
    const where = svc.getRawWhereClause(
      'events',
      [surfaceFilter(['app'])],
      scope,
    );
    expect(where).toMatch(
      /^session_id IN \(SELECT DISTINCT session_id FROM events/,
    );
  });

  it('bounds the sub-select by the same project and date range the outer query carries', () => {
    const where = svc.getRawWhereClause(
      'sessions',
      [surfaceFilter(['app'])],
      scope,
    );
    expect(where).toContain(`project_id = ${sqlstring.escape(PROJECT_ID)}`);
    // clix.datetime normalizes through `new Date(...).toISOString()`, shifting
    // by the runner's local timezone — go through it rather than hardcoding.
    expect(where).toContain(
      `created_at BETWEEN toDateTime(${sqlstring.escape(clix.datetime(START))}) AND toDateTime(${sqlstring.escape(clix.datetime(END))})`,
    );
  });

  it('drops the pre-ADR-0008 "not set" empty string rather than matching every un-instrumented session', () => {
    const where = svc.getRawWhereClause(
      'sessions',
      [surfaceFilter(['app', ''])],
      scope,
    );
    expect(where).toContain("embed_surface IN ('app')");
    expect(where).not.toContain("''");
  });

  it('drops the filter (no SQL) when every value is the empty string', () => {
    const where = svc.getRawWhereClause(
      'sessions',
      [surfaceFilter([''])],
      scope,
    );
    expect(where).toBe('');
  });

  it('drops the filter (no SQL) when value is an empty array', () => {
    const where = svc.getRawWhereClause(
      'sessions',
      [surfaceFilter([])],
      scope,
    );
    expect(where).toBe('');
  });

  it('drops the filter (no SQL) rather than emitting IN () when value is absent', () => {
    const where = svc.getRawWhereClause(
      'sessions',
      // biome-ignore lint: exercising the missing-value shape a client can send
      [{ name: 'surface', operator: 'is' } as IChartEventFilter],
      scope,
    );
    expect(where).toBe('');
    expect(where).not.toContain('IN ()');
  });

  it('escapes a single-quote / injection attempt in the surface value', () => {
    const malicious = "app'); DROP TABLE events; --";
    const where = svc.getRawWhereClause(
      'sessions',
      [surfaceFilter([malicious])],
      scope,
    );
    expect(where).toContain(`embed_surface IN (${sqlstring.escape(malicious)})`);
    // The literal is escaped inside quotes — no unescaped `');` breaking out.
    expect(where).not.toContain("app'); DROP TABLE");
  });

  it('composes with another filter (country) without dropping either', () => {
    const where = svc.getRawWhereClause(
      'sessions',
      [
        { name: 'country', operator: 'is', value: ['US'] },
        surfaceFilter(['app']),
      ],
      scope,
    );
    expect(where).toMatch(/(?<![._\w])country\s*=\s*'US'/);
    expect(where).toContain("embed_surface IN ('app')");
    expect(where).toContain(' AND ');
  });

  itCH(
    'parses against the real sessions table (id sub-select against events.embed_surface)',
    async () => {
      const where = svc.getRawWhereClause(
        'sessions',
        [surfaceFilter(['app', 'news_web'])],
        scope,
      );
      await explain(
        `SELECT count() FROM sessions WHERE project_id = '${PROJECT_ID}' AND ${where}`,
      );
    },
  );

  itCH(
    'parses against the real events table (session_id sub-select against events.embed_surface)',
    async () => {
      const where = svc.getRawWhereClause(
        'events',
        [surfaceFilter(['app', 'news_web'])],
        scope,
      );
      await explain(
        `SELECT count() FROM events WHERE project_id = '${PROJECT_ID}' AND ${where}`,
      );
    },
  );
});
