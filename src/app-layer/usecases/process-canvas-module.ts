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
    /*
        ONE TRANSACTION, and the explanation this replaces was WRONG (#3175).

        #3172 said, in this file: "the PUT 400'd, and the upsert rolled back with
        it: the module could NEVER be turned on. The UI's 'That change was not
        saved' was telling the exact truth."

        It did not roll back, and the UI was telling the owner the opposite of
        what had happened. `runInTenantContext` IS a `$transaction`
        (`src/lib/db-context.ts`), so TWO calls were TWO transactions and the
        first committed before the second was attempted. Production settles it:
        `TenantSecuritySettings.updatedAt` on the live tenant is
        2026-10-03 23:00:30 — the minute of the 400 — the module has been on ever
        since, and six `ProcessMap` saves followed within two hours. I shipped a
        docblock asserting the safe reading of a bug I had only half diagnosed,
        which is the kind of comment that stops the next reader looking.

        #3172 removed one cause of the audit write failing. It could not remove
        the shape: ANY failure there still flipped the module and reported
        failure. Not hypothetical — `appendAuditEntry` takes a per-tenant
        `pg_advisory_xact_lock` inside its transaction, so concurrent appends for
        one tenant serialise and the last can fail to START, which is the reason
        `AuditOutbox` exists at all.

        So the flag and the row recording it now commit together or not at all.
        The advisory lock is held across the upsert too: one row by primary key,
        which is cheap beside a product that misreports its own state.
    */
    const outcome = await runInTenantContext(ctx, async (db) => {
        /*
            READ INSIDE THE TRANSACTION, not via `isProcessCanvasEnabled`.

            That helper opens its own `runInTenantContext`, so calling it here
            would nest a transaction inside a transaction — but the reason to
            inline is not mechanical. `current` becomes the audit row's
            `fromStatus`, and a value read in an earlier transaction can be stale
            by the time the row claims it: two admins toggling at once would both
            read the same baseline and write two rows describing transitions from
            a state only one of them actually left. The row has to be able to say
            what the database held when it was written.

            The query is a deliberate duplicate of the helper's, which stays as
            the public read used by the surfaces and the route guard.
        */
        const row = await db.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: { processCanvasEnabled: true },
        });
        const current = row?.processCanvasEnabled === true;

        // A no-op write is not an event. Auditing "changed from off to off" would
        // put rows in front of a reviewer that record nothing happening, and the
        // rows that DO record something get harder to find for it.
        if (current === next) return { enabled: current, changed: false, previous: current };

        await db.tenantSecuritySettings.upsert({
            where: { tenantId: ctx.tenantId },
            create: { tenantId: ctx.tenantId, processCanvasEnabled: next },
            update: { processCanvasEnabled: next },
        });

        /*
            `status_change`, and the category is load-bearing (#3170).

            This said `category: 'configuration'`, which `AuditDetailsJsonSchema`
            does not define — its enum is entity_lifecycle | data_lifecycle |
            status_change | relationship | access | custom. So
            `validateAuditDetailsJson` threw `badRequest('Invalid detailsJson
            structure')` and the PUT 400'd on every attempt to enable the module.

            `status_change` rather than widening the enum: this is an off → on
            transition, the schema already carries `fromStatus` / `toStatus` for
            exactly that, and a new category would make every reader of
            `AuditDetailsJson` learn a value describing one call site.

            This explanation sits ABOVE the call rather than inside the object:
            `audit-structured-events` scans a fixed window after `logEvent(` for
            `detailsJson`, and a comment of this length in between put the field
            outside it. The guard is right and the comment was in the wrong place.
        */
        await logEvent(db, ctx, {
            action: 'PROCESS_CANVAS_MODULE_CHANGED',
            entityType: 'Tenant',
            entityId: ctx.tenantId,
            details: `Process canvas module: ${current ? 'on' : 'off'} → ${next ? 'on' : 'off'}`,
            // `status_change`, NOT `access` — and the distinction is worth stating
            // because the identity ladder next door chose the other one. That
            // ladder grants the product authority to write to a customer's
            // directory, so an access-review reader is its audience. This grants
            // nobody any authority: every permission check on the surface is
            // unchanged whether it is on or off. It changes what the product
            // offers, which is a change of state rather than of access.
            detailsJson: {
                category: 'status_change',
                operation: next ? 'enable' : 'disable',
                fromStatus: current ? 'on' : 'off',
                toStatus: next ? 'on' : 'off',
                summary: `Process canvas module ${next ? 'enabled' : 'disabled'}`,
            },
            metadata: { from: current, to: next },
        });

        return { enabled: next, changed: true, previous: current };
    });

    // AFTER the commit, not inside it. A log line emitted from within the
    // transaction claims a change that a later rollback would undo — the same
    // mistake as the 400 above, in the other direction.
    if (outcome.changed) {
        logger.info('process canvas module changed', {
            component: 'process-canvas-module',
            tenantId: ctx.tenantId,
            from: outcome.previous,
            to: outcome.enabled,
        });
    }

    return { enabled: outcome.enabled, changed: outcome.changed };
}
