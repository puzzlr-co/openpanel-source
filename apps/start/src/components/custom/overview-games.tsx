/**
 * Games widget (fork-only) — every game side by side, and the Teaser.
 *
 * Full games answers the question clients actually ask of the shared
 * dashboard: "how do crosswords compare to sudoku?". One row per game, with
 * reach (viewed), pull (play rate), volume (puzzles started), quality
 * (completion rate), loyalty (returning rate) and effort (median solve), plus a
 * per-row sparkline of daily starts. Sortable on every column; the whole
 * comparison is on screen at once, which is what makes it screenshot-able into
 * a stakeholder deck.
 *
 * Chosen over three alternatives — a global game filter in the header, a
 * per-metric breakout, and a master-detail drill-down — after building all four
 * (2026-07-31). The filter variant lost on a hard data constraint: only 2 of
 * the 7 headline metrics can be scoped to one game honestly (the sessions table
 * has no game column, and session_start carries a game on just ~65% of events),
 * so scoping the page silently leaves three cards unchanged and drives
 * Multi-game sessions to 0% by construction. This widget sidesteps that
 * entirely — every figure in it is natively per-game.
 *
 * The Teaser tab (only for a project that has sent a Teaser view) is the
 * in-article entry point: Viewed, Played, Solved, Opened full game as tiles
 * over a per-game or per-article table. Teaser plays never count in Full games.
 *
 * Data: overview.gameBreakdown and overview.teaserFunnel. Share-safe.
 */
import { useQuery } from '@tanstack/react-query';
import type { IChartRange } from '@openpanel/validation';
import {
  parseISO,
  startOfMonth,
  startOfToday,
  startOfYear,
  subDays,
  subMonths,
  subYears,
} from 'date-fns';
import { type ReactNode, useState } from 'react';
import { useEventQueryFilters } from '@/hooks/use-event-query-filters';
import { useNumber } from '@/hooks/use-numer-formatter';
import { useTeaserFunnel } from '@/hooks/use-teaser-funnel.fork';
import { useTRPC } from '@/integrations/trpc/react';
import type { RouterOutputs } from '@/trpc/client';
import { SerieIcon } from '@/components/report-chart/common/serie-icon';
import { Widget, WidgetBody } from '@/components/widget';
import {
  WidgetButtons,
  WidgetFooter,
  WidgetHead,
} from '@/components/overview/overview-widget';
import {
  OverviewWidgetTable,
  OverviewWidgetTableLoading,
} from '@/components/overview/overview-widget-table';
import { useOverviewOptions } from '@/components/overview/useOverviewOptions';
import { Tooltiper } from '@/components/ui/tooltip';
import { cn } from '@/utils/cn';
import { getChartColor, getChartTranslucentColor } from '@/utils/theme';
import { GameSparkline } from './game-sparkline';

type GameRow = RouterOutputs['overview']['gameBreakdown']['rows'][number];
type TeaserFunnel = NonNullable<RouterOutputs['overview']['teaserFunnel']>;
type TeaserRow = TeaserFunnel['rows'][number];
type By = TeaserFunnel['by'];
type Tab = 'games' | 'teaser';

const TABS: { tab: Tab; label: string }[] = [
  { tab: 'games', label: 'Full games' },
  { tab: 'teaser', label: 'Teaser' },
];

const BY_TABS: { by: By; label: string }[] = [
  { by: 'game', label: 'By game' },
  { by: 'article', label: 'By article' },
];

// puzzlr's engaged-starts release: game_viewed begins, Started moves to the
// reader's first move.
const ENGAGED_STARTS_DAY = new Date(2026, 9, 2);

/**
 * The board's range as local dates. Day-precise is enough for the one question
 * it answers, so the project timezone is ignored.
 */
