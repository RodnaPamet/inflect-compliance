/**
 * The process canvas as a module a tenant either has or does not.
 *
 * ═══ A MODULE SWITCH IS NOT A PERMISSION ═══
 *
 * Every other surface in this product is offered to every tenant and gated by
 * permission — WHO may use it. This answers a different question: is the
 * surface offered here AT ALL. That is why it is not a role, not a permission
 * and not a plan tier; each of those governs access to something the product
 * provides, and this governs whether it provides it.
 *
 * The practical difference shows up in the refusal. A permission failure says
 * "you may not open this"; a module failure says "this is not part of your
 * product". Telling a reader they lack permission for a surface nobody in their
 * tenant has would send them to an administrator who has nothing to grant.
 *
 * ═══ IT GOVERNS THE SURFACE, NEVER THE ROWS ═══
 *
 * `ProcessNode`, `ProcessEdge` and `ProcessEdgeControl` are untouched by this
 * flag. Coverage, traceability and the audit-pack renderer read those rows
 * directly and keep working with the module off. Turning it off is NOT a
 * delete, and turning it back on must show the same map.
 *
 * If disabling this module ever changes a coverage report, the flag has been
 * wired too deep and that is the bug — not the report.
 *
 * ═══ WHY THE DEFAULT IS OFF ═══
 *
 * Opposite of every other surface, and deliberately. The editor behind this
 * canvas is licensed software: the hobby licence permits a "Development
 * Environment ... not accessible to end users, customers, or the public" and
 * forbids Production use without a paid key. A default of TRUE would make every
 * newly created tenant a licence violation at the moment of creation — a state
 * no default should be able to reach.
 *
 * @module usecases/process-canvas-module
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '../events/audit';
import { logger } from '@/lib/observability/logger';

/**
 * Is the canvas available to this tenant?
 *
 * ABSENT SETTINGS ROW READS AS OFF. A tenant with no `TenantSecuritySettings`
 * row has never been configured, and the safe reading of "never configured" is
 * that nobody turned the module on. The alternative — treating a missing row as
 * enabled — would hand the surface to exactly the tenants nobody has looked at.
 */
export async function isProcessCanvasEnabled(ctx: RequestContext): Promise<boolean> {
    return runInTenantContext(ctx, async (db) => {
        const row = await db.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: { processCanvasEnabled: true },
        });
        return row?.processCanvasEnabled === true;
    });
}

/**
 * Turn the module on or off for this tenant.
 *
 * OWNER-only at the route via `requirePermission('admin.tenant_lifecycle')`,
 * matching `setIdentityWriteMode`. The check is NOT repeated here as a second,
 * weaker gate — that is how a route ends up looking protected while granting.
 *
 * Returns the state that is now stored, so a caller never has to re-read to
 * find out what it did.
 */
export async function setProcessCanvasEnabled(
    ctx: RequestContext,
    next: boolean,
): Promise<{ enabled: boolean; changed: boolean }> {
    const current = await isProcessCanvasEnabled(ctx);

    // A no-op write is not an event. Auditing "changed from off to off" would
    // put rows in front of a reviewer that record nothing happening, and the
    // rows that DO record something get harder to find for it.
    if (current === next) return { enabled: current, changed: false };

    await runInTenantContext(ctx, (db) =>
        db.tenantSecuritySettings.upsert({
            where: { tenantId: ctx.tenantId },
            create: { tenantId: ctx.tenantId, processCanvasEnabled: next },
            update: { processCanvasEnabled: next },
        }),
    );

    await runInTenantContext(ctx, (db) =>
        logEvent(db, ctx, {
            action: 'PROCESS_CANVAS_MODULE_CHANGED',
            entityType: 'Tenant',
            entityId: ctx.tenantId,
            details: `Process canvas module: ${current ? 'on' : 'off'} → ${next ? 'on' : 'off'}`,
            // `configuration`, NOT `access` — and the distinction is worth
            // stating because the identity ladder next door chose the other one.
            // That ladder grants the product authority to write to a customer's
            // directory, so an access-review reader is its audience. This grants
            // nobody any authority: every permission check on the surface is
            // unchanged whether it is on or off. It changes what the product
            // offers, which is a configuration fact.
            detailsJson: {
                category: 'configuration',
                operation: next ? 'enable' : 'disable',
                summary: `Process canvas module ${next ? 'enabled' : 'disabled'}`,
            },
            metadata: { from: current, to: next },
        }),
    );

    logger.info('process canvas module changed', {
        component: 'process-canvas-module',
        tenantId: ctx.tenantId,
        from: current,
        to: next,
    });

    return { enabled: next, changed: true };
}
