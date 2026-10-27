import OverviewRetention from '@/components/custom/overview-retention';
import OverviewTopEventsProperties from '@/components/custom/overview-top-events-properties';
import OverviewGames from '@/components/custom/overview-games';
import OverviewPromptConversions from '@/components/custom/overview-prompt-conversions';
import {
  DEFAULT_WIDGETS,
  type OverviewWidgetDef,
} from './overview-widgets';

// === Widget customization ===
// Hide Revenue / Pageviews / Pages-per-session / Bounce Rate metrics, remove
// Insights / Top Sources / Top Pages widgets
const HIDDEN_METRIC_KEYS = ['total_revenue', 'total_screen_views', 'views_per_session', 'bounce_rate'];

// Retention section (Tenure River + Cohort Quality) — honest stock + flow
// signals derived from days_since_first_visit. See
// components/custom/overview-retention.tsx.
const RETENTION: OverviewWidgetDef = {
  key: 'retention',
  component: OverviewRetention,
  contexts: ['dashboard', 'share'],
  lazyViewport: true,
};

// Games — every game side by side (viewed / play rate / started / completion /
// returning / median solve, with a daily-starts sparkline per row), plus a
// Teaser tab for projects that have one. Full width, and placed directly
// under the metric cards: it is the view stakeholders screenshot, so it sits
// above the Retention section rather than below it.
const GAMES: OverviewWidgetDef = {
  key: 'games',
  component: OverviewGames,
  contexts: ['dashboard', 'share'],
};

// Prompt conversions — upgrade prompt openings, clicks and the sign-ins or
// entitlement changes they led to. Last on the board; renders nothing for a
// project that never sent a prompt.
const PROMPT_CONVERSIONS: OverviewWidgetDef = {
  key: 'prompt-conversions',
  component: OverviewPromptConversions,
  contexts: ['dashboard', 'share'],
};

// The top-devices def, re-inserted after top-events. Deferred until it scrolls
// into view: it sits in the bottom content row (paired with Top geo), so on a
// typical viewport it's below the fold — keeping its overview.topGeneric query
// out of the cold-load burst that saturates the 8-core ClickHouse box. Half
// width, so the LazyComponent wrapper must keep its col-span (md:col-span-3).
const TOP_DEVICES: OverviewWidgetDef = {
  ...DEFAULT_WIDGETS.find(w => w.key === 'top-devices')!,
  lazyViewport: true,
  wrapperClassName: 'col-span-6 md:col-span-3',
};

// Widgets removed from the overview entirely:
// - insights (upstream dashboard-only widget)
// - top-sources (Refs/Urls/Types/Source/Medium/Campaign/Term/Content)
// - top-pages (Pages/Entries/Exits)
const REMOVED_WIDGET_KEYS = ['insights', 'top-sources', 'top-pages'];

const FORK_WIDGETS: OverviewWidgetDef[] = DEFAULT_WIDGETS
  .map(w => (w.key === 'metrics' || w.key === 'weekly-trends')
    ? { ...w, props: { excludeMetricKeys: HIDDEN_METRIC_KEYS } }
    : w)
  .filter(w => !REMOVED_WIDGET_KEYS.includes(w.key))
  // Games, then the retention section, both right after the metrics widget.
  .flatMap(w => w.key === 'metrics' ? [w, GAMES, RETENTION] : [w])
  // Move top-devices after top-events, so it pairs with Geo.
  .flatMap(w => {
    if (w.key === 'top-devices') return [];
    // Swap in the drill-down Events widget (event -> property keys -> values).
    if (w.key === 'top-events') {
      return [{ ...w, component: OverviewTopEventsProperties }, TOP_DEVICES];
    }
    // Top geo (the heaviest cold-load query, overview.map) stays deferred to
    // viewport so the heavy map scan leaves the initial burst. Full width: with
    // Games taking a full row, Events and Devices pair off and Geo would
    // otherwise sit alone in a half-width column with dead space beside it.
    if (w.key === 'top-geo') {
      return [{ ...w, lazyViewport: true }];
    }
    return [w];
  })
  .concat(PROMPT_CONVERSIONS);

export function getWidgets(context: 'dashboard' | 'share'): OverviewWidgetDef[] {
  return FORK_WIDGETS.filter(w => w.contexts.includes(context));
}
