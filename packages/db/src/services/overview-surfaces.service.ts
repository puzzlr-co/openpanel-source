/**
 * fork-only: the surface option list — the distinct `embed_surface` values one
 * project emits.
 *
 * The logged-in dashboard reads this through the generic `chart.values`
 * endpoint, a protectedProcedure that answers nothing on a public share link.
 * This is the share-safe half of the same lookup: same table, same ordering,
 * same raw values, callable from a request with no session, so a share URL
 * shows the option list the project's own members see. Its own file, so
 * upstream's share router gains only an import plus one guarded expression.
 *
 * Values pass through raw and unbucketed — see SURFACE_FILTER in
 * overview.service.ts for why.
 */
import { cacheable } from '@openpanel/redis';
import { ch, TABLE_NAMES } from '../clickhouse/client';
import { clix } from '../clickhouse/query-builder';

/** The event property behind the surface picker (puzzlr ADR-0008). */
export const SURFACE_PROPERTY_KEY = 'embed_surface';

// A new surface appears only when a tenant deploys one, so a long TTL is safe —
// and it matters, because the shared overview resolves this inside its blocking
// loader query.
const SURFACE_VALUES_TTL_SECONDS = 60 * 10;

/**
 * The uncached read. Exported so tests can assert what the query actually
 * answers with; routers should call `getSurfaceValues` below.
 */
export async function fetchSurfaceValues(projectId: string): Promise<string[]> {
  // `event_property_values_mv` already indexes distinct property values per
  // project — no new materialization, and it is the table `chart.values` reads.
  const rows = await clix(ch)
    .select<{ property_value: string; created_at: string }>([
      'distinct property_value',
      'max(created_at) as created_at',
    ])
    .from(TABLE_NAMES.event_property_values_mv)
    .where('project_id', '=', projectId)
    .where('property_key', '=', SURFACE_PROPERTY_KEY)
    .groupBy(['property_value'])
    .orderBy('created_at', 'DESC')
    .execute();

  // '' is the pre-ADR-0008 "not set" state, never a selectable surface.
  // `event_property_values_mv` has carried `WHERE property_value != ''` since
  // 3-init-ch.sql, so this is defence-in-depth against an upstream change to
  // that predicate or an out-of-band write: '' in the picker reads as a real
  // surface and selects every un-instrumented session.
  return rows.map((row) => row.property_value).filter((value) => value !== '');
}

/**
 * Distinct surfaces for one project, newest-seen first.
 *
 * projectId is the only input, and the property key is pinned here rather than
 * taken from input — so callers on the share path must pass the project
 * resolved from the share row, never a client-sent one.
 */
export const getSurfaceValues = cacheable(
  fetchSurfaceValues,
  SURFACE_VALUES_TTL_SECONDS,
  // A project with no surfaces is exactly the case that must not re-scan per
  // viewer, so cache the empty answer too.
  { cacheEmptyArray: true },
);

/**
 * Whether a share response may carry the surface list. Stricter than "the share
 * row exists": a non-public share has nothing to show, and a password-protected
 * one must not answer until the password has been entered (the same
 * `shared-overview-<id>` cookie every other share-gated read checks).
 */
export function canExposeShareSurfaces(
  share: { public: boolean; password: string | null } | null,
  hasAccess: boolean,
): boolean {
  if (!share?.public) {
    return false;
  }

  return share.password ? hasAccess : true;
}
