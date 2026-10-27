/**
 * Prompt conversions widget (fork-only). Do upgrade prompts lead readers to
 * sign in or change entitlement? Shown, Clicked and Converted as tiles over a
 * per-prompt table. Renders nothing for a project that never sent a prompt.
 *
 * Data: overview.promptConversions. Share-safe.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEventQueryFilters } from '@/hooks/use-event-query-filters';
import { useNumber } from '@/hooks/use-numer-formatter';
import { useTRPC } from '@/integrations/trpc/react';
import type { RouterOutputs } from '@/trpc/client';
import { Widget, WidgetBody } from '@/components/widget';
import { WidgetTable } from '@/components/widget-table';
import { WidgetFooter, WidgetHead } from '@/components/overview/overview-widget';
import { useOverviewOptions } from '@/components/overview/useOverviewOptions';
import { cn } from '@/utils/cn';
import { Hint, rate, smallSampleRate } from './overview-games';

type PromptConversions = NonNullable<
  RouterOutputs['overview']['promptConversions']
>;
type PromptRow = PromptConversions['rows'][number];

const NUMERIC = 'text-right font-mono';

function percent(numerator: number, denominator: number): number | null {
  return denominator > 0 ? (numerator * 100) / denominator : null;
}

/** `archive_locked` → `Archive locked`. */
function humanize(value: string): string {
  const words = value.replaceAll('_', ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Not set';
}

export default function OverviewPromptConversions({
  projectId,
  shareId,
}: {
  projectId: string;
  shareId?: string;
}) {
  const { range, startDate, endDate } = useOverviewOptions();
  const [filters] = useEventQueryFilters();
  const trpc = useTRPC();
  const { data } = useQuery(
    trpc.overview.promptConversions.queryOptions(
      { projectId, shareId, range, startDate, endDate, filters },
      // A range or filter change must not drop the card while it reloads.
      { placeholderData: keepPreviousData },
    ),
  );

  if (!data) {
    return null;
  }

  return (
    <Widget className="col-span-6">
      <WidgetHead>
        <div className="title">Prompt conversions</div>
      </WidgetHead>
      <WidgetBody className="p-0">
        <Tiles total={data.total} />
        <PromptTable rows={data.rows} />
      </WidgetBody>
      <WidgetFooter>
        <p className="text-muted-foreground text-xs">
          Counts are prompt openings, not readers. An outcome counts when it
          followed a click on the same opening within an hour, and both fall in
          the selected range.
        </p>
      </WidgetFooter>
    </Widget>
  );
}

function Tiles({ total }: { total: PromptConversions['total'] }) {
  const number = useNumber();
  const tiles: {
    id: string;
    label: ReactNode;
    value: number;
    share: number | null;
    of: string | null;
  }[] = [
    {
      id: 'shown',
      label: 'Shown',
      value: total.shown,
      share: 100,
      of: null,
    },
    {
      id: 'clicked',
      label: 'Clicked',
      value: total.clicked,
      share: percent(total.clicked, total.shown),
      of: 'openings',
    },
    {
      id: 'converted',
      label: (
        <Hint tip="Clicked openings followed by a sign-in or an entitlement change.">
          Converted
        </Hint>
      ),
      value: total.converted,
      share: percent(total.converted, total.clicked),
      of: 'clicks',
    },
  ];

  return (
    <div className="grid grid-cols-1 border-b sm:grid-cols-3">
      {tiles.map((tile, i) => (
        <div
          key={tile.id}
          className={cn('px-4 py-3', i > 0 && 'border-t sm:border-t-0 sm:border-l')}
        >
          <div className="text-muted-foreground text-sm">{tile.label}</div>
          <div className="mt-2 font-mono font-semibold text-3xl tabular-nums">
            {number.short(tile.value)}
          </div>
          <div className="mt-1.5 text-muted-foreground text-sm">
            {tile.of ? `${rate(tile.share)} of ${tile.of}` : ' '}
          </div>
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-def-200">
            <div
              className="h-full bg-chart-0"
              style={{
                width: `${tile.share ? Math.min(100, Math.max(2, tile.share)) : 0}%`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function PromptTable({ rows }: { rows: PromptRow[] }) {
  const number = useNumber();
  const count = (value: number) => (
    <span className="font-semibold">{number.short(value)}</span>
  );

  return (
    // Not OverviewWidgetTable: its fixed 358px minimum leaves a void under the
    // few rows a project has, and sorting a handful of prompts adds nothing.
    <WidgetTable
      data={rows}
      keyExtractor={(r) => `${r.entry_point}:${r.reason}`}
      className="@container text-sm"
      columnClassName="[&_.cell:first-child]:pl-4 [&_.cell:last-child]:pr-4"
      columns={[
        {
          name: 'Prompt',
          width: 'w-full',
          className: 'w-full min-w-0 text-left font-medium',
          responsive: { priority: 1 },
          render: (r: PromptRow) => (
            <div className="truncate">
              {humanize(r.reason)}
              <span className="ml-2 text-muted-foreground text-xs">
                {humanize(r.entry_point)}
              </span>
            </div>
          ),
        },
        {
          name: 'Shown',
          width: '84px',
          className: NUMERIC,
          responsive: { priority: 2 },
          render: (r: PromptRow) => count(r.shown),
        },
        {
          name: 'Click rate',
          width: '96px',
          className: NUMERIC,
          responsive: { priority: 6 },
          render: (r: PromptRow) =>
            smallSampleRate(percent(r.clicked, r.shown), r.shown, 'openings'),
        },
        {
          name: 'Signed in',
          width: '90px',
          className: NUMERIC,
          responsive: { priority: 7 },
          render: (r: PromptRow) => count(r.signed_in),
        },
        {
          name: (
            <Hint tip="The reader's entitlement changed after the click. Not a confirmed purchase.">
              Entitlement
            </Hint>
          ),
          width: '104px',
          className: NUMERIC,
          responsive: { priority: 8 },
          render: (r: PromptRow) => count(r.entitlement_changed),
        },
        {
          name: 'Converted',
          width: '96px',
          className: NUMERIC,
          responsive: { priority: 4 },
          render: (r: PromptRow) => count(r.converted),
        },
        {
          name: 'Of clicks',
          width: '88px',
          className: NUMERIC,
          responsive: { priority: 5 },
          render: (r: PromptRow) =>
            smallSampleRate(percent(r.converted, r.clicked), r.clicked, 'clicks'),
        },
      ]}
    />
  );
}
