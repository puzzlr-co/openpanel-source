/**
 * Avg DAU averages players per day of the project's timezone (fork-only).
 *
 * Seeds a throwaway project on local dev ClickHouse (`pnpm dock:up`). Reports
 * SKIPPED, never passed, without CH.
 */
import { DateTime } from '@openpanel/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ch } from '../clickhouse/client';
import { overviewService } from './overview.service';

const PROJECT = 'avg-dau-timezone-test';
const TODAY_PROJECT = 'avg-dau-today-test';
const TZ = 'Europe/Stockholm';

const chReachable = await ch
  .command({ query: 'SELECT 1' })
  .then(() => true)
  .catch(() => false);

const itCH = chReachable ? it : it.skip;

// UTC instants. In Europe/Stockholm (UTC+2 in July) `a` falls on 07-01, so
// 07-01 has three players and 07-02 one. UTC days would read 06-30: 1,
// 07-01: 2, 07-02: 1.
const SESSION_STARTS: Array<[device: string, utc: string]> = [
  ['a', '2026-06-30 22:30:00'],
  ['b', '2026-07-01 10:00:00'],
  ['c', '2026-07-01 11:00:00'],
  ['d', '2026-07-02 10:00:00'],
];

// The day before yesterday has one player, yesterday three, and today, still
// running, one so far.
const now = DateTime.now().setZone(TZ);
const yesterday = now.minus({ day: 1 }).startOf('day');
const dayBefore = yesterday.minus({ day: 1 });
const TODAY_STARTS: Array<[device: string, at: DateTime]> = [
  ['w', dayBefore.plus({ hours: 9 })],
  ['x', yesterday.plus({ hours: 9 })],
  ['y', yesterday.plus({ hours: 10 })],
  ['z', yesterday.plus({ hours: 11 })],
  ['x', now],
];

const utc = (at: DateTime) => at.toUTC().toFormat('yyyy-MM-dd HH:mm:ss');
const wallClock = (at: DateTime) => `${at.toFormat("yyyy-MM-dd'T'HH:mm:ss")}Z`;

async function cleanup() {
  await ch.command({
    query: `DELETE FROM openpanel.events WHERE project_id IN ('${PROJECT}', '${TODAY_PROJECT}')`,
  });
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  if (!chReachable) {
    return;
  }
  await cleanup();
  await ch.insert({
    table: 'openpanel.events',
    format: 'JSONEachRow',
    values: SESSION_STARTS.map(([device, created_at], i) => ({
      id: `00000000-0000-0000-0000-0000000021${String(i).padStart(2, '0')}`,
      project_id: PROJECT,
      profile_id: `profile-${device}`,
      device_id: `device-${device}`,
      session_id: `session-${device}`,
      name: 'session_start',
      created_at,
      path: '/',
      properties: {},
    })),
  });
  await ch.insert({
    table: 'openpanel.events',
    format: 'JSONEachRow',
    values: TODAY_STARTS.map(([device, at], i) => ({
      id: `00000000-0000-0000-0000-0000000022${String(i).padStart(2, '0')}`,
      project_id: TODAY_PROJECT,
      profile_id: `profile-${device}`,
      device_id: `device-${device}`,
      session_id: `session-${device}-${i}`,
      name: 'session_start',
      created_at: utc(at),
      path: '/',
      properties: {},
    })),
  });
});

function avgDau(startDate: DateTime, endDate: DateTime) {
  return overviewService.getEventMetrics({
    projectId: TODAY_PROJECT,
    startDate: wallClock(startDate),
    endDate: wallClock(endDate),
    timezone: TZ,
    interval: 'day',
    filters: [],
  });
}

afterAll(async () => {
  if (chReachable) {
    await cleanup();
  }
  vi.restoreAllMocks();
});

describe('Avg DAU', () => {
  itCH('averages days of the project timezone over the range only', async () => {
    const { metrics, series } = await overviewService.getEventMetrics({
      projectId: PROJECT,
      // Wall-clock bounds, as the router passes them on a UTC server; the Z
      // keeps clix.datetime from shifting them by the runner's timezone.
      startDate: '2026-07-01T00:00:00Z',
      endDate: '2026-07-02T23:59:59Z',
      timezone: 'Europe/Stockholm',
      interval: 'day',
      filters: [],
    });
    expect(series.map((r) => r.avg_dau)).toEqual([3, 1]);
    expect(metrics.avg_dau).toBe(2);
  });

  itCH('leaves out today while it is still running', async () => {
    const { metrics } = await avgDau(yesterday, now.endOf('day'));
    expect(metrics.avg_dau).toBe(3);
  });

  itCH('leaves out the last day when the range ends inside it', async () => {
    const { metrics } = await avgDau(dayBefore, yesterday.plus({ hours: 10, minutes: 30 }));
    expect(metrics.avg_dau).toBe(1);
  });

  itCH('uses today when the range has no complete day', async () => {
    const { metrics } = await avgDau(now.startOf('day'), now.endOf('day'));
    expect(metrics.avg_dau).toBe(1);
  });
});
