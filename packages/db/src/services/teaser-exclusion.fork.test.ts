/**
 * Teaser-only sessions leave the board's session cards (teaser-exclusion.fork.ts,
 * code-migration 24).
 *
 * Seeds two throwaway projects on local dev ClickHouse (`pnpm dock:up`,
 * code-migrations 24 and 25 applied): one with a Teaser, one without. The flags come
 * from the real `session_flags_mv`, so the hub-in-a-later-hour flip is the
 * engine's, not a fixture's. Reports SKIPPED, never passed, without CH.
 */
import { getRedisCache } from '@openpanel/redis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ch } from '../clickhouse/client';
import { eventBuffer } from '../buffers';
import { overviewService } from './overview.service';
import { excludeTeaserOnlyLive } from './teaser-exclusion.fork';

const TEASER_PROJECT = 'teaser-exclusion-test';
const PLAIN_PROJECT = 'teaser-exclusion-test-plain';

const chReachable = await ch
  .command({ query: 'SELECT 1' })
  .then(() => true)
  .catch(() => false);

const itCH = chReachable ? it : it.skip;

const DAY = '2026-07-01';
const range = (projectId: string) => ({
  projectId,
  startDate: `${DAY} 00:00:00`,
  endDate: `${DAY} 23:59:59`,
  timezone: 'UTC',
  filters: [],
});

type Session = {
  id: string;
  device: string;
  country: string;
  start: string;
  events: Array<[name: string, time: string, path: string, props?: Record<string, string>]>;
};

const TEASER = { variant: 'teaser', game_id: 'circuit', level_id: 'teaser:0' };

// Teaser-only: an article reader who saw and played the Teaser.
const teaserOnly = (id: string, start = `${DAY} 10:10:00`): Session => ({
  id,
  device: 'mobile',
  country: 'US',
  start,
  events: [
    ['session_start', start, '/article'],
    ['screen_view', start, '/article'],
    ['teaser_viewed', start, '/article', TEASER],
    ['level_started', start, '/article', TEASER],
    ['screen_view', start, '/article/2'],
    // A host-page ad click: no level_id, so only the session tells it apart.
    ['link_out', start, '/article', { href: 'https://ads.example.test' }],
  ],
});

// A reader whose Teaser never scrolled into view: only the Teaser's own
// screen_view, which has no level_id.
const teaserScreenOnly: Session = {
  id: 'screen',
  device: 'mobile',
  country: 'US',
  start: `${DAY} 10:20:00`,
  events: [
    ['session_start', `${DAY} 10:20:00`, '/article'],
    ['screen_view', `${DAY} 10:20:00`, '/article'],
    ['screen_view', `${DAY} 10:20:01`, '/article', { variant: 'teaser', game_id: 'circuit' }],
  ],
};

// Teaser at 10:50, hub at 11:10: the evidence lands in a later hour bucket.
const teaserThenHub: Session = {
  id: 'hub',
  device: 'desktop',
  country: 'DE',
  start: `${DAY} 10:50:00`,
  events: [
    ['session_start', `${DAY} 10:50:00`, '/article'],
    ['screen_view', `${DAY} 10:50:00`, '/article'],
    ['teaser_viewed', `${DAY} 10:50:00`, '/article', TEASER],
    ['screen_view', `${DAY} 11:10:00`, '/games/circuit'],
    ['game_viewed', `${DAY} 11:10:00`, '/games/circuit', { game_id: 'circuit', ref: 'teaser' }],
  ],
};

const fullGame: Session = {
  id: 'full',
  device: 'tablet',
  country: 'CH',
  start: `${DAY} 12:00:00`,
  events: [
    ['session_start', `${DAY} 12:00:00`, '/games/circuit'],
    ['screen_view', `${DAY} 12:00:00`, '/games/circuit'],
    ['screen_view', `${DAY} 12:01:00`, '/games/circuit/2'],
    ['game_viewed', `${DAY} 12:00:00`, '/games/circuit', { game_id: 'circuit' }],
    ['level_started', `${DAY} 12:01:00`, '/games/circuit', { game_id: 'circuit', level_id: 'c1' }],
    ['link_out', `${DAY} 12:02:00`, '/games/circuit', { href: 'https://example.test/more' }],
  ],
};

