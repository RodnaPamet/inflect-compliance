import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertCanAdmin } from '@/app-layer/policies/common';
import { runInTenantContext } from '@/lib/db-context';
import {
    getTenantNotificationSettings,
    updateTenantNotificationSettings,
    getOutboxStats,
} from '@/app-layer/notifications/settings';
import { jsonResponse } from '@/lib/api-response';
import { UpdateNotificationSettingsSchema } from '@/app-layer/schemas/notification-settings.schemas';

/** GET — returns tenant notification settings + outbox stats */
export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    assertCanAdmin(ctx);

    const [settings, stats] = await runInTenantContext(ctx, async (db) => {
        return Promise.all([
            getTenantNotificationSettings(db, ctx.tenantId),
            getOutboxStats(db, ctx.tenantId),
        ]);
    });

    return jsonResponse({ settings, stats });
});

/** PUT — update tenant notification settings (admin-only) */
export const PUT = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    assertCanAdmin(ctx);

    const input = UpdateNotificationSettingsSchema.parse(await req.json());
    const updated = await runInTenantContext(ctx, (db) =>
        updateTenantNotificationSettings(db, ctx, input),
    );

    return jsonResponse(updated);
});
