/**
 * Upgrade prompt conversions for the overview Prompt conversions widget
 * (fork-only).
 *
 * Every opening of an upgrade prompt carries its own `prompt_id` (a UUID; on
 * prod 2026-10-19..27 each id had exactly one upgrade_prompt_shown). The client
 * attributes a later sign-in or entitlement change to the opening it followed
 * and stamps that event with the opening's `prompt_id` and an `attribution` of
 * 'click', 'view' or 'none' (window: `attribution_window_hours`, 1). This
 * service counts openings, not people:
 *
 *   shown                upgrade_prompt_shown in range, under the board's filters
 *   clicked              the opening also has an upgrade_prompt_clicked
 *   signed_in            clicked, and an account_signin_observed attributed 'click'
 *   entitlement_changed  clicked, and an entitlement_changed attributed 'click'
 *   converted            clicked, and either outcome
 *
 * Filters pick the openings only. Clicks and outcomes join by `prompt_id` and
 * are scoped by project and range, because a sign-in often lands on another
 * page than the prompt (a path filter would drop it).
 */
import { cacheable } from '@openpanel/redis';
import type { IChartEventFilter } from '@openpanel/validation';
import { ch, TABLE_NAMES } from '../clickhouse/client';
import { clix } from '../clickhouse/query-builder';
import { overviewService } from './overview.service';

// A project starts sending prompts only when its host turns them on, so a stale
// "no prompts" hides the widget for at most this long.
const HAS_PROMPTS_TTL_SECONDS = 60 * 10;

export type IPromptConversionCounts = {
  shown: number;
  clicked: number;
  signed_in: number;
  entitlement_changed: number;
  converted: number;
};

export type IPromptConversionRow = IPromptConversionCounts & {
  entry_point: string;
  reason: string;
};

export type IPromptConversions = {
  total: IPromptConversionCounts;
  rows: IPromptConversionRow[];
};

type PromptConversionsInput = {
  projectId: string;
  filters: IChartEventFilter[];
  startDate: string;
  endDate: string;
  timezone: string;
};

async function fetchHasPrompts(projectId: string): Promise<boolean> {
  const seen = await clix(ch)
    .select<{ name: string }>(['name'])
    .from(TABLE_NAMES.event_names_mv)
    .where('project_id', '=', projectId)
    .where('name', '=', 'upgrade_prompt_shown')
    .limit(1)
    .execute();
  return seen.length > 0;
}

/** Whether the project ever sent upgrade_prompt_shown. */
export const hasPromptConversions = cacheable(
  fetchHasPrompts,
  HAS_PROMPTS_TTL_SECONDS,
);

export async function getPromptConversions(
  input: PromptConversionsInput,
): Promise<IPromptConversions> {
  const { projectId, filters, startDate, endDate, timezone } = input;
  const inRange = () =>
    clix(ch, timezone)
      .from(TABLE_NAMES.events, false)
      .where('project_id', '=', projectId)
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .rawWhere("properties['prompt_id'] != ''");

  const shown = inRange()
    .select([
      "properties['prompt_id'] AS prompt_id",
      "any(properties['entry_point']) AS entry_point",
      "any(properties['reason']) AS reason",
    ])
    .where('name', '=', 'upgrade_prompt_shown')
    .rawWhere(
      overviewService.getRawWhereClause('events', filters, {
        projectId,
        startDate,
        endDate,
      }),
    )
    .groupBy(['prompt_id']);

  const acted = inRange()
    .select([
      "properties['prompt_id'] AS prompt_id",
      "max(name = 'upgrade_prompt_clicked') AS has_clicked",
      "max(name = 'account_signin_observed' AND properties['attribution'] = 'click') AS has_signed_in",
      "max(name = 'entitlement_changed' AND properties['attribution'] = 'click') AS has_entitlement",
    ])
    .where('name', 'IN', [
      'upgrade_prompt_clicked',
      'account_signin_observed',
      'entitlement_changed',
    ])
    .groupBy(['prompt_id']);

  const rows = await clix(ch, timezone)
    .with('shown', shown)
    .with('acted', acted)
    .select<IPromptConversionRow>([
      'entry_point',
      'reason',
      'count() AS shown',
      'countIf(has_clicked) AS clicked',
      'countIf(has_clicked AND has_signed_in) AS signed_in',
      'countIf(has_clicked AND has_entitlement) AS entitlement_changed',
      'countIf(has_clicked AND (has_signed_in OR has_entitlement)) AS converted',
    ])
    .from('shown')
    .leftJoin('acted', 'shown.prompt_id = acted.prompt_id')
    .groupBy(['entry_point', 'reason'])
    .orderBy('shown', 'DESC')
    .execute();

  return { total: sumCounts(rows), rows };
}

/** Exact: each opening belongs to one (entry_point, reason) row. */
export function sumCounts(rows: IPromptConversionCounts[]): IPromptConversionCounts {
  const total: IPromptConversionCounts = {
    shown: 0,
    clicked: 0,
    signed_in: 0,
    entitlement_changed: 0,
    converted: 0,
  };
  for (const row of rows) {
    total.shown += row.shown;
    total.clicked += row.clicked;
    total.signed_in += row.signed_in;
    total.entitlement_changed += row.entitlement_changed;
    total.converted += row.converted;
  }
  return total;
}