let seq = 0;
function eventRows(projectId: string, s: Session) {
  return s.events.map(([name, created_at, path, properties = {}]) => {
    seq += 1;
    return {
      id: `00000000-0000-0000-0000-0000000011${String(seq).padStart(2, '0')}`,
      project_id: projectId,
      profile_id: `profile-${s.id}`,
      device_id: `device-${s.id}`,
      session_id: `${projectId}-${s.id}`,
      name,
      created_at,
      path,
      origin: 'https://example.test',
      country: s.country,
      device: s.device,
      properties,
    };
  });
}

function sessionRow(projectId: string, s: Session) {
  const views = s.events.filter(([name]) => name === 'screen_view');
  return {
    id: `${projectId}-${s.id}`,
    project_id: projectId,
    profile_id: `profile-${s.id}`,
    device_id: `device-${s.id}`,
    created_at: s.start,
    ended_at: s.events.at(-1)![1],
    is_bounce: views.length < 2,
    entry_path: views[0]![2],
    exit_path: views.at(-1)![2],
    screen_view_count: views.length,
    event_count: s.events.length,
    duration: 60_000,
    country: s.country,
    device: s.device,
    sign: 1,
    version: 1,
  };
}

// Server-sent, outside any session; must never be dropped.
const sessionless = (projectId: string, created_at: string) => ({
  id: `00000000-0000-0000-0000-0000000012${String(++seq).padStart(2, '0')}`,
  project_id: projectId,
  profile_id: 'profile-server',
  device_id: 'device-server',
  session_id: '',
  name: 'purchase',
  created_at,
  path: '',
  country: 'FR',
  properties: {},
});

const SESSIONS = [teaserOnly('t1'), teaserOnly('t2'), teaserScreenOnly, teaserThenHub, fullGame];

async function cleanup() {
  const projects = `('${TEASER_PROJECT}', '${PLAIN_PROJECT}')`;
  const settings = { mutations_sync: '1' } as const;
  await Promise.all([
    ch.command({ query: `DELETE FROM openpanel.events WHERE project_id IN ${projects}` }),
    ch.command({ query: `DELETE FROM openpanel.sessions WHERE project_id IN ${projects}` }),
    ch.command({
      query: `ALTER TABLE openpanel.session_flags DELETE WHERE project_id IN ${projects}`,
      clickhouse_settings: settings,
    }),
    ch.command({
      query: `ALTER TABLE openpanel.distinct_event_names_mv DELETE WHERE project_id IN ${projects}`,
      clickhouse_settings: settings,
    }),
  ]);
  const redis = getRedisCache();
  const keys = await redis.keys('cachable:fetchFirstTeaserAt:*teaser-exclusion-test*');
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  if (!chReachable) {
    return;
  }
  await cleanup();
  const plainSessions = [fullGame, { ...fullGame, id: 'full2' }];
  await ch.insert({
    table: 'openpanel.events',
    format: 'JSONEachRow',
    values: [
      ...SESSIONS.flatMap((s) => eventRows(TEASER_PROJECT, s)),
      sessionless(TEASER_PROJECT, `${DAY} 13:00:00`),
      ...plainSessions.flatMap((s) => eventRows(PLAIN_PROJECT, s)),
      sessionless(PLAIN_PROJECT, `${DAY} 13:00:00`),
      // Live: one Teaser-only reader and one player right now.
      ...eventRows(TEASER_PROJECT, { ...teaserOnly('live-t', now()), id: 'live-t' }),
      ...eventRows(TEASER_PROJECT, {
        ...fullGame,
        id: 'live-p',
        events: fullGame.events.map(([n, , p, props]) => [n, now(), p, props]),
      }),
    ],
  });
  await ch.insert({
    table: 'openpanel.sessions',
    format: 'JSONEachRow',
    values: [
      ...SESSIONS.map((s) => sessionRow(TEASER_PROJECT, s)),
      ...plainSessions.map((s) => sessionRow(PLAIN_PROJECT, s)),
    ],
  });
});

afterAll(async () => {
  if (chReachable) {
    await cleanup();
  }
  vi.restoreAllMocks();
});

