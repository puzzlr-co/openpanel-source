/**
 * Coverage for overview-teaser.service.ts and the NOT_TEASER_PLAY seam in Games
 * and the Level completion card.
 *
 * teaserRates and foldTeaserTail are pure. The `itCH` block seeds one throwaway
 * project on local dev ClickHouse (`pnpm dock:up`, code-migration 23 applied)
 * because the hub join and the rollup total are only assertable against the
 * real engine. Those tests report as SKIPPED, never as passed, without CH.
 */
import type { IChartEventFilter } from '@openpanel/validation';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ch } from '../clickhouse/client';
import { overviewGamesService } from './overview-games.service';
import { overviewService } from './overview.service';
import {
  articleCutoverCached,
  foldTeaserTail,
  type ITeaserFunnelCounts,
  type ITeaserFunnelRow,
  overviewTeaserService,
  teaserRates,
} from './overview-teaser.service';

const PROJECT = 'teaser-funnel-test';
const EMPTY_PROJECT = 'teaser-funnel-test-empty';
const CUTOVER_PROJECT = 'teaser-funnel-test-cutover';

const chReachable = await ch
  .command({ query: 'SELECT 1' })
  .then(() => true)
  .catch(() => false);

const itCH = chReachable ? it : it.skip;

const RANGE = {
  projectId: PROJECT,
  startDate: '2026-07-01 00:00:00',
  endDate: '2026-07-02 00:00:00',
  timezone: 'UTC',
};

let seq = 0;
function event(
  session: string,
  name: string,
  path: string,
  properties: Record<string, string>,
) {
  seq += 1;
  return {
    id: `00000000-0000-0000-0000-0000000010${String(seq).padStart(2, '0')}`,
    project_id: PROJECT,
    profile_id: `profile-teaser-${session}`,
    name,
    session_id: `sess-teaser-${session}`,
    device_id: `dev-teaser-${session}`,
    created_at: '2026-07-01 12:00:00',
    path,
    properties,
  };
}

const teaser = (session: string, name: string, path: string) =>
  event(session, name, path, {
    variant: 'teaser',
    game_id: 'circuit',
    level_id: 'teaser:0',
  });

const hub = (session: string, name: string, levelId = '') =>
  event(session, name, '/hub', {
    game_id: 'circuit',
    ref: 'teaser',
    ...(levelId ? { level_id: levelId } : {}),
  });

const fullGame = (name: string, levelId: string) =>
  event('s6', name, '/games', { game_id: 'circuit', level_id: levelId });

// Before 11:00 the Teaser sent its article on plays but on only a few views.
const CUTOVER_EVENTS: Array<[session: string, name: string, time: string, path: string]> = [
  ['early', 'teaser_viewed', '10:00', ''],
  ['early', 'level_started', '10:01', '/x'],
  ['early-with-path', 'teaser_viewed', '10:05', '/x'],
  ['early-reader', 'teaser_viewed', '10:10', ''],
  ['solver', 'teaser_viewed', '11:00', '/x'],
  ['solver', 'level_started', '11:01', '/x'],
  ['solver', 'level_completed', '11:02', '/x'],
  ['solver', 'completion_cta_tapped', '11:03', '/x'],
  ['two-articles', 'teaser_viewed', '11:30', '/x'],
  ['two-articles', 'teaser_viewed', '11:40', '/y'],
  ['two-articles', 'level_started', '11:41', '/y'],
  ['reader', 'teaser_viewed', '11:50', '/y'],
];

function cutoverRows() {
  const teaserRows = CUTOVER_EVENTS.map(([session, name, time, path], i) => ({
    id: `00000000-0000-0000-0000-0000000031${String(i).padStart(2, '0')}`,
    project_id: CUTOVER_PROJECT,
    profile_id: `profile-${session}`,
    device_id: `device-${session}`,
    session_id: `cutover-${session}`,
    name,
    created_at: `2026-07-01 ${time}:00`,
    path,
    properties: { variant: 'teaser', game_id: 'circuit', level_id: 'teaser:0' },
  }));
  return [
    ...teaserRows,
    {
      ...teaserRows[0]!,
      id: '00000000-0000-0000-0000-000000003199',
      session_id: 'cutover-solver',
      name: 'game_viewed',
      created_at: '2026-07-01 11:04:00',
      path: '/hub',
      properties: { game_id: 'circuit', ref: 'teaser' },
    },
  ];
}

