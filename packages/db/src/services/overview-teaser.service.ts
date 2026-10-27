/**
 * Teaser funnel for the overview "Teaser" widget (fork-only).
 *
 * Is the in-article Teaser worth its slot? Five steps, each distinct sessions:
 *
 *   viewed   teaser_viewed                 (IAB viewable impression)
 *   started  level_started         Teaser  (first move)
 *   solved   level_completed       Teaser  (live solve only)
 *   tapped   completion_cta_tapped Teaser
 *   reached  the same session has a hub game_viewed|level_started with
 *            ref='teaser' for the same game key
 *
 * `reached` is a property of a Teaser session, joined like Games' game_viewers:
 * filters pick the Teaser rows, the hub CTE is scoped by project and range
 * only. That keeps it attributable per article and under a path or surface
 * filter (the hub has its own path and maybe its own surface). Measured
 * 2026-10-13..20 on business-insider: 73 of 74 ref='teaser' sessions share the
 * session with the Teaser event. Arrivals that land in a new session are not
 * credited to any row; `total.hub_sessions` reports them all.
 *
 * by 'game' groups events by GAME_KEY_EXPR, so a session that met two games
 * counts in both rows; the rollup row is the exact distinct total.
 *
 * by 'article' gives each session one article, so rows sum to the total: the
 * path of its first Teaser event that has one. A session whose first Teaser
 * event came before the project's article cutover (the first hour most
 * teaser_viewed carry a path, puzzlr #839) gets '' instead: its views carried no path while its
 * plays did, so per-article rates would mix periods. '' stays its own row,
 * pinned last and never folded, so the size of the gap is visible.
 *
 * One scan of events either way. Materialized columns only (level_id,
 * game_tag, game_id, ref, path).
 */
import { cacheable } from '@openpanel/redis';
import type { IChartEventFilter } from '@openpanel/validation';
import sqlstring from 'sqlstring';
import { ch, TABLE_NAMES } from '../clickhouse/client';
import { clix, type Query } from '../clickhouse/query-builder';
import { GAME_KEY_EXPR, overviewService } from './overview.service';
import { getTeaserGuard } from './teaser-exclusion.fork';
import {
  FROM_TEASER,
  HUB_ARRIVAL_EVENTS,
  TEASER_EVENTS,
  TEASER_PLAY,
} from './teaser-predicates.fork';

const MAX_NAMED_ROWS = 12;

// Null until the project's first teaser_viewed with a path, then fixed; a stale
// null keeps every session in "Article not recorded" for at most this long.
const ARTICLE_CUTOVER_TTL_SECONDS = 60 * 10;

export type TeaserBreakdown = 'game' | 'article';

export type ITeaserFunnelCounts = {
  viewed: number;
  started: number;
  solved: number;
  tapped: number;
  reached: number;
};

export type ITeaserFunnelRates = {
  /** started / viewed, %. Uncapped: viewed undercounts without IntersectionObserver. */
  play_rate: number | null;
  /** solved / started, %. */
  solve_rate: number | null;
  /** tapped / viewed, %: a remembered solve shows the button with no new solve. */
  tap_rate: number | null;
  /** reached / tapped, %. */
  arrival_rate: number | null;
};

export type ITeaserFunnelRow = ITeaserFunnelCounts &
  ITeaserFunnelRates &
  (
    | { kind: 'named'; key: string; games?: string[] }
    | { kind: 'unrecorded_article' }
    | { kind: 'other'; other_count: number }
  );

export type ITeaserFunnel = {
  by: TeaserBreakdown;
  total: ITeaserFunnelCounts &
    ITeaserFunnelRates & {
      /** All hub sessions with ref='teaser' in range, joined to a Teaser or not. */
      hub_sessions: number;
    };
  rows: ITeaserFunnelRow[];
  /**
   * First teaser_viewed with an article path; sessions whose first Teaser event
   * is earlier are `unrecorded_article`. Null when no view has a path yet.
   */
  article_cutover: Date | null;
  /** Project timezone, to show `article_cutover` in. */
  timezone: string;
};

type TeaserFunnelInput = {
  projectId: string;
  filters: IChartEventFilter[];
  startDate: string;
  endDate: string;
  timezone: string;
  by: TeaserBreakdown;
};

/**
 * The first hour in which most teaser_viewed carry a path. Not the first view
 * with a path: before #839 about 1% of views had one, mostly from readers who
 * went on to play (business-insider 10-20 17:00 UTC vs the 10-21 15:00 deploy).
 */