describe('Teaser-only sessions on the board', () => {
  itCH('leave sessions, visitors and pageviews', async () => {
    const { metrics } = await overviewService.getMetrics({
      ...range(TEASER_PROJECT),
      interval: 'day',
    });
    expect(metrics.total_sessions).toBe(2);
    expect(metrics.unique_visitors).toBe(2);
    expect(metrics.total_screen_views).toBe(4);
  });

  itCH('leave sessions under a page filter, which reads events', async () => {
    const { metrics } = await overviewService.getMetrics({
      ...range(TEASER_PROJECT),
      filters: [{ id: 'p', name: 'path', operator: 'is', value: ['/article'] }],
      interval: 'day',
    });
    expect(metrics.total_sessions).toBe(1);
    expect(metrics.unique_visitors).toBe(1);
  });

  itCH('leave Avg DAU', async () => {
    const { metrics, series } = await overviewService.getEventMetrics({
      ...range(TEASER_PROJECT),
      interval: 'day',
    });
    expect(metrics.avg_dau).toBe(2);
    expect(series.find((r) => r.date.startsWith(DAY))?.avg_dau).toBe(2);
  });

  itCH('leave Devices and Geo', async () => {
    const devices = await overviewService.getTopGeneric({
      ...range(TEASER_PROJECT),
      column: 'device',
    });
    expect(devices.map((r) => r.name).sort()).toEqual(['desktop', 'tablet']);

    const countries = await overviewService.getTopGeneric({
      ...range(TEASER_PROJECT),
      column: 'country',
    });
    expect(countries.map((r) => r.name).sort()).toEqual(['CH', 'DE']);

    const series = await overviewService.getTopGenericSeries({
      ...range(TEASER_PROJECT),
      column: 'device',
      interval: 'day',
    });
    expect(series.items.map((r) => r.name).sort()).toEqual(['desktop', 'tablet']);
  });

  itCH('leave the map, which keeps sessionless events', async () => {
    const map = await overviewService.getMapData(range(TEASER_PROJECT));
    expect(map.map((r) => r.country).sort()).toEqual(['CH', 'DE', 'FR']);
  });

  itCH('leave the user journey', async () => {
    const { nodes } = await overviewService.getUserJourney({
      ...range(TEASER_PROJECT),
      steps: 5,
    });
    const entries = nodes.filter((n) => n.step === 1).map((n) => n.label);
    expect(entries.sort()).toEqual([
      'https://example.test/article',
      'https://example.test/games/circuit',
    ]);
    const article = nodes.find((n) => n.id === 'https://example.test/article::step1');
    expect(article?.value).toBe(1);
  });

  itCH('leave the live counter', async () => {
    expect(await eventBuffer.getActiveVisitorCount(TEASER_PROJECT)).toBe(1);
  });

  itCH('leave a live card that runs in the project timezone', async () => {
    const keep = await excludeTeaserOnlyLive(TEASER_PROJECT);
    const result = await ch.query({
      query: `SELECT groupUniqArray(session_id) AS ids FROM events
        WHERE project_id = '${TEASER_PROJECT}'
          AND created_at >= now() - INTERVAL 30 MINUTE AND ${keep}`,
      clickhouse_settings: { session_timezone: 'Pacific/Kiritimati' },
      format: 'JSONEachRow',
    });
    const [row] = await result.json<{ ids: string[] }>();
    expect(row?.ids).toEqual([`${TEASER_PROJECT}-live-p`]);
  });

  itCH('leave Top events, which also drops Teaser plays per event', async () => {
    const events = await overviewService.getTopEvents(range(TEASER_PROJECT));
    const counts = Object.fromEntries(events.map((e) => [e.name, e.count]));
    expect(counts.teaser_viewed).toBeUndefined();
    expect(counts.level_started).toBe(1);
    expect(counts.game_viewed).toBe(2);
    expect(counts.link_out).toBe(1);
    expect(counts.purchase).toBe(1);
  });
});

describe('A project without a Teaser', () => {
  itCH('sends no session_flags lookup and keeps every session', async () => {
    const sqls: string[] = [];
    const query = ch.query.bind(ch);
    const spy = vi.spyOn(ch, 'query').mockImplementation((params) => {
      sqls.push(params.query);
      return query(params);
    });
    const r = range(PLAIN_PROJECT);
    const [{ metrics }, events, devices, map] = await Promise.all([
      overviewService.getMetrics({ ...r, interval: 'day' }),
      overviewService.getEventMetrics({ ...r, interval: 'day' }),
      overviewService.getTopGeneric({ ...r, column: 'device' }),
      overviewService.getMapData(r),
      overviewService.getUserJourney({ ...r, steps: 5 }),
      eventBuffer.getActiveVisitorCount(PLAIN_PROJECT),
    ]);
    spy.mockRestore();

    expect(metrics.total_sessions).toBe(2);
    expect(events.metrics.avg_dau).toBe(2);
    expect(devices).toHaveLength(1);
    expect(map.map((m) => m.country).sort()).toEqual(['CH', 'FR']);
    expect(sqls.length).toBeGreaterThan(5);
    expect(sqls.filter((sql) => sql.includes('session_flags'))).toEqual([]);
  });
});
