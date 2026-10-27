import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useOverviewOptions } from '@/components/overview/useOverviewOptions';
import { useEventQueryFilters } from '@/hooks/use-event-query-filters';
import { useTRPC } from '@/integrations/trpc/react';

export const TEASER_ONLY_READERS_NOTE =
  'Readers who only saw a Teaser are counted in the Teaser section.';

/**
 * overview.teaserFunnel for the board's current range and filters. Every caller
 * shares one cache entry per `by`, so the metric cards reading `hasTeaser` ride
 * on the Games widget's request. Null for a project without a Teaser, which the
 * server answers from a cached flag.
 */
export function useTeaserFunnel({
  projectId,
  shareId,
  by,
  enabled = true,
}: {
  projectId: string;
  shareId?: string;
  by: 'game' | 'article';
  enabled?: boolean;
}) {
  const { range, startDate, endDate } = useOverviewOptions();
  const [filters] = useEventQueryFilters();
  const trpc = useTRPC();
  return useQuery(
    trpc.overview.teaserFunnel.queryOptions(
      { projectId, shareId, range, startDate, endDate, filters, by },
      // A range or filter change must not drop the Teaser tab while it reloads.
      { enabled, placeholderData: keepPreviousData },
    ),
  );
}

export function useHasTeaser(projectId: string, shareId?: string): boolean {
  return useTeaserFunnel({ projectId, shareId, by: 'game' }).data != null;
}
