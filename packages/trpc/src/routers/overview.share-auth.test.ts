/**
 * `overviewProcedure` must honour `isValid` from validateOverviewShareAccess: a
 * password-protected share without its unlock cookie resolves to
 * `{ isValid: false }` instead of throwing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@openpanel/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openpanel/db')>();
  return {
    ...actual,
    validateOverviewShareAccess: vi.fn(),
    getSettingsForProject: vi.fn(),
  };
});

vi.mock('@openpanel/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openpanel/redis')>();
  return {
    ...actual,
    getRedisCache: () => ({ getJson: async () => null, setJson: vi.fn() }),
  };
});

import { getSettingsForProject, validateOverviewShareAccess } from '@openpanel/db';
import { overviewRouter } from './overview';

const validate = validateOverviewShareAccess as unknown as ReturnType<
  typeof vi.fn
>;
const settings = getSettingsForProject as unknown as ReturnType<typeof vi.fn>;

const REACHED_HANDLER = 'reached the handler';

function caller() {
  return overviewRouter.createCaller({
    cookies: {},
    session: null,
    req: { log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } },
    res: {},
    setCookie: vi.fn(),
  } as any);
}

const input = { projectId: 'p', shareId: 's', range: '30d' as const };

beforeEach(() => {
  vi.clearAllMocks();
  settings.mockRejectedValue(new Error(REACHED_HANDLER));
});

describe('overviewProcedure share access', () => {
  it('rejects a share that validates as not accessible', async () => {
    validate.mockResolvedValue({ isValid: false });

    await expect(caller().gameBreakdown(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(settings).not.toHaveBeenCalled();
  });

  it('lets an accessible share through to the handler', async () => {
    validate.mockResolvedValue({ isValid: true });

    await expect(caller().gameBreakdown(input)).rejects.toThrow(
      REACHED_HANDLER
    );
  });
});
