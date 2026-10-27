/**
 * Coverage for overview-prompt-conversions.service.ts. The `itCH` block seeds
 * one throwaway project on local dev ClickHouse (`pnpm dock:up`) because the
 * join of outcomes to openings is only assertable against the real engine.
 * Those tests report as SKIPPED, never as passed, without CH.
 */
import type { IChartEventFilter } from '@openpanel/validation';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ch } from '../clickhouse/client';
import {
  getPromptConversions,
  hasPromptConversions,
  sumCounts,
} from './overview-prompt-conversions.service';

const PROJECT = 'prompt-conversions-test';
const EMPTY_PROJECT = 'prompt-conversions-test-empty';

const chReachable = await ch
  .command({ query: 'SELECT 1' })
  .then(() => true)
  .catch(() => false);

const itCH = chReachable ? it : it.skip;

const RANGE = {
  projectId: PROJECT,
  startDate: '2026-07-01 00:00:00',
  endDate: '2026-07-02 00:00:00',
  timezone: 'UTC',
};

let seq = 0;
function event(
  promptId: string,
  name: string,
  path: string,
  properties: Record<string, string> = {},
  createdAt = '2026-07-01 12:00:00',
) {
  seq += 1;
  return {
    id: `00000000-0000-0000-0000-0000000040${String(seq).padStart(2, '0')}`,
    project_id: PROJECT,
    profile_id: `profile-prompt-${promptId}`,
    name,
    session_id: `sess-prompt-${promptId}`,
    device_id: `dev-prompt-${promptId}`,
    created_at: createdAt,
    path,
    properties: { prompt_id: promptId, ...properties },
  };
}

const shown = (promptId: string, reason: string, path = '/games') =>
  event(promptId, 'upgrade_prompt_shown', path, {
    entry_point: 'upgrade_prompt',
    reason,
  });
const clicked = (promptId: string) =>
  event(promptId, 'upgrade_prompt_clicked', '/games');
// Sign-in lands on the publisher's account page, not on the prompt's path.
const signedIn = (promptId: string, attribution: string) =>
  event(promptId, 'account_signin_observed', '/account', { attribution });
const entitlement = (promptId: string, attribution: string) =>
  event(promptId, 'entitlement_changed', '/account', { attribution });

async function cleanup() {
  await Promise.all([
    ch.command({
      query: `DELETE FROM openpanel.events WHERE project_id = '${PROJECT}'`,
    }),
    ch.command({
      query: `ALTER TABLE openpanel.distinct_event_names_mv DELETE WHERE project_id = '${PROJECT}'`,
    }),
    hasPromptConversions.clear(PROJECT),
    hasPromptConversions.clear(EMPTY_PROJECT),
  ]);
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  if (!chReachable) {
    return;
  }
  await cleanup();
  await ch.insert({
    table: 'openpanel.events',
    format: 'JSONEachRow',
    values: [
      // p1: clicked, signed in and changed entitlement: one conversion.
      shown('p1', 'archive_locked'),
      clicked('p1'),
      clicked('p1'),
      signedIn('p1', 'click'),
      entitlement('p1', 'click'),
      // p2: clicked, no outcome.
      shown('p2', 'archive_locked'),
      clicked('p2'),
      // p3: signed in after only seeing the prompt.
      shown('p3', 'archive_locked'),
      signedIn('p3', 'view'),
      // p4: another reason, clicked and changed entitlement.
      shown('p4', 'difficulty_locked', '/other'),
      clicked('p4'),
      entitlement('p4', 'click'),
      // p5: shown before the range; its in-range sign-in is not credited.
      { ...shown('p5', 'archive_locked'), created_at: '2026-06-30 12:00:00' },
      clicked('p5'),
      signedIn('p5', 'click'),
      // A sign-in with no prompt at all.
      event('', 'account_signin_observed', '/account', { attribution: 'none' }),
    ],
  });
});

afterAll(async () => {
  if (chReachable) {
    await cleanup();
  }
  vi.restoreAllMocks();
});

describe('sumCounts', () => {
  it('is zero for no rows', () => {
    expect(sumCounts([])).toEqual({
      shown: 0,
      clicked: 0,
      signed_in: 0,
      entitlement_changed: 0,
      converted: 0,
    });
  });
});

describe('getPromptConversions', () => {
  itCH('counts openings per prompt, crediting only outcomes after a click', async () => {
    const result = await getPromptConversions({ ...RANGE, filters: [] });
    expect(result.rows).toEqual([
      {
        entry_point: 'upgrade_prompt',
        reason: 'archive_locked',
        shown: 3,
        clicked: 2,
        signed_in: 1,
        entitlement_changed: 1,
        converted: 1,
      },
      {
        entry_point: 'upgrade_prompt',
        reason: 'difficulty_locked',
        shown: 1,
        clicked: 1,
        signed_in: 0,
        entitlement_changed: 1,
        converted: 1,
      },
    ]);
    expect(result.total).toEqual({
      shown: 4,
      clicked: 3,
      signed_in: 1,
      entitlement_changed: 2,
      converted: 2,
    });
  });

  itCH('keeps outcomes on another page under a path filter', async () => {
    const result = await getPromptConversions({
      ...RANGE,
      filters: [
        { name: 'path', operator: 'is', value: ['/games'] } as IChartEventFilter,
      ],
    });
    expect(result.rows).toHaveLength(1);
    expect(result.total).toMatchObject({ shown: 3, signed_in: 1, converted: 1 });
  });

  itCH('is empty for a range without prompts', async () => {
    const result = await getPromptConversions({
      ...RANGE,
      startDate: '2026-08-01 00:00:00',
      endDate: '2026-08-02 00:00:00',
      filters: [],
    });
    expect(result).toEqual({ total: sumCounts([]), rows: [] });
  });
});

describe('hasPromptConversions', () => {
  itCH('is true for a project that sent a prompt', async () => {
    expect(await hasPromptConversions(PROJECT)).toBe(true);
  });

  itCH('is false for a project that never did', async () => {
    expect(await hasPromptConversions(EMPTY_PROJECT)).toBe(false);
  });
});