function rangeBounds(
  range: IChartRange,
  startDate: string | null,
  endDate: string | null,
): [Date, Date] {
  const now = new Date();
  const today = startOfToday();
  if (range === 'custom' && startDate && endDate) {
    return [parseISO(startDate), parseISO(endDate)];
  }
  switch (range) {
    case 'yesterday':
      return [subDays(today, 1), today];
    case '7d':
      return [subDays(today, 7), now];
    case '30d':
      return [subDays(today, 30), now];
    case '3m':
      return [subMonths(today, 3), now];
    case '6m':
      return [subMonths(today, 6), now];
    case '12m':
      return [startOfMonth(subMonths(today, 12)), now];
    case 'monthToDate':
      return [startOfMonth(today), now];
    case 'lastMonth':
      return [startOfMonth(subMonths(today, 1)), startOfMonth(today)];
    case 'yearToDate':
      return [startOfYear(today), now];
    case 'lastYear':
      return [startOfYear(subYears(today, 1)), startOfYear(today)];
    default:
      return [subDays(today, 1), now];
  }
}

/**
 * Median seconds → a duration a stakeholder can read at a glance. 0 is the
 * service's "no timed completions" sentinel (a game that emits level_completed
 * without time_seconds), and must never render as "0s".
 */
function formatSolve(seconds: number): string {
  if (!seconds) {
    return '—';
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return secs ? `${mins}m ${secs}s` : `${mins}m`;
}

/** Red below half, amber below 80%: readers see the puzzle and scroll past. */
function playRateTone(rate: number) {
  if (rate < 50) {
    return 'text-red-600 dark:text-red-400';
  }
  return rate < 80 ? 'text-amber-600 dark:text-amber-400' : '';
}

/** A rate in %; a non-zero rate that rounds to 0 must not read as none. */
export function rate(value: number | null): string {
  if (value == null) {
    return '—';
  }
  return value > 0 && value < 0.5 ? '<1%' : `${Math.round(value)}%`;
}

// Below this many visits, players or clicks, a per-row rate is mostly noise.
const MIN_RATE_BASE = 30;

export function smallSampleRate(value: number | null, base: number, unit: string) {
  if (base >= MIN_RATE_BASE) {
    return rate(value);
  }
  return (
    <span className="text-muted-foreground" title={`From ${base} ${unit}`}>
      {rate(value)}
    </span>
  );
}

function percent(numerator: number, denominator: number): number | null {
  return denominator > 0 ? (numerator * 100) / denominator : null;
}

/** A label whose meaning is not obvious from the word: dotted, with a hover definition. */
export function Hint({ children, tip }: { children: ReactNode; tip: string }) {
  return (
    <Tooltiper
      asChild
      content={tip}
      tooltipClassName="max-w-xs leading-normal"
    >
      <span className="cursor-help underline decoration-muted-foreground decoration-dotted underline-offset-4">
        {children}
      </span>
    </Tooltiper>
  );
}

/** The "Other" row can only carry additive measures — see IGameBreakdownRow. */
function NotApplicable() {
  return (
    <Tooltiper content="Not available for the Other row: a median and a returning rate are not additive, so neither can be derived by summing the games folded into it.">
      <span className="text-muted-foreground">n/a</span>
    </Tooltiper>
  );
}

export default function OverviewGames({
  projectId,
  shareId,
}: {
  projectId: string;
  shareId?: string;
}) {
  const [tab, setTab] = useState<Tab>('games');
  const teaser = useTeaserFunnel({ projectId, shareId, by: 'game' }).data;
  const activeTab: Tab = teaser ? tab : 'games';

  return (
    <Widget className="col-span-6">
      <WidgetHead>
        <div className="title">Games</div>
        {teaser && (
          <WidgetButtons>
            {TABS.map((t) => (
              <button
                type="button"
                key={t.tab}
                onClick={() => setTab(t.tab)}
                className={cn(activeTab === t.tab && 'active')}
              >
                {t.label}
              </button>
            ))}
          </WidgetButtons>
        )}
      </WidgetHead>
      {activeTab === 'teaser' && teaser ? (
        <TeaserPanel projectId={projectId} shareId={shareId} byGame={teaser} />
      ) : (
        <FullGames projectId={projectId} shareId={shareId} />
      )}
    </Widget>
  );
}

function FullGames({
  projectId,
  shareId,
}: {
  projectId: string;
  shareId?: string;
}) {
  const { range, startDate, endDate } = useOverviewOptions();
  const [filters] = useEventQueryFilters();
  const number = useNumber();
  const trpc = useTRPC();

  const query = useQuery(
    trpc.overview.gameBreakdown.queryOptions({
      projectId,
      shareId,
      range,
      startDate,
      endDate,
      filters,
    }),
  );

  const rows = query.data?.rows ?? [];
  // At most ~13 rows, so plain derivation beats memoization.
  const maxOpens = Math.max(1, ...rows.map((g) => g.opens));
  // One y-domain across every sparkline: scaled per row, a 200/day game would
  // draw the same peak as a 3,000/day one.
  const seriesMax = Math.max(1, ...rows.flatMap((g) => g.series));
  // Colour follows the game, never its position. The table is sortable, so
  // keying off the rendered row index would repaint every sparkline whenever a
  // column header is clicked and "the orange one" would become a different game.
  // The server's order (opens DESC) is the stable assignment.
  const colorByGame = new Map(rows.map((g, i) => [g.game, getChartColor(i)]));
  const fillByGame = new Map(
    rows.map((g, i) => [g.game, getChartTranslucentColor(i)]),
  );
  // Never clamped — a clamp would also hide a genuine dedup regression — so the
  // footer explains it on the rare view where it shows up.
  const hasRateOverHundred = rows.some((g) => g.completion_rate > 100);
  const [from, to] = rangeBounds(range, startDate, endDate);
  const crossesEngagedStarts = from < ENGAGED_STARTS_DAY && to >= ENGAGED_STARTS_DAY;

  return (
    <>
      <WidgetBody className="p-0">
        {query.isLoading ? (
          <OverviewWidgetTableLoading />
        ) : (
          <OverviewWidgetTable
            data={rows}
            keyExtractor={(g) => g.game}
            getColumnPercentage={(g) => g.opens / maxOpens}
            columns={[
              {
                name: 'Game',
                width: 'w-full',
                responsive: { priority: 1 },
                getSortValue: (g: GameRow) => g.game,
                render(g: GameRow) {
                  return (
                    <div className="row min-w-0 items-center gap-2">
                      {g.is_other ? (
                        <span className="size-4 shrink-0" />
                      ) : (
                        <SerieIcon name={g.game} />
                      )}
                      <span className="truncate">
                        {g.is_other
                          ? `Other (${g.other_count} games)`
                          : g.game}
                      </span>
                    </div>
                  );
                },
              },
              {
                name: 'Trend',
                width: '120px',
                // First to hide: the sparkline is the one column whose
                // information is fully carried by the numbers beside it.
                responsive: { priority: 8 },
                render: (g: GameRow) => (
                  <GameSparkline
                    color={colorByGame.get(g.game) ?? getChartColor(0)}
                    domainMax={seriesMax}
                    fill={fillByGame.get(g.game) ?? getChartTranslucentColor(0)}
                    label={`Daily puzzles started for ${g.game}`}
                    values={g.series}
                  />
                ),
              },
              {
                key: 'Viewed',
                name: (
                  <Hint tip="Visits that had at least half the puzzle on screen for a second.">
                    Viewed
                  </Hint>
                ),
                width: '90px',
                responsive: { priority: 5 },
                getSortValue: (g: GameRow) => g.viewed,
                render: (g: GameRow) => (
                  <span className="font-semibold">
                    {g.viewed ? number.short(g.viewed) : '—'}
                  </span>
                ),
              },
              {
                name: 'Play rate',
                width: '100px',
                responsive: { priority: 4 },
                getSortValue: (g: GameRow) => g.play_rate ?? -1,
                render: (g: GameRow) =>
                  g.play_rate == null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <span className={`font-semibold ${playRateTone(g.play_rate)}`}>
                      {Math.round(g.play_rate)}%
                    </span>
                  ),
              },
              {
                key: 'Started',
                name: (
                  <Hint tip="Puzzles a reader made a first move in. Before 2 Oct 2026, puzzles that loaded.">
                    Started
                  </Hint>
                ),
                width: '90px',
                responsive: { priority: 2 },
                getSortValue: (g: GameRow) => g.opens,
                render: (g: GameRow) => (
                  <span className="font-semibold">{number.short(g.opens)}</span>
                ),
              },
              {
                name: 'Completion',
                width: '110px',
                responsive: { priority: 3 },
                getSortValue: (g: GameRow) => g.completion_rate,
                render: (g: GameRow) => (
                  <span className="font-semibold">
                    {Math.round(g.completion_rate)}%
                  </span>
                ),
              },
              {
                name: 'Returning',
                width: '104px',
                responsive: { priority: 6 },
                getSortValue: (g: GameRow) => g.returning_rate,
                render: (g: GameRow) =>
                  g.is_other ? (
                    <NotApplicable />
                  ) : (
                    <span className="font-semibold">
                      {Math.round(g.returning_rate)}%
                    </span>
                  ),
              },
              {
                name: 'Median solve',
                width: '116px',
                responsive: { priority: 7 },
                getSortValue: (g: GameRow) => g.median_solve_s,
                render: (g: GameRow) =>
                  g.is_other ? (
                    <NotApplicable />
                  ) : (
                    <span className="font-semibold">
                      {formatSolve(g.median_solve_s)}
                    </span>
                  ),
              },
            ]}
          />
        )}
      </WidgetBody>
      {(crossesEngagedStarts || hasRateOverHundred) && (
        <WidgetFooter>
          <p className="text-muted-foreground text-xs">
            {crossesEngagedStarts &&
              'Viewed and Play rate start on 2 Oct 2026, and Started changed that day, so compare across it with care.'}
            {crossesEngagedStarts && hasRateOverHundred && ' '}
            {hasRateOverHundred &&
              'Completion above 100% means more puzzles were finished than started in this view — either they were started before the range began, or an active filter matches the two events unevenly.'}
          </p>
        </WidgetFooter>
      )}
    </>
  );
}