async function cleanup() {
  const projects = `('${PROJECT}', '${CUTOVER_PROJECT}')`;
  await Promise.all([
    ch.command({
      query: `DELETE FROM openpanel.events WHERE project_id IN ${projects}`,
    }),
    ch.command({
      query: `ALTER TABLE openpanel.distinct_event_names_mv DELETE WHERE project_id IN ${projects}`,
    }),
    ch.command({
      query: `ALTER TABLE openpanel.session_flags DELETE WHERE project_id IN ${projects}`,
    }),
    articleCutoverCached.clear(PROJECT),
    articleCutoverCached.clear(CUTOVER_PROJECT),
  ]);
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
    values: [
      teaser('s1', 'teaser_viewed', '/a'),
      teaser('s1', 'level_started', '/a'),
      teaser('s1', 'level_completed', '/a'),
      teaser('s1', 'completion_cta_tapped', '/a'),
      hub('s1', 'game_viewed'),
      teaser('s2', 'teaser_viewed', '/a'),
      teaser('s2', 'level_started', '/a'),
      teaser('s3', 'teaser_viewed', '/b'),
      teaser('s3', 'completion_cta_tapped', '/b'),
      teaser('s4', 'teaser_viewed', ''),
      hub('s5', 'game_viewed'),
      ...['c1', 'c2', 'c3', 'c4', 'c5'].map((l) => fullGame('level_started', l)),
      ...['c1', 'c2', 'c3'].map((l) => fullGame('level_completed', l)),
      ...cutoverRows(),
    ],
  });
});

afterAll(async () => {
  if (chReachable) {
    await cleanup();
  }
  vi.restoreAllMocks();
});

function counts(overrides: Partial<ITeaserFunnelCounts> = {}) {
  return { viewed: 0, started: 0, solved: 0, tapped: 0, reached: 0, ...overrides };
}

function named(key: string, viewed: number): ITeaserFunnelRow {
  const c = counts({ viewed, started: 1, tapped: 1, reached: 1 });
  return { ...c, ...teaserRates(c), kind: 'named', key };
}

function unrecorded(viewed: number): ITeaserFunnelRow {
  const c = counts({ viewed });
  return { ...c, ...teaserRates(c), kind: 'unrecorded_article' };
}

describe('teaserRates', () => {
  it('gives null for every zero denominator', () => {
    expect(teaserRates(counts())).toEqual({
      play_rate: null,
      solve_rate: null,
      tap_rate: null,
      arrival_rate: null,
    });
  });

  it('passes a rate above 100% uncapped', () => {
    expect(teaserRates(counts({ viewed: 2, started: 3 })).play_rate).toBe(150);
  });
});

describe('foldTeaserTail', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => named(`k${i}`, 100 - i));

  it('leaves 13 named rows untouched', () => {
    expect(foldTeaserTail(many(13), 12)).toEqual(many(13));
  });

  it('folds 14 named rows into 12 plus an other row with recomputed rates', () => {
    const result = foldTeaserTail(many(14), 12);
    expect(result).toHaveLength(13);
    const other = result[12]!;
    expect(other).toMatchObject({
      kind: 'other',
      other_count: 2,
      viewed: 88 + 87,
      tapped: 2,
      tap_rate: (2 * 100) / 175,
    });
  });

  it('never folds unrecorded_article and always puts it last', () => {
    const result = foldTeaserTail([unrecorded(500), ...many(14)], 12);
    expect(result).toHaveLength(14);
    expect(result.at(-1)?.kind).toBe('unrecorded_article');
    expect(result.at(-2)?.kind).toBe('other');
  });
});

