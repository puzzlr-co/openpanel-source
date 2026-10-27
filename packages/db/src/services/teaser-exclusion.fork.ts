/**
 * Keeps Teaser-only sessions out of the board's session cards (fork-only).
 *
 * A session is Teaser-only when it has a Teaser event (a play, or the Teaser's
 * own screen_view) and no full-game evidence. Code-migration 24 keeps that per
 * (project, hour, session) in `session_flags`, fed by a materialized view on
 * `events`; the rule itself lives in that view, as last changed by 25.
 *
 * Queries keep the complement ("kept set"): every session in the window that
 * is not Teaser-only. On business-insider that is ~17K ids against ~1.16M
 * Teaser-only ones per 30 days, so the IN set stays small. Known gap: a large
 * tenant with a small Teaser share would get a large kept set.
 *
 * Rows before the project's first Teaser are kept by `created_at`, so history
 * from before `session_flags` existed needs no backfill. Sessionless events
 * (`session_id = ''`, server-sent) are never in the flags table and are kept.
 */
import { cacheable } from '@openpanel/redis';
import sqlstring from 'sqlstring';
import { ch, TABLE_NAMES } from '../clickhouse/client';
import { clix } from '../clickhouse/query-builder';

export const SESSION_FLAGS_TABLE = 'session_flags';

// A project starts sending teaser_viewed only when a host embeds the Teaser, so
// a stale "no Teaser" keeps Teaser-only sessions on the board for at most this
// long.
const FIRST_TEASER_TTL_SECONDS = 60 * 10;

// The window's bounds are wall-clock in the project's timezone; widest UTC
// offset is +14h. Only used to skip the predicate, never for correctness.
const MAX_TIMEZONE_OFFSET_MS = 14 * 60 * 60 * 1000;

/** Null when the project never sent a Teaser view. */
export type TeaserGuard = { firstTeaserAt: Date } | null;

async function fetchFirstTeaserAt(
  projectId: string,
): Promise<{ firstTeaserAt: string | null }> {
  const seen = await clix(ch)
    .select<{ name: string }>(['name'])
    .from(TABLE_NAMES.event_names_mv)
    .where('project_id', '=', projectId)
    .where('name', '=', 'teaser_viewed')
    .limit(1)
    .execute();
  if (seen.length === 0) {
    return { firstTeaserAt: null };
  }
  const [row] = await clix(ch)
    .select<{ first: string }>(["toString(min(created_at), 'UTC') AS first"])
    .from(TABLE_NAMES.events)
    .where('project_id', '=', projectId)
    .where('name', '=', 'teaser_viewed')
    .execute();
  return { firstTeaserAt: row?.first ?? null };
}

// Wrapped in an object: `cacheable` does not cache null.
const firstTeaserAtCached = cacheable(
  fetchFirstTeaserAt,
  FIRST_TEASER_TTL_SECONDS,
);

export async function getTeaserGuard(projectId: string): Promise<TeaserGuard> {
  const { firstTeaserAt } = await firstTeaserAtCached(projectId);
  return firstTeaserAt
    ? { firstTeaserAt: new Date(`${firstTeaserAt.replace(' ', 'T')}Z`) }
    : null;
}

type ExclusionScope = {
  projectId: string;
  startDate: string;
  endDate: string;
  /** `id` on `sessions`, `session_id` on `events`. */
  column: 'id' | 'session_id';
};

/**
 * WHERE fragment that drops Teaser-only sessions, or '' when the project has
 * no Teaser or the window ends before its first one (so the SQL is unchanged).
 */
export function teaserOnlyExclusion(
  guard: TeaserGuard,
  { projectId, startDate, endDate, column }: ExclusionScope,
): string {
  if (
    !guard ||
    new Date(endDate).getTime() + MAX_TIMEZONE_OFFSET_MS <
      guard.firstTeaserAt.getTime()
  ) {
    return '';
  }
  const firstTeaserAt = `toDateTime64(${sqlstring.escape(
    guard.firstTeaserAt.toISOString().slice(0, 23).replace('T', ' '),
  )}, 3, 'UTC')`;
  const kept = `SELECT session_id FROM ${SESSION_FLAGS_TABLE}
    WHERE project_id = ${sqlstring.escape(projectId)}
      AND hour BETWEEN toStartOfHour(${toDateTime(startDate)}, 'UTC') AND ${toDateTime(endDate)}
    GROUP BY session_id
    HAVING NOT max(teaser) OR max(game)`;
  return `(created_at < ${firstTeaserAt} OR ${column} = '' OR ${column} IN (${kept}))`;
}

// Same instant as the outer query's `created_at BETWEEN` bound.
function toDateTime(date: string): string {
  return `toDateTime(${sqlstring.escape(clix.datetime(date))})`;
}

/** `teaserOnlyExclusion` for the project's cached guard. */
export async function excludeTeaserOnly(scope: ExclusionScope): Promise<string> {
  return teaserOnlyExclusion(await getTeaserGuard(scope.projectId), scope);
}

/**
 * For live cards (last few minutes): a session is judged on its last day of
 * flags, so a reader who reached the hub earlier still counts. The bounds are
 * UTC instants, but callers may run in the project's session timezone, which
 * reads them as wall-clock; padding by the widest offset keeps `now` inside.
 */
export function excludeTeaserOnlyLive(projectId: string): Promise<string> {
  const now = Date.now();
  return excludeTeaserOnly({
    projectId,
    startDate: new Date(now - 24 * 60 * 60 * 1000 - MAX_TIMEZONE_OFFSET_MS).toISOString(),
    endDate: new Date(now + MAX_TIMEZONE_OFFSET_MS).toISOString(),
    column: 'session_id',
  });
}

/** getTopGeneric columns whose cards describe players: Devices and Geo. */
export const PLAYER_ONLY_COLUMNS: readonly string[] = [
  'device',
  'browser',
  'browser_version',
  'os',
  'os_version',
  'brand',
  'model',
  'country',
  'region',
  'city',
];
