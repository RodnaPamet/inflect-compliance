/**
 * The joiner's entitlement map — the WRITE half (#2839).
 *
 * ── WHY THIS FILE DID NOT EXIST ─────────────────────────────────────────────
 *
 * #2713 gave the map a schema and a reader. `identity-joiner-run` does one
 * `findMany` against `IdentityDepartmentGroupRule`, and that was the ONLY
 * reference to the table in `src/`. No usecase created, updated or deleted a
 * rule; `updateTenantSecurityConfig`'s patch type listed neither default-group
 * field. So no tenant could configure either half, every joiner plan refused
 * `NO_DEPARTMENT_MAP`, and `wouldCreate` was structurally 0 — while five
 * docblocks said an operator could clear that refusal. #2864 corrected the
 * prose and pinned it; this is the half the prose was describing.
 *
 * ── WHAT THE READER REQUIRES OF THIS WRITER ─────────────────────────────────
 *
 * Read `identity-joiner-run.ts` before changing anything here. Three of its
 * choices constrain this file:
 *
 *   · DEPARTMENT IS MATCHED EXACTLY. The schema says so and means it: "a rule
 *     that silently matched a department the operator did not type is the same
 *     failure decision 5 guards against on the fallback side." So this writer
 *     does not normalise case, strip punctuation, or fold whitespace — it
 *     stores what was typed. It DOES reject a department that is empty or only
 *     whitespace, which is not normalisation: an all-space department can
 *     never match an HRIS value, so accepting it would write a rule that
 *     cannot fire and reads as configured.
 *
 *   · AN EMPTY MAP IS NULL, NOT `{}`. The reader turns zero rows into `null`
 *     deliberately. Nothing here needs to do anything about that — deleting
 *     the last rule simply restores the refusal — but it is why removing a
 *     rule is a real operation rather than a tidy-up.
 *
 *   · THE FALLBACK'S NAME IS LOAD-BEARING. Owner decision 5: a plan that fell
 *     back reports the fallback BY NAME so an operator can tell "Contractors,
 *     deliberately" from "Enginering, misspelt". The name is STORED rather
 *     than resolved at display time, because a directory lookup is absent
 *     exactly when the directory call failed — which is when it is most read.
 *     So `setDefaultJoinerGroup` takes BOTH or NEITHER. An id without a name
 *     is refused rather than stored with a placeholder.
 *
 * ── WHY EVERY WRITE HERE IS AUDITED AS `access` ─────────────────────────────
 *
 * A department→group rule decides which security group a new joiner lands in.
 * Editing one is not a preference change, it is a decision about what access a
 * future employee receives, and the audience for it is an access-review
 * reader. `setIdentityWriteMode` classifies its own writes the same way and
 * for the same reason.
 *
 * @module usecases/identity-entitlement-map
 */
import { badRequest } from '@/lib/errors/types';
import { logEvent } from '@/app-layer/events/audit';
import { runInTenantContext } from '@/lib/db-context';
import type { RequestContext } from '../types';

/** One configured department→group rule, as an operator sees it. */
export interface DepartmentGroupRule {
    readonly department: string;
    readonly groupId: string;
    readonly groupName: string | null;
    readonly updatedAt: Date;
}

/**
 * Reject a department that cannot ever match, WITHOUT normalising one that can.
 *
 * The distinction matters: trimming `" Engineering "` to `"Engineering"` would
 * be normalisation, and the reader matches exactly, so the stored value must be
 * what the operator meant to type. Refusing `"   "` is not — no HRIS
 * department is whitespace, so such a rule is unfireable by construction and
 * storing it produces a map that looks configured and matches nothing.
 */
function assertUsableDepartment(department: string): void {
    if (department.trim() === '') {
        throw badRequest(
            'Department cannot be empty. The joiner matches the HRIS department value exactly, ' +
                'so a blank rule could never fire — and a map that looks configured but matches ' +
                'nothing is the state this table exists to make visible.',
        );
    }
}

