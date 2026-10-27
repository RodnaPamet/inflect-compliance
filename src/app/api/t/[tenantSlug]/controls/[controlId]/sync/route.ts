

import { runAutomationForControl } from '@/app-layer/usecases/integrations';

import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/[tenantSlug]/controls/[controlId]/sync
 *
 * Manually trigger an automation sync (check) for a control.
 * Requires an active integration connection for the control's provider.
 * Returns the execution result immediately (synchronous for now).
 */
/**
 * Gated on `controls.edit` (#4387, owner decision 2026-10-27).
 *
 * The gate here was an INLINE `if (!ctx.permissions?.canWrite) throw
 * forbidden('Write permission required')` — the coarse tier, not even a policy
 * function — and no route-level `requirePermission`, so a refusal wrote no
 * `AUTHZ_DENIED` row. A manual sync re-checks a control and writes its
 * execution result, so `controls.edit` is the key, matching every other write
 * on this control. This IS a tightening: a write-tier custom role without
 * `controls.edit` could trigger a sync before and cannot now.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; controlId: string }>(
        'controls.edit',
        async (_req, { params }, ctx) => {
            const result = await runAutomationForControl(ctx, params.controlId, {
                triggeredBy: 'manual',
            });
            return jsonResponse(result);
        },
    ),
);

/**
 * GET /api/t/[tenantSlug]/controls/[controlId]/sync
 *
 * Returns the current sync mapping status for this control.
 * Used to drive the conflict badge on the control detail page.
 */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; controlId: string }>('controls.view', async (_req, { params }, ctx) => {
    // Mirrors the `assertCanReadControls(ctx)` this handler already made, which
    // reads `canRead` + `controls.view`. Same key, so no role moves; the
    // refusal is simply audited now (#4387).

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
}),
);
