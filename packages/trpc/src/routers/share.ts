import ShortUniqueId from 'short-unique-id';

import {
  canExposeShareSurfaces,
  db,
  getDashboardById,
  getReportById,
  getReportsByDashboardId,
  getShareDashboardById,
  getShareReportById,
  getSurfaceValues,
  transformReport,
} from '@openpanel/db';
import {
  zShareDashboard,
  zShareOverview,
  zShareReport,
} from '@openpanel/validation';

import { hashPassword } from '@openpanel/auth';
import { z } from 'zod';
import { getProjectAccess } from '../access';
import {
  TRPCAccessError,
  TRPCForbiddenError,
  TRPCNotFoundError,
} from '../errors';
import { createTRPCRouter, protectedProcedure, publicProcedure } from '../trpc';

const uid = new ShortUniqueId({ length: 6 });

export const shareRouter = createTRPCRouter({
  overview: publicProcedure
    .input(
      z
        .object({
          projectId: z.string(),
        })
        .or(
          z.object({
            shareId: z.string(),
          }),
        ),
    )
    .query(async ({ input, ctx }) => {
      const share = await db.shareOverview.findUnique({
        include: {
          organization: {
            select: {
              name: true,
            },
          },
          project: {
            select: {
              name: true,
            },
          },
        },
        where:
          'projectId' in input
            ? {
                projectId: input.projectId,
              }
            : {
                id: input.shareId,
              },
      });

      if (!share) {
        // Throw error if shareId is provided, otherwise return null
        if ('shareId' in input) {
          throw new TRPCNotFoundError('Share not found');
        }

        return null;
      }

      const hasAccess = !!ctx.cookies[`shared-overview-${share?.id}`];

      // fork: the surface picker's option list, folded into the response the
      // shared overview's route loader already awaits — zero extra round-trips.
      // Only the shareId branch resolves it; the `projectId` branch is the
      // logged-in dashboard's "is this shared?" check, which reads surfaces
      // from `chart.values` and must not pay for a query it does not use. The
      // project comes from the share row, never from input.
      //
      // It must never fail the response: this is the only ClickHouse dependency
      // in an otherwise Postgres-only page shell, and the shared route renders
      // a rejected loader as "Share not found". Degrade to [] — but log it, or
      // an unreachable ClickHouse looks identical to a project with no surfaces.
      const surfaces =
        'shareId' in input && canExposeShareSurfaces(share, hasAccess)
          ? await getSurfaceValues(share.projectId).catch((error) => {
              ctx.req.log.error(
                { err: error, shareId: share.id, projectId: share.projectId },
                'Failed to resolve share surfaces, degrading to none',
              );
              return [];
            })
          : [];

      return {
        ...share,
        hasAccess,
        surfaces,
      };
    }),
  createOverview: protectedProcedure
    .input(zShareOverview)
    .mutation(async ({ input }) => {
      const passwordHash = input.password
        ? await hashPassword(input.password)
        : null;

      return db.shareOverview.upsert({
        where: {
          projectId: input.projectId,
        },
        create: {
          id: uid.rnd(),
          organizationId: input.organizationId,
          projectId: input.projectId,
          public: input.public,
          password: passwordHash,
        },
        update: {
          public: input.public,
          password: passwordHash,
        },
      });
    }),

  // Dashboard sharing
  dashboard: publicProcedure
    .input(
      z
        .object({
          dashboardId: z.string(),
        })
        .or(
          z.object({
            shareId: z.string(),
          }),
        ),
    )
    .query(async ({ input, ctx }) => {
      const share = await db.shareDashboard.findUnique({
        include: {
          organization: {
            select: {
              name: true,
            },
          },
          project: {
            select: {
              name: true,
            },
          },
          dashboard: {
            select: {
              name: true,
            },
          },
        },
        where:
          'dashboardId' in input
            ? {
                dashboardId: input.dashboardId,
              }
            : {
                id: input.shareId,
              },
      });

      if (!share) {
        if ('shareId' in input) {
          throw new TRPCNotFoundError('Dashboard share not found');
        }
        return null;
      }

      return {
        ...share,
        hasAccess: !!ctx.cookies[`shared-dashboard-${share?.id}`],
      };
    }),

  createDashboard: protectedProcedure
    .input(zShareDashboard)
    .mutation(async ({ input, ctx }) => {
      const access = await getProjectAccess({
        projectId: input.projectId,
        userId: ctx.session.userId,
      });

      if (!access) {
        throw new TRPCForbiddenError('You do not have access to this project');
      }

      const dashboard = await getDashboardById(
        input.dashboardId,
        input.projectId,
      );
      if (!dashboard) {
        throw new TRPCNotFoundError('Dashboard not found');
      }

      const passwordHash = input.password
        ? await hashPassword(input.password)
        : null;

      return db.shareDashboard.upsert({
        where: {
          dashboardId: input.dashboardId,
        },
        create: {
          id: uid.rnd(),
          organizationId: input.organizationId,
          projectId: input.projectId,
          dashboardId: input.dashboardId,
          public: input.public,
          password: passwordHash,
        },
        update: {
          public: input.public,
          password: passwordHash,
        },
      });
    }),

  dashboardReports: publicProcedure
    .input(
      z.object({
        shareId: z.string(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const share = await getShareDashboardById(input.shareId);

      if (!share || !share.public) {
        throw new TRPCNotFoundError('Dashboard share not found');
      }

      // Check password access
      const hasAccess = !!ctx.cookies[`shared-dashboard-${share.id}`];
      if (share.password && !hasAccess) {
        throw new TRPCAccessError('Password required');
      }

      return getReportsByDashboardId(share.dashboardId);
    }),

  // Report sharing
  report: publicProcedure
    .input(
      z
        .object({
          reportId: z.string(),
        })
        .or(
          z.object({
            shareId: z.string(),
          }),
        ),
    )
    .query(async ({ input, ctx }) => {
      const share = await db.shareReport.findUnique({
        include: {
          organization: {
            select: {
              name: true,
            },
          },
          project: {
            select: {
              name: true,
            },
          },
          report: true,
        },
        where:
          'reportId' in input
            ? {
                reportId: input.reportId,
              }
            : {
                id: input.shareId,
              },
      });

      if (!share) {
        if ('shareId' in input) {
          throw new TRPCNotFoundError('Report share not found');
        }
        return null;
      }

      return {
        ...share,
        hasAccess: !!ctx.cookies[`shared-report-${share?.id}`],
        report: transformReport(share.report),
      };
    }),

  createReport: protectedProcedure
    .input(zShareReport)
    .mutation(async ({ input, ctx }) => {
      const access = await getProjectAccess({
        projectId: input.projectId,
        userId: ctx.session.userId,
      });

      if (!access) {
        throw new TRPCForbiddenError('You do not have access to this project');
      }

      const report = await getReportById(input.reportId);
      if (!report || report.projectId !== input.projectId) {
        throw new TRPCNotFoundError('Report not found');
      }

      const passwordHash = input.password
        ? await hashPassword(input.password)
        : null;

      return db.shareReport.upsert({
        where: {
          reportId: input.reportId,
        },
        create: {
          id: uid.rnd(),
          organizationId: input.organizationId,
          projectId: input.projectId,
          reportId: input.reportId,
          public: input.public,
          password: passwordHash,
        },
        update: {
          public: input.public,
          password: passwordHash,
        },
      });
    }),
});
