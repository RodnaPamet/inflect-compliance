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
 * Opposite of every other surface, and deliberately — though NOT for the reason
 * this paragraph used to give.
 *
 * It said the editor's licence "forbids Production use without a paid key".
 * That is the tldraw 4.x/5.x licence, and it was written here while those terms
 * were believed to be tldraw's only ones. #2988 pinned **3.15.6**, whose licence
 * permits "use the Software in your commercial or non-commercial projects"
 * provided the watermark is not removed, and needs no key (#2958). So a tenant
 * with this module ON is not a licence violation, and describing it as one
 * would have someone treating a product decision as a compliance emergency.
 *
 * The default stays OFF for the reasons that survive:
 *
 *   - a module nobody asked for should not appear in a tenant's product;
 *   - the surface is mid-migration (#2963), so "on" means different things to
 *     different tenants until Phase 4 lands;
 *   - and the bundle argument, which is the load-bearing one —
 *     `tests/guards/canvas-editor-stays-inside-its-module.test.ts` keeps the
 *     editor inside this route segment so a tenant with the module off never
 *     downloads it. A default of TRUE would make that control moot on day one.
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

/**
 * Which renderer draws this tenant's canvas (#2960).
 *
 * ABSENT SETTINGS ROW READS AS xyflow, for the same reason the module reads as
 * off: a tenant nobody has configured has not been migrated, and the safe
 * reading of "never configured" is the renderer that is finished.
 *
 * INDEPENDENT OF `isProcessCanvasEnabled`. This answers WHICH renderer, not
 * WHETHER there is a canvas — a tenant may hold `true` here with the module
 * off, which renders nothing and is harmless. Coupling them would force an
 * ordering on two settings that do not depend on each other, and would make
 * "migrate this tenant" a two-step dance with a wrong intermediate state.
 */
export async function isProcessCanvasTldrawEnabled(ctx: RequestContext): Promise<boolean> {
    return runInTenantContext(ctx, async (db) => {
        const row = await db.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: { processCanvasUsesTldraw: true },
        });
        return row?.processCanvasUsesTldraw === true;
    });
}

/**
 * Move this tenant between renderers.
 *
 * OWNER-only at the route via `requirePermission('admin.tenant_lifecycle')`,
 * matching the module toggle beside it. The check is NOT repeated here — a
 * second, weaker gate is how a route ends up looking protected while granting.
 *
 * NOTHING IS MIGRATED BY THIS CALL, and that is the point. Both renderers read
 * the same `ProcessNode` / `ProcessEdge` rows, so switching is a rendering
 * decision with no data step and no irreversible half-state. Moving a tenant
 * back is the same call with `false`.
 */
export async function setProcessCanvasTldraw(
    ctx: RequestContext,
    next: boolean,
): Promise<{ usesTldraw: boolean; changed: boolean }> {
    const current = await isProcessCanvasTldrawEnabled(ctx);

    // A no-op write is not an event — same reasoning as the module toggle.
    if (current === next) return { usesTldraw: current, changed: false };

    await runInTenantContext(ctx, (db) =>
        db.tenantSecuritySettings.upsert({
            where: { tenantId: ctx.tenantId },
            create: { tenantId: ctx.tenantId, processCanvasUsesTldraw: next },
            update: { processCanvasUsesTldraw: next },
        }),
    );

    await runInTenantContext(ctx, (db) =>
        logEvent(db, ctx, {
            action: 'PROCESS_CANVAS_RENDERER_CHANGED',
            entityType: 'Tenant',
            entityId: ctx.tenantId,
            details: `Process canvas renderer: ${current ? 'tldraw' : 'xyflow'} → ${next ? 'tldraw' : 'xyflow'}`,
            // `configuration`, matching the module toggle: this grants nobody
            // any authority and changes no permission check. It changes what
            // the product draws.
            detailsJson: {
                category: 'configuration',
                operation: next ? 'enable' : 'disable',
                summary: `Process canvas renderer set to ${next ? 'tldraw' : 'xyflow'}`,
            },
            metadata: { from: current, to: next },
        }),
    );

    logger.info('process canvas renderer changed', {
        component: 'process-canvas-module',
        tenantId: ctx.tenantId,
        from: current ? 'tldraw' : 'xyflow',
        to: next ? 'tldraw' : 'xyflow',
    });

    return { usesTldraw: next, changed: true };
}
