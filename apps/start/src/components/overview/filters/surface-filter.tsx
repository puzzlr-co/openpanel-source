import { ComboboxAdvanced } from '@/components/ui/combobox-advanced';
import { useAppParams } from '@/hooks/use-app-params';
import { useEventQueryFilters } from '@/hooks/use-event-query-filters';
import { useSurfaceValues } from '@/hooks/use-surface-values';

/**
 * fork: scopes the overview to one or more surfaces. Multi-select rather than a
 * fixed Web/App toggle because the values are free-form per tenant, so "both my
 * app surfaces" has to be expressible without the dashboard knowing the
 * vocabulary. Emits the synthetic `surface` filter — see SURFACE_FILTER in
 * overview.service.ts.
 */
export const SURFACE_FILTER = 'surface';

interface SurfaceFilterProps {
  /** Defaults to the route's project — pass it on routes without app params. */
  projectId?: string;
  /** Set on a public share link; switches the option list to the share source. */
  shareId?: string;
}

export function SurfaceFilter({
  projectId: projectIdProp,
  shareId,
}: SurfaceFilterProps = {}) {
  const params = useAppParams();
  const projectId = projectIdProp ?? params.projectId;
  const [filters, setFilter, , removeFilter] = useEventQueryFilters();
  const surfaces = useSurfaceValues(projectId, shareId);
  const selected = filters.find((f) => f.name === SURFACE_FILTER)?.value ?? [];

  // Hidden on a project with nothing to compare — one surface is not a choice.
  if (surfaces.length < 2) {
    return null;
  }

  return (
    <ComboboxAdvanced
      items={surfaces.map((surface) => ({ value: surface, label: surface }))}
      onChange={(next) => {
        const values = next.filter(
          (v): v is string => typeof v === 'string' && v !== '',
        );
        if (values.length === 0) {
          removeFilter(SURFACE_FILTER);
        } else {
          setFilter(SURFACE_FILTER, values, 'is');
        }
      }}
      placeholder="All surfaces"
      value={selected}
    />
  );
}