async function fetchArticleCutover(
  projectId: string,
): Promise<{ cutover: string | null }> {
  const hours = clix(ch)
    .select(["toStartOfHour(created_at, 'UTC') AS hour"])
    .from(TABLE_NAMES.events)
    .where('project_id', '=', projectId)
    .where('name', '=', 'teaser_viewed')
    .groupBy(['hour'])
    .rawHaving("countIf(path != '') > count() / 2");
  const [row] = await clix(ch)
    .with('hours', hours)
    .select<{ n: number; first: string }>([
      'count() AS n',
      "toString(min(hour), 'UTC') AS first",
    ])
    .from('hours')
    .execute();
  return { cutover: row && Number(row.n) > 0 ? row.first : null };
}

// Wrapped in an object: `cacheable` does not cache null.
export const articleCutoverCached = cacheable(
  fetchArticleCutover,
  ARTICLE_CUTOVER_TTL_SECONDS,
);

async function getArticleCutover(projectId: string): Promise<Date | null> {
  const { cutover } = await articleCutoverCached(projectId);
  return cutover ? new Date(`${cutover.replace(' ', 'T')}Z`) : null;
}

type RawTeaserRow = ITeaserFunnelCounts & {
  key: string;
  games?: string[];
  is_total: number;
};

const ZERO_COUNTS: ITeaserFunnelCounts = {
  viewed: 0,
  started: 0,
  solved: 0,
  tapped: 0,
  reached: 0,
};

class OverviewTeaserService {
  constructor(private readonly client: typeof ch) {}

  /**
   * When the project first sent teaser_viewed; null if it never did. The widget
   * renders nothing on null, and an empty range on a Teaser project still shows
   * the card with zeros.
   */
  async firstTeaserAt(projectId: string): Promise<Date | null> {
    return (await getTeaserGuard(projectId))?.firstTeaserAt ?? null;
  }

  async getTeaserFunnel(input: TeaserFunnelInput): Promise<ITeaserFunnel> {
    const articleCutover = await getArticleCutover(input.projectId);
    const [raw, hubSessions] = await Promise.all([
      (input.by === 'game'
        ? this.byGameQuery(input)
        : this.byArticleQuery(input, articleCutover)
      ).execute(),
      this.hubSessions(input),
    ]);

    const rollup = raw.find((r) => r.is_total === 1);
    const groups = raw.filter((r) => r.is_total !== 1);
    const totalCounts = rollup ? pickCounts(rollup) : ZERO_COUNTS;

    return {
      by: input.by,
      total: {
        ...totalCounts,
        ...teaserRates(totalCounts),
        hub_sessions: hubSessions,
      },
      rows: foldTeaserTail(
        groups.map((r) => toRow(r, input.by)),
        MAX_NAMED_ROWS,
      ),
      article_cutover: articleCutover,
      timezone: input.timezone,
    };
  }

  private byGameQuery(input: TeaserFunnelInput): Query<RawTeaserRow> {
    return this.teaserEvents(input)
      .select<RawTeaserRow>([
        `${GAME_KEY_EXPR} AS key`,
        `uniqExactIf(session_id, name = 'teaser_viewed') AS viewed`,
        `uniqExactIf(session_id, name = 'level_started') AS started`,
        `uniqExactIf(session_id, name = 'level_completed') AS solved`,
        `uniqExactIf(session_id, name = 'completion_cta_tapped') AS tapped`,
        `uniqExactIf(session_id, (${GAME_KEY_EXPR}, session_id) IN hub) AS reached`,
        'grouping(key) AS is_total',
      ])
      .groupBy(['key'])
      .rollup()
      .orderBy('viewed', 'DESC');
  }

  /** One row per session with its article and a 0/1 per step, then summed. */
  private byArticleQuery(
    input: TeaserFunnelInput,
    articleCutover: Date | null,
  ): Query<RawTeaserRow> {
    const article = articleCutover
      ? `if(min(created_at) < toDateTime64(${sqlstring.escape(
          articleCutover.toISOString().slice(0, 23).replace('T', ' '),
        )}, 3, 'UTC'), '', argMinIf(path, created_at, path != ''))`
      : "''";

    const perSession = this.teaserEvents(input)
      .select([
        // An Expression: select() would re-quote the cutover's date string.
        clix.exp(`${article} AS article`),
        "max(name = 'teaser_viewed') AS has_viewed",
        "max(name = 'level_started') AS has_started",
        "max(name = 'level_completed') AS has_solved",
        "max(name = 'completion_cta_tapped') AS has_tapped",
        `max((${GAME_KEY_EXPR}, session_id) IN hub) AS has_reached`,
        `groupUniqArray(${GAME_KEY_EXPR}) AS session_games`,
      ])
      .groupBy(['session_id']);

    return clix(this.client, input.timezone)
      .with('per_session', perSession)
      .select<RawTeaserRow>([
        'article AS key',
        'sum(has_viewed) AS viewed',
        'sum(has_started) AS started',
        'sum(has_solved) AS solved',
        'sum(has_tapped) AS tapped',
        'sum(has_reached) AS reached',
        'groupUniqArrayArray(session_games) AS games',
        'grouping(key) AS is_total',
      ])
      .from('per_session')
      .groupBy(['key'])
      .rollup()
      .orderBy('viewed', 'DESC');
  }

