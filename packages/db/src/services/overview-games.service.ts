/**
 * Per-game breakdown for the overview "Games" widget (fork-only).
 *
 * One row per resolved game key, with the metrics stakeholders compare games on
 * — reach (sessions that viewed it), pull (play rate), volume (puzzles
 * started), quality (completion rate), loyalty (returning rate) and effort
 * (median time to solve) — plus a daily series per row for the sparkline.
 *
 * Fork-safe: its own file, appended endpoint. Upstream's overview.service.ts is
 * untouched apart from the constants it already owns (see below).
 *
 * Two queries rather than one, deliberately. PostHog folds a breakdown's
 * per-row series into the aggregate query with a CTE chain, which works because
 * its row totals are sums of the daily values. Ours are not: `players` and
 * `sessions` are distinct counts over the whole range, and summing per-day
 * uniques would count a player who returned on five days five times. The two
 * grains therefore need two aggregations; they run in parallel and are cached
 * by the router.
 *
 * Both run on the overview's cold load, where cost scales with the largest
 * project rather than the median one — read materialized columns here, never
 * `properties`.
 */
import type { IChartEventFilter } from '@openpanel/validation';
import { ch, TABLE_NAMES } from '../clickhouse/client';
import { clix, type Query } from '../clickhouse/query-builder';
// getRawWhereClause: the widget must honour the same dashboard filters as every
// other overview query, and a second filter whitelist here would drift.
import {
  GAME_KEY_EXPR,
  overviewService,
  PUZZLE_OPEN_KEY,
} from './overview.service';
import { NOT_TEASER_PLAY } from './teaser-predicates.fork';

// `!= 0` is not the old `!= ''`: the materialized column (code-migration 21)
// cannot tell a missing property from a literal '0', so zero-second solves are
// excluded rather than counted as 0.0.
const SOLVE_SECONDS = 'time_seconds';
const HAS_SOLVE_SECONDS = `name = 'level_completed' AND ${SOLVE_SECONDS} != 0`;

// Events that carry a game identity on ~100% of rows. Puzzlr's `session_started`
// is NOT the built-in `session_start`, which carries one on only ~two thirds and
// would silently undercount every per-game figure. Used by getTotals only; the
// daily series reads level_started alone.
const GAME_BEARING_EVENTS = [
  'level_started',
  'level_completed',
  'session_started',
  'game_viewed',
];

/**
 * Games shown by name before the remainder is folded into a single "Other" row.
 * Real projects range from 6 to 33 distinct game keys, so the cap is
 * load-bearing — but the remainder is always surfaced rather than dropped.
 */
const MAX_NAMED_GAME_ROWS = 12;

/** One row of overshoot: folding a lone game costs it everything and saves nothing. */
const MAX_GAME_ROWS_BEFORE_FOLD = MAX_NAMED_GAME_ROWS + 1;

export type IGameBreakdownRow = {
  game: string;
  /** Sessions that had the game on screen: game_viewed, half of it for a second. */
  viewed: number;
  /** Of `viewed`, the sessions that went on to start a puzzle. */
  played: number;
  /**
   * played / viewed. Null with no views: game_viewed only exists from puzzlr's
   * engaged-starts release (2026-10-02), so earlier ranges have no rate.
   */
  play_rate: number | null;
  opens: number;
  completes: number;
  completion_rate: number;
  returning_rate: number;
  median_solve_s: number;
  /** Daily puzzles started, one entry per day in range, gap-filled. */
  series: number[];
  /**
   * True for the synthetic "Other" row. Its returning rate and median are not
   * derivable by summing per-game rows, so the UI must render them as
   * unavailable rather than as zero.
   */
  is_other?: boolean;
  /** Number of games folded into this row. Only set when is_other. */
  other_count?: number;
};

export type IGameBreakdown = {
  rows: IGameBreakdownRow[];
};

type GameBreakdownInput = {
  projectId: string;
  filters: IChartEventFilter[];
  startDate: string;
  endDate: string;
  timezone: string;
};

class OverviewGamesService {
  constructor(private client: typeof ch) {}

  async getGameBreakdown({
    projectId,
    filters,
    startDate,
    endDate,
    timezone,
  }: GameBreakdownInput): Promise<IGameBreakdown> {
    const [totals, series] = await Promise.all([
      this.getTotals({ projectId, filters, startDate, endDate, timezone }),
      this.getDailySeries({ projectId, filters, startDate, endDate, timezone }),
    ]);

    const seriesByGame = new Map(series.map((s) => [s.game, s.series]));

    // A game seen but never started is kept: that is the play rate's whole point.
    const shown = totals.filter((t) => t.opens > 0 || t.viewed > 0);

    const ranked = shown.map((t) => ({
      game: t.game,
      viewed: t.viewed,
      played: t.played,
      play_rate: playRate(t.played, t.viewed),
      opens: t.opens,
      completes: t.completes,
      // Uncapped on purpose: a rate above 100% would mean the dedup key is
      // broken, and clamping would hide that behind a flattering number.
      completion_rate: t.opens > 0 ? (t.completes * 100) / t.opens : 0,
      returning_rate:
        t.game_starts > 0 ? (t.returning_starts * 100) / t.game_starts : 0,
      // quantileIf returns null when a game has no timed completions at all
      // (measured: pinpoint emits level_completed without time_seconds). 0 is
      // the "unknown" sentinel the UI renders as an em dash, never as "0s".
      median_solve_s: t.median_solve_s ?? 0,
      series: seriesByGame.get(t.game) ?? [],
    }));

    return { rows: foldTail(ranked) };
  }

