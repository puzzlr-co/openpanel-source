/**
 * Coverage for overview-surfaces.service.ts.
 *
 * `canExposeShareSurfaces` is pure. The `itCH` block drives the real query
 * against the real `event_property_values_mv` on local dev ClickHouse
 * (`pnpm dock:up`), inserting events into two throwaway project ids, because
 * the thing this endpoint has to get right — the distinct values of ONE
 * property for ONE project and nothing else — is only assertable against the
 * real table. Those tests report as SKIPPED, never as passed, without CH.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ch } from '../clickhouse/client';
import {
  canExposeShareSurfaces,
  fetchSurfaceValues,
} from './overview-surfaces.service';

const PROJECT_A = 'surface-values-test-a';
const PROJECT_B = 'surface-values-test-b';

// Probed at collection time, not in beforeAll: the `return early inside it()`
// shape used in overview.service.test.ts would tick green for the cross-project
// isolation assertions even though they never ran.
const chReachable = await ch
  .command({ query: 'SELECT 1' })
  .then(() => true)
  .catch(() => false);

const itCH = chReachable ? it : it.skip;

// `id` is a UUID column — these live in their own namespace so they can never
// collide with test/fixtures.ts.
const eventId = (n: number) =>
  `00000000-0000-0000-0000-0000000009${String(n).padStart(2, '0')}`;

function buildEvent(
  projectId: string,
  n: number,
  properties: Record<string, string>,
) {
  return {
    id: eventId(n),
    project_id: projectId,
    profile_id: `profile-surface-${n}`,
    name: 'level_completed',
    session_id: `sess-surface-${n}`,
    device_id: `dev-surface-${n}`,
    created_at: '2026-07-01 12:00:00',
    properties,
  };
}

async function cleanup() {
  await Promise.all(
    [PROJECT_A, PROJECT_B].flatMap((projectId) => [
      ch.command({
        query: `DELETE FROM openpanel.events WHERE project_id = '${projectId}'`,
      }),
      ch.command({
        query: `ALTER TABLE openpanel.event_property_values_mv DELETE WHERE project_id = '${projectId}'`,
      }),
    ]),
  );
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
      // Free-form host vocabulary, plus the system fallback, plus a second
      // property that must never leak into the surface list.
      buildEvent(PROJECT_A, 1, {
        embed_surface: 'news_web',
        game_id: 'sudoku',
      }),
      buildEvent(PROJECT_A, 2, { embed_surface: 'game_app' }),
      buildEvent(PROJECT_A, 3, { embed_surface: 'web' }),
      // Pre-ADR-0008 "not set" state.
      buildEvent(PROJECT_A, 4, { embed_surface: '' }),
      // No surface at all (Openpanel's automatic events).
      buildEvent(PROJECT_A, 5, { game_id: 'crossword' }),
      // A different project entirely.
      buildEvent(PROJECT_B, 6, { embed_surface: 'other_tenant' }),
    ],
  });

  // Written straight into the MV's inner table, bypassing the
  // `property_value != ''` predicate that only applies to rows arriving from
  // `events`. This repo's write path cannot produce an empty value here — row 4
  // above is dropped before fetchSurfaceValues sees it, which is what made the
  // assertion below pass without exercising anything. The service's own filter
  // is defence-in-depth against an upstream schema change or an out-of-band
  // write, and this is the only way to reach that state.
  await ch.insert({
    table: 'openpanel.event_property_values_mv',
    format: 'JSONEachRow',
    values: [
      {
        project_id: PROJECT_A,
        name: 'level_completed',
        property_key: 'embed_surface',
        property_value: '',
        created_at: '2026-07-01 12:00:00',
      },
    ],
  });
});

afterAll(async () => {
  if (chReachable) {
    await cleanup();
  }
  vi.restoreAllMocks();
});

describe('overview-surfaces.service / canExposeShareSurfaces', () => {
  it('exposes surfaces on a public share with no password', () => {
    expect(
      canExposeShareSurfaces({ public: true, password: null }, false),
    ).toBe(true);
  });

  it('refuses a share that is not public', () => {
    expect(
      canExposeShareSurfaces({ public: false, password: null }, true),
    ).toBe(false);
  });

  it('refuses a password-protected share until the password has been entered', () => {
    expect(
      canExposeShareSurfaces({ public: true, password: 'hash' }, false),
    ).toBe(false);
  });

  it('exposes a password-protected share once access is proven', () => {
    expect(canExposeShareSurfaces({ public: true, password: 'hash' }, true)).toBe(
      true,
    );
  });

  it('refuses when there is no share at all', () => {
    expect(canExposeShareSurfaces(null, true)).toBe(false);
  });
});

describe('overview-surfaces.service / fetchSurfaceValues', () => {
  itCH('returns the project\'s free-form values raw, unbucketed', async () => {
    const values = await fetchSurfaceValues(PROJECT_A);
    expect(values.sort()).toEqual(['game_app', 'news_web', 'web']);
  });

  itCH(
    'drops the pre-ADR-0008 empty-string "not set" state even when the MV holds one',
    async () => {
      // Asserts fetchSurfaceValues' own filter, not the MV predicate — see the
      // fixture insert in beforeAll.
      const values = await fetchSurfaceValues(PROJECT_A);
      expect(values).not.toContain('');
    },
  );

  itCH('never returns another project\'s surfaces', async () => {
    const values = await fetchSurfaceValues(PROJECT_A);
    expect(values).not.toContain('other_tenant');

    // ...and the other project only ever sees its own.
    expect(await fetchSurfaceValues(PROJECT_B)).toEqual(['other_tenant']);
  });

  itCH('never returns values of any other property', async () => {
    const values = await fetchSurfaceValues(PROJECT_A);
    expect(values).not.toContain('sudoku');
    expect(values).not.toContain('crossword');
  });

  itCH('returns nothing for a project that emits no surfaces', async () => {
    expect(await fetchSurfaceValues('surface-values-test-nonexistent')).toEqual(
      [],
    );
  });
});