function assertUsableGroupId(groupId: string): void {
    if (groupId.trim() === '') {
        throw badRequest(
            'Group is required. The joiner resolves the security group by this identifier — an ' +
                'Entra object GUID or an AD group DN — and a rule without one names no group to ' +
                'add anybody to.',
        );
    }
}

/** Every rule this tenant has configured, for the admin surface. */
export async function listDepartmentGroupRules(
    ctx: RequestContext,
): Promise<readonly DepartmentGroupRule[]> {
    const rows = await runInTenantContext(ctx, (db) =>
        db.identityDepartmentGroupRule.findMany({
            where: { tenantId: ctx.tenantId },
            select: { department: true, groupId: true, groupName: true, updatedAt: true },
            orderBy: { department: 'asc' },
        }),
    );
    return rows.map((r) => ({
        department: r.department,
        groupId: r.groupId,
        groupName: r.groupName,
        updatedAt: r.updatedAt,
    }));
}

/**
 * Create or replace the rule for one department.
 *
 * An UPSERT, because `@@unique([tenantId, department])` makes two rules for one
 * department a contradiction rather than a tie to break — the schema says so.
 * An operator editing a department's group is expressing the same intent as one
 * creating it, and making them delete first would leave a window where the
 * department falls through to the default group without anybody asking for it.
 */
export async function setDepartmentGroupRule(
    ctx: RequestContext,
    input: { department: string; groupId: string; groupName?: string | null },
): Promise<DepartmentGroupRule> {
    assertUsableDepartment(input.department);
    assertUsableGroupId(input.groupId);

    const previous = await runInTenantContext(ctx, (db) =>
        db.identityDepartmentGroupRule.findUnique({
            where: { tenantId_department: { tenantId: ctx.tenantId, department: input.department } },
            select: { groupId: true },
        }),
    );

    const row = await runInTenantContext(ctx, (db) =>
        db.identityDepartmentGroupRule.upsert({
            where: { tenantId_department: { tenantId: ctx.tenantId, department: input.department } },
            create: {
                tenantId: ctx.tenantId,
                department: input.department,
                groupId: input.groupId,
                groupName: input.groupName ?? null,
                // Provenance. Null when a system path wrote the row; a real id
                // whenever a person did, which is every call through this
                // usecase today.
                createdByUserId: ctx.userId ?? null,
            },
            update: { groupId: input.groupId, groupName: input.groupName ?? null },
            select: { department: true, groupId: true, groupName: true, updatedAt: true },
        }),
    );

    await runInTenantContext(ctx, (db) =>
        logEvent(db, ctx, {
            action: 'IDENTITY_ENTITLEMENT_RULE_SET',
            entityType: 'Tenant',
            entityId: ctx.tenantId,
            details: previous
                ? `Joiner entitlement rule for ${input.department}: ${previous.groupId} → ${input.groupId}`
                : `Joiner entitlement rule added for ${input.department} → ${input.groupId}`,
            detailsJson: {
                // `access`, not `configuration` — see the module docblock. This
                // decides what a future joiner is granted.
                category: 'access',
                operation: 'grant',
                summary: `Joiner entitlement rule for ${input.department}`,
                department: input.department,
                groupId: input.groupId,
                previousGroupId: previous?.groupId ?? null,
            },
        }),
    );

    return {
        department: row.department,
        groupId: row.groupId,
        groupName: row.groupName,
        updatedAt: row.updatedAt,
    };
}

/**
 * Remove one department's rule.
 *
 * Deleting the LAST rule restores `NO_DEPARTMENT_MAP` for the whole tenant,
 * because the reader turns zero rows into `null`. That is correct and is not
 * softened here: a tenant with no rules has no map, and the planner refusing is
 * the honest outcome. The audit line says which it was, so the effect is not a
 * surprise read off a joiner report days later.
 */