  /** The Teaser's own events in range under the board's filters, with `hub`. */
  private teaserEvents(input: TeaserFunnelInput): Query {
    const { projectId, filters, startDate, endDate, timezone } = input;
    return this.inRange(clix(this.client, timezone), projectId, startDate, endDate)
      .with('hub', this.hubArrivals(input))
      .where('name', 'IN', [...TEASER_EVENTS])
      .rawWhere(TEASER_PLAY)
      .rawWhere(
        overviewService.getRawWhereClause('events', filters, {
          projectId,
          startDate,
          endDate,
        }),
      );
  }

  private inRange(
    query: Query,
    projectId: string,
    startDate: string,
    endDate: string,
  ) {
    return query
      .from(TABLE_NAMES.events, false)
      .where('project_id', '=', projectId)
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ]);
  }

  private hubArrivals({
    projectId,
    startDate,
    endDate,
    timezone,
  }: TeaserFunnelInput) {
    return this.inRange(
      clix(this.client, timezone).select([
        `DISTINCT ${GAME_KEY_EXPR} AS game`,
        'session_id',
      ]),
      projectId,
      startDate,
      endDate,
    )
      .where('name', 'IN', [...HUB_ARRIVAL_EVENTS])
      .rawWhere(FROM_TEASER);
  }

  private async hubSessions(input: TeaserFunnelInput): Promise<number> {
    const [row] = await clix(this.client, input.timezone)
      .with('hub', this.hubArrivals(input))
      .select<{ hub_sessions: number }>(['uniqExact(session_id) AS hub_sessions'])
      .from('hub')
      .execute();
    return row?.hub_sessions ?? 0;
  }
}

function pickCounts(r: ITeaserFunnelCounts): ITeaserFunnelCounts {
  return {
    viewed: r.viewed,
    started: r.started,
    solved: r.solved,
    tapped: r.tapped,
    reached: r.reached,
  };
}

function toRow(r: RawTeaserRow, by: TeaserBreakdown): ITeaserFunnelRow {
  const counts = pickCounts(r);
  const rates = teaserRates(counts);
  if (by === 'article' && r.key === '') {
    return { ...counts, ...rates, kind: 'unrecorded_article' };
  }
  return {
    ...counts,
    ...rates,
    kind: 'named',
    key: r.key,
    ...(by === 'article' ? { games: r.games ?? [] } : {}),
  };
}

function percent(numerator: number, denominator: number): number | null {
  return denominator > 0 ? (numerator * 100) / denominator : null;
}

/** Null when the denominator is 0; never clamped. */
export function teaserRates(c: ITeaserFunnelCounts): ITeaserFunnelRates {
  return {
    play_rate: percent(c.started, c.viewed),
    solve_rate: percent(c.solved, c.started),
    tap_rate: percent(c.tapped, c.viewed),
    arrival_rate: percent(c.reached, c.tapped),
  };
}

/**
 * Named rows past `max` (+1 overshoot, as Games) fold into one `other` row,
 * counts summed, rates recomputed. `unrecorded_article` is never folded and
 * always last.
 */
export function foldTeaserTail(
  ranked: ITeaserFunnelRow[],
  max: number,
): ITeaserFunnelRow[] {
  const named = ranked.filter((r) => r.kind !== 'unrecorded_article');
  const unrecorded = ranked.filter((r) => r.kind === 'unrecorded_article');

  if (named.length <= max + 1) {
    return [...named, ...unrecorded];
  }

  const rest = named.slice(max);
  const counts = { ...ZERO_COUNTS };
  for (const r of rest) {
    counts.viewed += r.viewed;
    counts.started += r.started;
    counts.solved += r.solved;
    counts.tapped += r.tapped;
    counts.reached += r.reached;
  }

  return [
    ...named.slice(0, max),
    { ...counts, ...teaserRates(counts), kind: 'other', other_count: rest.length },
    ...unrecorded,
  ];
}

export const overviewTeaserService = new OverviewTeaserService(ch);