  /**
   * Range-level aggregates. Distinct counts here cannot come from daily rows.
   *
   * `played` counts only starts in sessions that also viewed the game. That keeps
   * the play rate honest over ranges that predate game_viewed. Teaser plays are
   * excluded everywhere here by NOT_TEASER_PLAY (teaser-predicates.fork.ts).
   */
  private getTotals({
    projectId,
    filters,
    startDate,
    endDate,
    timezone,
  }: GameBreakdownInput) {
    // The viewer subquery takes the same slice, so `played` can never exceed `viewed`.
    const scoped = (query: Query) =>
      query
        .from(TABLE_NAMES.events, false)
        .where('project_id', '=', projectId)
        .where('created_at', 'BETWEEN', [
          clix.datetime(startDate, 'toDateTime'),
          clix.datetime(endDate, 'toDateTime'),
        ])
        .rawWhere(overviewService.getRawWhereClause('events', filters, { projectId, startDate, endDate }))
        .rawWhere(`${GAME_KEY_EXPR} != ''`)
        .rawWhere(NOT_TEASER_PLAY);

    const viewers = scoped(
      clix(this.client, timezone).select([GAME_KEY_EXPR, 'session_id']),
    ).where('name', '=', 'game_viewed');

    return scoped(
      clix(this.client, timezone)
        .with('game_viewers', viewers)
        .select<{
          game: string;
          viewed: number;
          played: number;
          opens: number;
          completes: number;
          returning_starts: number;
          game_starts: number;
          median_solve_s: number;
        }>([
          `${GAME_KEY_EXPR} AS game`,
          `uniqExactIf(session_id, name = 'game_viewed') AS viewed`,
          `uniqExactIf(session_id, name = 'level_started' AND (${GAME_KEY_EXPR}, session_id) IN game_viewers) AS played`,
          `uniqExactIf((${PUZZLE_OPEN_KEY}), name = 'level_started') AS opens`,
          `uniqExactIf((${PUZZLE_OPEN_KEY}), name = 'level_completed') AS completes`,
          `countIf(name = 'session_started' AND days_since_first_visit > 0) AS returning_starts`,
          `countIf(name = 'session_started') AS game_starts`,
          `round(quantileIf(0.5)(${SOLVE_SECONDS}, ${HAS_SOLVE_SECONDS})) AS median_solve_s`,
        ]),
    )
      .where('name', 'IN', GAME_BEARING_EVENTS)
      .groupBy(['game'])
      .orderBy('opens', 'DESC')
      .execute();
  }

  /**
   * Daily puzzles started per game, aligned so every row's array has the same
   * length and the same day at the same index.
   *
   * Alignment is the whole point. Without it a game that launched mid-range
   * returns fewer points than its peers, and the sparkline stretches that short
   * series across the full width — so a game live for 17 of 30 days reads as if
   * it ran all month (measured: wordbetween 17/30, bimaru 19/30 on a July
   * window). Leading zeros show the launch honestly.
   *
   * The densification happens in TypeScript rather than via ClickHouse's
   * `WITH FILL`. Both give the same guarantee, but the SQL route has to survive
   * three interacting date semantics — clix.datetime() round-trips a naive local
   * string through Date/ISO, execute() then reinterprets it under
   * session_timezone, and WITH FILL's TO bound is exclusive — which together
   * produced partial stub buckets at BOTH ends (measured: 32 buckets for a
   * 31-day window, first bucket 109 opens against a ~1150 daily norm). Building
   * the expected day list here is a few lines, is exact, and is testable without
   * a database.
   */
  private async getDailySeries({
    projectId,
    filters,
    startDate,
    endDate,
    timezone,
  }: GameBreakdownInput) {
    const days = expectedDays(startDate, endDate);
    const dayIndex = new Map(days.map((d, i) => [d, i]));

    const rows = await clix(this.client, timezone)
      .select<{ game: string; date: string; opens: number }>([
        `${GAME_KEY_EXPR} AS game`,
        `${clix.toStartOf('created_at', 'day', timezone)} AS date`,
        `uniqExact((${PUZZLE_OPEN_KEY})) AS opens`,
      ])
      .from(TABLE_NAMES.events, false)
      .where('project_id', '=', projectId)
      .where('name', '=', 'level_started')
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .rawWhere(overviewService.getRawWhereClause('events', filters, { projectId, startDate, endDate }))
      .rawWhere(`${GAME_KEY_EXPR} != ''`)
      .rawWhere(NOT_TEASER_PLAY)
      .groupBy(['game', 'date'])
      .execute();

    const byGame = new Map<string, number[]>();
    for (const row of rows) {
      // clix renders the day bucket as a datetime; the leading 10 chars are the
      // local calendar day, which is the key the expected list is built on.
      const key = String(row.date).slice(0, 10);
      const i = dayIndex.get(key);
      // Buckets outside the expected window are the timezone-shift artefacts
      // described above — a sliver of a day that is not really in range — so
      // they are dropped rather than drawn as a dip. Note this is NOT the same
      // as the final day being incomplete: when the range ends "today", that
      // last point is real data for a day still in progress and is kept, exactly
      // as the metric cards and their charts above it do.
      if (i === undefined) {
        continue;
      }
      let series = byGame.get(row.game);
      if (!series) {
        series = new Array(days.length).fill(0);
        byGame.set(row.game, series);
      }
      series[i] = row.opens ?? 0;
    }

    return [...byGame.entries()].map(([game, series]) => ({ game, series }));
  }
}

