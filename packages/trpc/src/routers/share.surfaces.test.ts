/**
 * The authorization boundary around the surface list on `share.overview`
 * (fork-only — see the `surfaces` block in share.ts).
 *
 * `share.overview` is a publicProcedure with no session behind it, so what this
 * handler chooses to answer with is the only thing between a URL and project
 * data. Postgres and ClickHouse are mocked because the share row and the value
 * list are the two inputs to that decision, and mocking them is what lets these
 * tests ask "which project did it look up?". The query itself is covered
 * against real ClickHouse in db/src/services/overview-surfaces.service.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@openpanel/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openpanel/db')>();
  return {
    ...actual,
    db: { shareOverview: { findUnique: vi.fn() } },
    getSurfaceValues: vi.fn(),
  };
});

import { db, getSurfaceValues } from '@openpanel/db';
import { shareRouter } from './share';

const SHARE_ID = 'abc123';
const SHARED_PROJECT = 'daily-mail';
const OTHER_PROJECT = 'wall-street-journal';

const findUnique = db.shareOverview.findUnique as unknown as ReturnType<
  typeof vi.fn
>;
const surfaceLookup = getSurfaceValues as unknown as ReturnType<typeof vi.fn>;

function shareRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SHARE_ID,
    projectId: SHARED_PROJECT,
    organizationId: 'org',
    public: true,
    password: null,
    organization: { name: 'Org' },
    project: { name: 'Daily Mail' },
    ...overrides,
  };
}

// The request logger every procedure gets through ctx. Shared across callers so
// assertions can reach it; reset by `vi.clearAllMocks()` in beforeEach.
const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

function caller(cookies: Record<string, string | undefined> = {}) {
  return shareRouter.createCaller({
    cookies,
    session: null,
    req: { log },
    res: {},
    setCookie: vi.fn(),
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  surfaceLookup.mockResolvedValue(['app', 'web']);
});

describe('share.overview / surfaces', () => {
  it('answers a public share with the surfaces of the share\'s own project', async () => {
    findUnique.mockResolvedValue(shareRow());

    const result = await caller().overview({ shareId: SHARE_ID });

    expect(result?.surfaces).toEqual(['app', 'web']);
    expect(surfaceLookup).toHaveBeenCalledTimes(1);
    // The project the SHARE row points at, not anything the client sent.
    expect(surfaceLookup).toHaveBeenCalledWith(SHARED_PROJECT);
    expect(surfaceLookup).not.toHaveBeenCalledWith(SHARE_ID);
  });

  it('never looks up a project the client named rather than the one on the share row', async () => {
    // The two ids are deliberately DIFFERENT, so this distinguishes a
    // share-derived project from a client-supplied one rather than proving both
    // happen to be the same string.
    //
    // Today a client sending both keys parses into the `{ projectId }` branch
    // (the union's first match strips `shareId`), so the share path is never
    // entered. That stripping is the invariant the safety rests on — hence the
    // findUnique assertion below, which fails loudly if parsed input ever
    // starts carrying both keys.
    findUnique.mockResolvedValue(shareRow({ projectId: SHARED_PROJECT }));

    const result = await caller().overview({
      shareId: SHARE_ID,
      projectId: OTHER_PROJECT,
    } as any);

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: OTHER_PROJECT } }),
    );
    expect(result?.surfaces).toEqual([]);
    expect(surfaceLookup).not.toHaveBeenCalled();
    expect(surfaceLookup).not.toHaveBeenCalledWith(OTHER_PROJECT);
  });

  it('leaks nothing through the logged-in dashboard\'s projectId lookup', async () => {
    // The private overview asks "is this project shared?" on every load. It must
    // not start paying for a ClickHouse query it does not read.
    findUnique.mockResolvedValue(shareRow());

    const result = await caller().overview({ projectId: SHARED_PROJECT });

    expect(result?.surfaces).toEqual([]);
    expect(surfaceLookup).not.toHaveBeenCalled();
  });

  it('withholds surfaces from a share that is not public', async () => {
    findUnique.mockResolvedValue(shareRow({ public: false }));

    const result = await caller().overview({ shareId: SHARE_ID });

    expect(result?.surfaces).toEqual([]);
    expect(surfaceLookup).not.toHaveBeenCalled();
  });

  it('withholds surfaces until a password-protected share has been unlocked', async () => {
    findUnique.mockResolvedValue(shareRow({ password: 'hash' }));

    const result = await caller().overview({ shareId: SHARE_ID });

    expect(result?.hasAccess).toBe(false);
    expect(result?.surfaces).toEqual([]);
    expect(surfaceLookup).not.toHaveBeenCalled();
  });

  it('answers a password-protected share once the access cookie is present', async () => {
    findUnique.mockResolvedValue(shareRow({ password: 'hash' }));

    const result = await caller({
      [`shared-overview-${SHARE_ID}`]: '1',
    }).overview({ shareId: SHARE_ID });

    expect(result?.hasAccess).toBe(true);
    expect(result?.surfaces).toEqual(['app', 'web']);
    expect(surfaceLookup).toHaveBeenCalledWith(SHARED_PROJECT);
  });

  it('throws rather than answering for an unknown shareId', async () => {
    findUnique.mockResolvedValue(null);

    await expect(caller().overview({ shareId: 'nope' })).rejects.toThrow();
    expect(surfaceLookup).not.toHaveBeenCalled();
  });

  it('still answers a usable share when the surface lookup fails', async () => {
    // See share.ts: a rejected loader renders as "Share not found", so an
    // unreachable ClickHouse must cost the picker, not the whole dashboard.
    findUnique.mockResolvedValue(shareRow());
    surfaceLookup.mockRejectedValue(new Error('ClickHouse unreachable'));

    const result = await caller().overview({ shareId: SHARE_ID });

    expect(result?.surfaces).toEqual([]);
    expect(result?.projectId).toBe(SHARED_PROJECT);
    expect(result?.public).toBe(true);
    expect(result?.project).toEqual({ name: 'Daily Mail' });
  });

  it('logs the failure rather than degrading silently', async () => {
    const err = new Error('ClickHouse unreachable');
    findUnique.mockResolvedValue(shareRow());
    surfaceLookup.mockRejectedValue(err);

    await caller().overview({ shareId: SHARE_ID });

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err, projectId: SHARED_PROJECT }),
      expect.any(String),
    );
  });

  it('logs nothing when the surface lookup succeeds', async () => {
    findUnique.mockResolvedValue(shareRow());

    await caller().overview({ shareId: SHARE_ID });

    expect(log.error).not.toHaveBeenCalled();
  });
});
