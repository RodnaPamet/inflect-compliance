import { NextRequest } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { assertCanAdmin } from '@/app-layer/policies/common';
import { runInTenantContext } from '@/lib/db-context';
import {
    getTenantNotificationSettings,
    updateTenantNotificationSettings,
    getOutboxStats,
} from '@/app-layer/notifications/settings';
import { jsonResponse } from '@/lib/api-response';
import { listInAppNotificationTypes } from '@/app-layer/notifications/agentic';
import { UpdateNotificationSettingsSchema } from '@/app-layer/schemas/notification-settings.schemas';

/**
 * The workspace's notification settings — the sender identity, compliance BCC
 * and email switch every workspace email reads, and the in-app mute list.
 *
 * Gated `admin.manage` at the route (#4469), so a refusal writes an
 * AUTHZ_DENIED row; the path sits outside `/api/t/:slug/admin/`, so the edge
 * admin gate never applied. `assertCanAdmin` stays behind it: the two together
 * admit exactly the OWNER and ADMIN memberships the coarse check admitted
 * alone.
 */

/** GET — returns tenant notification settings + outbox stats */
export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (_req: NextRequest, _routeArgs, ctx) => {
        assertCanAdmin(ctx);

        const [settings, stats] = await runInTenantContext(ctx, async (db) => {
            return Promise.all([
                getTenantNotificationSettings(db, ctx.tenantId),
                getOutboxStats(db, ctx.tenantId),
            ]);
        });

        // The in-app type catalogue (#2564), resolved SERVER-side against the
        // emitter's own copy and joined to this tenant's mute list. The client
        // renders whatever this lists, so a future agentic type reaches the
        // preference page without a client-side edit — and a type the emitter
        // stopped sending disappears from it by the same route.
        const inAppTypes = listInAppNotificationTypes().map((info) => ({
            ...info,
            muted: settings.mutedInAppTypes.includes(info.type),
        }));

        return jsonResponse({ settings, stats, inAppTypes });
    }),
);

/** PUT — update tenant notification settings (admin-only) */
export const PUT = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        assertCanAdmin(ctx);

        const input = UpdateNotificationSettingsSchema.parse(await req.json());
        const updated = await runInTenantContext(ctx, (db) =>
            updateTenantNotificationSettings(db, ctx, input),
        );

        return jsonResponse(updated);
    }),
);