describe('overview-teaser.service / getTeaserFunnel', () => {
  itCH('by=game counts each step in distinct sessions', async () => {
    const funnel = await overviewTeaserService.getTeaserFunnel({
      ...RANGE,
      filters: [],
      by: 'game',
    });

    expect(funnel.rows).toEqual([
      expect.objectContaining({
        kind: 'named',
        key: 'circuit',
        viewed: 4,
        started: 2,
        solved: 1,
        tapped: 2,
        reached: 1,
      }),
    ]);
    expect(funnel.total.hub_sessions).toBe(2);
  });

  itCH('by=article credits the hub per article and pins the unrecorded row last', async () => {
    const funnel = await overviewTeaserService.getTeaserFunnel({
      ...RANGE,
      filters: [],
      by: 'article',
    });
    const byKey = (key: string) =>
      funnel.rows.find((r) => r.kind === 'named' && r.key === key);

    expect(byKey('/a')?.reached).toBe(1);
    expect(byKey('/b')?.reached).toBe(0);
    expect(funnel.rows.at(-1)).toMatchObject({
      kind: 'unrecorded_article',
      viewed: 1,
    });
  });

  itCH('keeps reached under a path filter: the hub CTE ignores page filters', async () => {
    const funnel = await overviewTeaserService.getTeaserFunnel({
      ...RANGE,
      filters: [
        { name: 'path', operator: 'is', value: ['/a'] } as IChartEventFilter,
      ],
      by: 'game',
    });
    expect(funnel.rows[0]?.reached).toBe(1);
  });
});

describe('overview-teaser.service / getTeaserFunnel by=article', () => {
  const byArticle = () =>
    overviewTeaserService.getTeaserFunnel({
      ...RANGE,
      projectId: CUTOVER_PROJECT,
      filters: [],
      by: 'article',
    });

  itCH('counts each session in one article, so rows sum to the total', async () => {
    const funnel = await byArticle();
    const steps = ['viewed', 'started', 'solved', 'tapped', 'reached'] as const;
    for (const step of steps) {
      const rowSum = funnel.rows.reduce((n, r) => n + r[step], 0);
      expect(rowSum, step).toBe(funnel.total[step]);
    }
    expect(funnel.total).toMatchObject({ viewed: 6, started: 3, reached: 1 });
  });

  itCH('credits a session to its first article', async () => {
    const funnel = await byArticle();
    const byKey = (key: string) =>
      funnel.rows.find((r) => r.kind === 'named' && r.key === key);
    expect(byKey('/x')).toMatchObject({
      viewed: 2,
      started: 2,
      solved: 1,
      tapped: 1,
      reached: 1,
      play_rate: 100,
    });
    expect(byKey('/y')).toMatchObject({ viewed: 1, started: 0 });
  });

  itCH('puts sessions from before the cutover in Article not recorded, and names it', async () => {
    const funnel = await byArticle();
    expect(funnel.rows.at(-1)).toMatchObject({
      kind: 'unrecorded_article',
      viewed: 3,
      started: 1,
    });
    expect(funnel.article_cutover).toEqual(new Date('2026-07-01T11:00:00.000Z'));
  });
});

describe('NOT_TEASER_PLAY in full-game aggregates', () => {
  itCH('Games leaves Teaser starts and solves out', async () => {
    const { rows } = await overviewGamesService.getGameBreakdown({
      ...RANGE,
      filters: [],
    });
    expect(rows.find((r) => r.game === 'circuit')).toMatchObject({
      opens: 5,
      completes: 3,
    });
  });

  itCH('Level completion leaves Teaser plays out', async () => {
    const { metrics } = await overviewService.getEventMetrics({
      ...RANGE,
      filters: [],
      interval: 'day',
    });
    expect(metrics.level_completion).toBe(60);
  });
});

describe('overview-teaser.service / firstTeaserAt', () => {
  itCH('is the first teaser_viewed for a project that sent one', async () => {
    expect(await overviewTeaserService.firstTeaserAt(PROJECT)).toEqual(
      new Date('2026-07-01T12:00:00.000Z'),
    );
  });

  itCH('is null for a project that never did', async () => {
    expect(await overviewTeaserService.firstTeaserAt(EMPTY_PROJECT)).toBeNull();
  });
});
