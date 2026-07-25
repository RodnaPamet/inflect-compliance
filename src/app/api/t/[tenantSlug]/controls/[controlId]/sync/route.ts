import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { runAutomationForControl } from '@/app-layer/usecases/integrations';
import { assertCanReadControls } from '@/app-layer/policies/control.policies';
import { withApiErrorHandling } from '@/lib/errors/api';
import { forbidden } from '@/lib/errors/types';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/[tenantSlug]/controls/[controlId]/sync
 *
 * Manually trigger an automation sync (check) for a control.
 * Requires an active integration connection for the control's provider.
 * Returns the execution result immediately (synchronous for now).
 */
export const POST = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string; controlId: string }> }
) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    if (!ctx.permissions?.canWrite) throw forbidden('Write permission required');

    const result = await runAutomationForControl(ctx, params.controlId, {
        triggeredBy: 'manual',
    });

    return jsonResponse(result);
});

/**
 * GET /api/t/[tenantSlug]/controls/[controlId]/sync
 *
 * Returns the current sync mapping status for this control.
 * Used to drive the conflict badge on the control detail page.
 */
export const GET = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string; controlId: string }> }
) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    assertCanReadControls(ctx);

    const { PrismaSyncMappingStore } = await import('@/app-layer/integrations/prisma-sync-store');
    const { runInTenantContext } = await import('@/lib/db-context');

    // Fetch the control's automationKey to derive the provider
    const control = await runInTenantContext(ctx, async (db) => {

        return db.control.findFirst({
            where: { id: params.controlId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, automationKey: true },
        });
    });

    if (!control?.automationKey) {
        return jsonResponse({ syncStatus: null, provider: null });
    }

    const [provider] = control.automationKey.split('.');
    const store = new PrismaSyncMappingStore();

    const mapping = await store.findByLocalEntity(
        ctx.tenantId,
        provider,
        'control',
        params.controlId,
    );

    return jsonResponse({
        syncStatus: mapping?.syncStatus ?? null,
        lastSyncedAt: mapping?.lastSyncedAt ?? null,
        lastSyncDirection: mapping?.lastSyncDirection ?? null,
        errorMessage: mapping?.errorMessage ?? null,
        provider,
    });
});
