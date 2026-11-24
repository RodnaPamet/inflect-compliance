/**
 * The workspace default language (owner decision 2026-11-24, #5868).
 *
 * `Tenant.defaultLocale` is the language of the text the PRODUCT writes into
 * this workspace's records on its behalf: records a person may then edit, so
 * they cannot be re-worded on read the way a stock notification is (#5929).
 * Today one writer reads it, the NIS2 gap-assessment dispatch, for the titles
 * of the tasks it creates (`gap-assessment-assignment.ts`).
 *
 * It is NOT an interface language. The UI locale stays a per-browser cookie
 * (`inflect_locale`), and nothing here reads or sets it.
 *
 * This file is the column's only writer. It is gated on `admin.manage`, the
 * key the other workspace-wide admin settings take (the security settings,
 * the risk matrix, notifications), at the route by `requirePermission` and
 * again here, so no other caller of the usecase can skip it. A change writes
 * `WORKSPACE_LANGUAGE_CHANGED` with both values; saving the value already
 * stored writes nothing.
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { forbidden, notFound } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { resolveLocale, type Locale } from '@/lib/locale-constants';
import { UpdateWorkspaceLanguageInput } from '../schemas/workspace-language.schemas';

export interface WorkspaceLanguage {
    defaultLocale: Locale;
}

function assertCanManageWorkspaceLanguage(ctx: RequestContext): void {
    if (!ctx.appPermissions.admin.manage) {
        throw forbidden('Only an Admin or Owner can change the workspace language.');
    }
}

/** The stored default language. */
export async function getWorkspaceLanguage(ctx: RequestContext): Promise<WorkspaceLanguage> {
    assertCanManageWorkspaceLanguage(ctx);
    return runInTenantContext(ctx, async (db) => {
        const tenant = await db.tenant.findUnique({
            where: { id: ctx.tenantId },
            select: { defaultLocale: true },
        });
        if (!tenant) throw notFound('Workspace not found');
        return { defaultLocale: resolveLocale(tenant.defaultLocale) };
    });
}

/** Set the default language. Audited when it changes; a no-op when it does not. */
export async function setWorkspaceLanguage(
    ctx: RequestContext,
    input: UpdateWorkspaceLanguageInput,
): Promise<WorkspaceLanguage> {
    assertCanManageWorkspaceLanguage(ctx);
    const next = UpdateWorkspaceLanguageInput.parse(input).defaultLocale;
    return runInTenantContext(ctx, async (db) => {
        const before = await db.tenant.findUnique({
            where: { id: ctx.tenantId },
            select: { defaultLocale: true },
        });
        if (!before) throw notFound('Workspace not found');
        const previous = resolveLocale(before.defaultLocale);
        if (previous === next) return { defaultLocale: next };

        await db.tenant.update({
            where: { id: ctx.tenantId },
            data: { defaultLocale: next },
        });
        await logEvent(db, ctx, {
            action: 'WORKSPACE_LANGUAGE_CHANGED',
            entityType: 'Tenant',
            entityId: ctx.tenantId,
            details: `Workspace language changed from ${previous} to ${next}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Tenant',
                operation: 'updated',
                changedFields: ['defaultLocale'],
                before: { defaultLocale: previous },
                after: { defaultLocale: next },
            },
        });
        return { defaultLocale: next };
    });
}