function playRate(played: number, viewed: number): number | null {
  return viewed > 0 ? (played * 100) / viewed : null;
}

/**
 * Folds the tail past the cap into one "Other" row. Input must already be ranked.
 * Only additive measures survive: distinct counts and a median cannot be summed
 * across games, so they are emitted as 0 — see IGameBreakdownRow.is_other.
 */
export function foldTail(ranked: IGameBreakdownRow[]): IGameBreakdownRow[] {
  if (ranked.length <= MAX_GAME_ROWS_BEFORE_FOLD) {
    return ranked;
  }

  const shown = ranked.slice(0, MAX_NAMED_GAME_ROWS);
  const rest = ranked.slice(MAX_NAMED_GAME_ROWS);

  const total = (key: 'viewed' | 'played' | 'opens' | 'completes') =>
    rest.reduce((sum, r) => sum + r[key], 0);
  const otherViewed = total('viewed');
  const otherPlayed = total('played');
  const otherOpens = total('opens');
  const otherCompletes = total('completes');
  // Index i is the same day in every row (see getDailySeries), so this sums days.
  const seriesLength = shown[0]?.series.length ?? 0;
  const otherSeries = Array.from({ length: seriesLength }, (_, i) =>
    rest.reduce((sum, r) => sum + (r.series[i] ?? 0), 0)
  );

  return [
    ...shown,
    {
      game: 'Other',
      viewed: otherViewed,
      played: otherPlayed,
      play_rate: playRate(otherPlayed, otherViewed),
      opens: otherOpens,
      completes: otherCompletes,
      completion_rate: otherOpens > 0 ? (otherCompletes * 100) / otherOpens : 0,
      returning_rate: 0,
      median_solve_s: 0,
      series: otherSeries,
      is_other: true,
      other_count: rest.length,
    },
  ];
}

/**
 * The local calendar days a range covers, as 'YYYY-MM-DD', inclusive of the
 * first and last day that actually has data.
 *
 * Bounds arrive as naive local datetime strings ('2026-07-01 00:00:00'), already
 * resolved for the project timezone by getChartStartEndDate. They are treated as
 * plain text here — parsing them into Date would reintroduce exactly the UTC
 * round-trip that produced the stub buckets.
 *
 * A range ending exactly at midnight is a half-open bound: '30d' resolves to
 * 2026-07-01 00:00:00 → 2026-08-01 00:00:00 and means 1–31 July, so the final
 * day is dropped. Any other end time means the last day is partially elapsed
 * (a live "today"), and it is kept.
 *
 * Exported for tests.
 */
export function expectedDays(startDate: string, endDate: string): string[] {
  const startDay = startDate.slice(0, 10);
  const endDay = endDate.slice(0, 10);
  const endIsMidnightBoundary = endDate.slice(11, 19) === '00:00:00';

  const days: string[] = [];
  // Step in UTC on date-only values: no timezone is involved, so DST cannot
  // shift or duplicate a day the way local-time arithmetic would.
  const cursor = new Date(`${startDay}T00:00:00Z`);
  const last = new Date(`${endDay}T00:00:00Z`);
  if (endIsMidnightBoundary) {
    last.setUTCDate(last.getUTCDate() - 1);
  }

  // Guard against an inverted or absurd range producing an unbounded loop.
  const MAX_DAYS = 400;
  while (cursor <= last && days.length < MAX_DAYS) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return days;
}

export const overviewGamesService = new OverviewGamesService(ch);