function TeaserPanel({
  projectId,
  shareId,
  byGame,
}: {
  projectId: string;
  shareId?: string;
  byGame: TeaserFunnel;
}) {
  const [picked, setPicked] = useState<By>('game');
  // With one Teaser game, a per-game table repeats the tiles.
  const hasGameChoice = byGame.rows.length > 1;
  const by: By = hasGameChoice ? picked : 'article';
  const byArticle = useTeaserFunnel({
    projectId,
    shareId,
    by: 'article',
    enabled: by === 'article',
  });
  const table = by === 'game' ? byGame : byArticle.data;

  return (
    <WidgetBody className="p-0">
      <TeaserTiles total={byGame.total} />
      <div className="row h-10 items-center justify-between border-b px-4">
        <span className="text-muted-foreground text-sm">
          {by === 'game' ? 'Per game' : 'Per article'}
        </span>
        {hasGameChoice && (
          <div className="row gap-1">
            {BY_TABS.map((t) => (
              <button
                type="button"
                key={t.by}
                onClick={() => setPicked(t.by)}
                className={cn(
                  'rounded-md px-2 py-1 text-muted-foreground text-sm hover:text-foreground',
                  by === t.by && 'bg-def-200 text-foreground',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {table ? (
        <TeaserTable funnel={table} showGames={hasGameChoice} />
      ) : (
        <OverviewWidgetTableLoading />
      )}
    </WidgetBody>
  );
}

function TeaserTiles({ total }: { total: TeaserFunnel['total'] }) {
  const number = useNumber();
  const tiles: {
    id: string;
    label: ReactNode;
    value: number;
    share: number | null;
    of: string | null;
  }[] = [
    {
      id: 'viewed',
      label: (
        <Hint tip="Visits that had at least half the Teaser on screen for a second.">
          Viewed
        </Hint>
      ),
      value: total.viewed,
      share: 100,
      of: null,
    },
    {
      id: 'played',
      label: 'Played',
      value: total.started,
      share: total.play_rate,
      of: 'viewers',
    },
    {
      id: 'solved',
      label: 'Solved',
      value: total.solved,
      share: total.solve_rate,
      of: 'players',
    },
    {
      id: 'reached',
      label: (
        <Hint tip="Visits in which the reader opened the full game from the Teaser's button.">
          Opened full game
        </Hint>
      ),
      value: total.reached,
      share: percent(total.reached, total.solved),
      of: 'solvers',
    },
  ];

  return (
    <div className="grid grid-cols-2 border-b md:grid-cols-4">
      {tiles.map((tile, i) => (
        <div
          key={tile.id}
          className={cn(
            'px-4 py-3',
            i % 2 === 1 && 'border-l',
            i >= 2 && 'border-t md:border-t-0',
            i === 2 && 'md:border-l',
          )}
        >
          <div className="text-muted-foreground text-sm">{tile.label}</div>
          <div className="mt-2 font-mono font-semibold text-3xl tabular-nums">
            {number.short(tile.value)}
          </div>
          <div className="mt-1.5 text-muted-foreground text-sm">
            {tile.of ? `${rate(tile.share)} of ${tile.of}` : ' '}
          </div>
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-def-200">
            <div
              className="h-full bg-chart-0"
              // Play rate can pass 100% (viewed undercounts); the meter cannot.
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

function rowKey(row: TeaserRow): string {
  return row.kind === 'named' ? `named:${row.key}` : row.kind;
}

function TeaserTable({
  funnel,
  showGames,
}: {
  funnel: TeaserFunnel;
  showGames: boolean;
}) {
  const number = useNumber();
  const maxViewed = Math.max(1, ...funnel.rows.map((r) => r.viewed));

  return (
    <OverviewWidgetTable
      data={funnel.rows}
      keyExtractor={rowKey}
      getColumnPercentage={(r) => r.viewed / maxViewed}
      columns={[
        {
          name: funnel.by === 'game' ? 'Game' : 'Article',
          width: 'w-full',
          responsive: { priority: 1 },
          render: (r: TeaserRow) => (
            <RowLabel
              row={r}
              by={funnel.by}
              showGames={showGames}
              unrecordedTip={unrecordedTip(funnel)}
            />
          ),
        },
        {
          name: 'Viewed',
          width: '84px',
          responsive: { priority: 2 },
          getSortValue: (r: TeaserRow) => r.viewed,
          render: (r: TeaserRow) => (
            <span className="font-semibold">{number.short(r.viewed)}</span>
          ),
        },
        {
          name: 'Play rate',
          width: '96px',
          responsive: { priority: 3 },
          getSortValue: (r: TeaserRow) => r.play_rate ?? -1,
          render: (r: TeaserRow) => smallSampleRate(r.play_rate, r.viewed, 'visits'),
        },
        {
          name: 'Solve rate',
          width: '100px',
          responsive: { priority: 5 },
          getSortValue: (r: TeaserRow) => r.solve_rate ?? -1,
          render: (r: TeaserRow) => smallSampleRate(r.solve_rate, r.started, 'players'),
        },
        {
          name: 'Full game',
          width: '96px',
          responsive: { priority: 4 },
          getSortValue: (r: TeaserRow) => r.reached,
          render: (r: TeaserRow) => (
            <span className="font-semibold">{number.short(r.reached)}</span>
          ),
        },
      ]}
    />
  );
}

function unrecordedTip({ article_cutover, timezone }: TeaserFunnel): string {
  if (!article_cutover) {
    return 'Teaser views carry no article yet.';
  }
  const when = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
    timeZoneName: 'short',
  }).format(article_cutover);
  return `Teaser views before ${when} carry no article.`;
}

function RowLabel({
  row,
  by,
  showGames,
  unrecordedTip,
}: {
  row: TeaserRow;
  by: By;
  showGames: boolean;
  unrecordedTip: string;
}) {
  if (row.kind === 'unrecorded_article') {
    return (
      <div className="row min-w-0 text-muted-foreground">
        <Hint tip={unrecordedTip}>
          Article not recorded
        </Hint>
      </div>
    );
  }
  if (row.kind === 'other') {
    const noun = by === 'game' ? 'games' : 'articles';
    return (
      <span className="truncate">
        Other ({row.other_count} {noun})
      </span>
    );
  }
  if (by === 'game') {
    return (
      <div className="row min-w-0 items-center gap-2">
        <SerieIcon name={row.key} />
        <span className="truncate">{row.key}</span>
      </div>
    );
  }
  return (
    <div className="row min-w-0 items-center gap-2">
      <Tooltiper content={row.key} asChild>
        <span className="min-w-0 truncate">{row.key}</span>
      </Tooltiper>
      {showGames &&
        row.games?.map((game) => (
          <span
            key={game}
            className="hidden shrink-0 rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs sm:inline"
          >
            {game}
          </span>
        ))}
    </div>
  );
}
