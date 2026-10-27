import { useTRPC } from '@/integrations/trpc/react';
import { useQuery } from '@tanstack/react-query';

/**
 * The surfaces this project actually emits, newest-seen first — read per
 * project, never hardcoded or bucketed (see SURFACE_FILTER in
 * overview.service.ts).
 *
 * Two sources, one list. Logged in it comes from `chart.values`, a
 * protectedProcedure that answers nothing without a session; on a share link it
 * rides along on `share.overview`, which the shared route's loader already
 * awaits, so the shared page gains the control without a round-trip. Both read
 * the same table with the same ordering, so the lists cannot drift.
 */
export function useSurfaceValues(projectId: string, shareId?: string) {
  const trpc = useTRPC();
  const isShared = !!shareId;

  const { data: chartValues } = useQuery(
    trpc.chart.values.queryOptions(
      { projectId, event: '*', property: 'properties.embed_surface' },
      { staleTime: 1000 * 60 * 60, enabled: !isShared && !!projectId },
    ),
  );

  // Same input as the route loader's `share.overview` call, so this hits the
  // same query-cache entry rather than fetching.
  const { data: share } = useQuery(
    trpc.share.overview.queryOptions(
      { shareId: shareId ?? '' },
      { enabled: isShared },
    ),
  );

  const values = isShared ? (share?.surfaces ?? []) : (chartValues?.values ?? []);
  // '' is the pre-ADR-0008 "not set" state, never a selectable surface. The
  // shared branch is filtered server-side already; the logged-in branch is not
  // — `chart.values` is upstream's generic endpoint and returns whatever the
  // table holds.
  return values.filter(Boolean);
}