export async function removeDepartmentGroupRule(
    ctx: RequestContext,
    department: string,
): Promise<void> {
    const existing = await runInTenantContext(ctx, (db) =>
        db.identityDepartmentGroupRule.findUnique({
            where: { tenantId_department: { tenantId: ctx.tenantId, department } },
            select: { groupId: true },
        }),
    );
    if (!existing) {
        throw badRequest(`No joiner entitlement rule is configured for ${department}.`);
    }

    await runInTenantContext(ctx, (db) =>
        db.identityDepartmentGroupRule.delete({
            where: { tenantId_department: { tenantId: ctx.tenantId, department } },
        }),
    );

    const remaining = await runInTenantContext(ctx, (db) =>
        db.identityDepartmentGroupRule.count({ where: { tenantId: ctx.tenantId } }),
    );

    await runInTenantContext(ctx, (db) =>
        logEvent(db, ctx, {
            action: 'IDENTITY_ENTITLEMENT_RULE_REMOVED',
            entityType: 'Tenant',
            entityId: ctx.tenantId,
            details:
                remaining === 0
                    ? `Joiner entitlement rule removed for ${department}. This was the LAST rule — the joiner now refuses NO_DEPARTMENT_MAP for this tenant.`
                    : `Joiner entitlement rule removed for ${department} (was ${existing.groupId}).`,
            detailsJson: {
                category: 'access',
                operation: 'revoke',
                summary: `Joiner entitlement rule removed for ${department}`,
                department,
                previousGroupId: existing.groupId,
                rulesRemaining: remaining,
            },
        }),
    );
}

/**
 * Set or clear the singular fallback group.
 *
 * BOTH FIELDS OR NEITHER, and that is owner decision 5 rather than tidiness.
 * The name is what lets a plan that fell back be read as "Contractors,
 * deliberately" instead of "Enginering, misspelt", and it is stored rather than
 * resolved because a directory lookup is absent exactly when the directory call
 * failed. An id with no name would produce a report naming a group nobody can
 * identify at the moment they most need to.
 *
 * `null` clears both, which restores `NO_DEFAULT_GROUP`.
 */
export async function setDefaultJoinerGroup(
    ctx: RequestContext,
    next: { groupId: string; groupName: string } | null,
): Promise<void> {
    if (next) {
        assertUsableGroupId(next.groupId);
        if (next.groupName.trim() === '') {
            throw badRequest(
                'A fallback group needs its display name as well as its id. A plan that falls back ' +
                    'reports the group BY NAME so an operator can tell a deliberate catch-all from a ' +
                    'misspelt department — and the name is stored rather than looked up because the ' +
                    'lookup is unavailable exactly when the directory call failed.',
            );
        }
    }

    const before = await runInTenantContext(ctx, (db) =>
        db.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: { identityDefaultGroupId: true, identityDefaultGroupName: true },
        }),
    );

    await runInTenantContext(ctx, (db) =>
        db.tenantSecuritySettings.upsert({
            where: { tenantId: ctx.tenantId },
            create: {
                tenantId: ctx.tenantId,
                identityDefaultGroupId: next?.groupId ?? null,
                identityDefaultGroupName: next?.groupName ?? null,
            },
            update: {
                identityDefaultGroupId: next?.groupId ?? null,
                identityDefaultGroupName: next?.groupName ?? null,
            },
        }),
    );

    await runInTenantContext(ctx, (db) =>
        logEvent(db, ctx, {
            action: 'IDENTITY_DEFAULT_GROUP_SET',
            entityType: 'Tenant',
            entityId: ctx.tenantId,
            details: next
                ? `Joiner fallback group set to ${next.groupName} (${next.groupId})`
                : 'Joiner fallback group cleared — the joiner now refuses NO_DEFAULT_GROUP for unmapped departments.',
            detailsJson: {
                category: 'access',
                operation: next ? 'grant' : 'revoke',
                summary: next ? `Joiner fallback group: ${next.groupName}` : 'Joiner fallback group cleared',
                groupId: next?.groupId ?? null,
                groupName: next?.groupName ?? null,
                previousGroupId: before?.identityDefaultGroupId ?? null,
            },
        }),
    );
}
