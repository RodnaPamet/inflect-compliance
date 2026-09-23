/**
 * Epic O-2 — tenant creation under an organization.
 *
 * Composes:
 *   1. `prisma.tenant.create` with `organizationId` set + a freshly-
 *      generated DEK (mirrors `createTenantWithDek`).
 *   2. OWNER `TenantMembership` for the creator (the user named on the
 *      OrgContext that authorised the request).
 *   3. `TenantOnboarding` row (matches the platform-admin
 *      `createTenantWithOwner` shape).
 *   4. After the transaction commits — `provisionAllOrgAdminsToTenant`
 *      so every existing ORG_ADMIN of the org gets an ADMIN
 *      membership in the new tenant.
 *
 * The creator's OWNER membership has `provisionedByOrgId = NULL` —
 * it's manually granted, not auto-provisioned. If the creator is later
 * removed as ORG_ADMIN, `deprovisionOrgAdmin` will NOT touch their
 * OWNER row (the predicate requires `provisionedByOrgId === orgId`).
 *
 * The provision call's skipDuplicates ignores the creator's pre-
 * existing OWNER row — it's a no-op for that user. Other ORG_ADMINs
 * get fresh ADMIN rows.
 */

import { Prisma } from '@prisma/client';

import prisma from '@/lib/prisma';
import { generateAndWrapDek } from '@/lib/security/tenant-keys';
import { provisionAllOrgAdminsToTenant } from './org-provisioning';
import { ConflictError, notFound } from '@/lib/errors/types';
import type { OrgContext } from '@/app-layer/types';
import { forbidden } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import { getBillingMode, type Plan } from '@/lib/billing/entitlements';
import { recordTenantDeleted } from '@/lib/observability/business-metrics';

export interface CreateTenantUnderOrgInput {
    name: string;
    slug: string;
}

export interface CreateTenantUnderOrgResult {
    tenant: { id: string; slug: string; name: string };
    /** Number of ORG_ADMINs auto-provisioned into the new tenant. The
     *  creator's OWNER row is excluded (skipped on the unique
     *  constraint), so this count covers the OTHER admins. */
    provisionedAdmins: number;
}

/**
 * Create a tenant linked to the org named on `ctx`.
 *
 * Permission is asserted HERE as well as at the route. This used to say the
 * caller "must have already passed the check at the route layer" — which was
 * true and load-bearing in the wrong direction: it meant a non-HTTP caller
 * created a tenant, provisioned every org admin into it and minted a DEK with
 * no check at all.
 */
export async function createTenantUnderOrg(
    ctx: OrgContext,
    input: CreateTenantUnderOrgInput,
): Promise<CreateTenantUnderOrgResult> {
    assertCanManageOrgTenants(ctx);
    const name = input.name.trim();
    const slug = input.slug.trim().toLowerCase();

    let tenantId = '';
    let tenantName = name;
    let tenantSlug = slug;

    try {
        await prisma.$transaction(async (tx) => {
            const { wrapped } = generateAndWrapDek();
            const tenant = await tx.tenant.create({
                data: {
                    name,
                    slug,
                    organizationId: ctx.organizationId,
                    encryptedDek: wrapped,
                },
                select: { id: true, name: true, slug: true },
            });
            tenantId = tenant.id;
            tenantName = tenant.name;
            tenantSlug = tenant.slug;

            // OWNER membership for the creator. provisionedByOrgId is
            // intentionally NOT set here — this is a manually-granted
            // membership that survives the creator's potential later
            // removal from ORG_ADMIN status.
            await tx.tenantMembership.create({
                data: {
                    tenantId: tenant.id,
                    userId: ctx.userId,
                    role: 'OWNER',
                    status: 'ACTIVE',
                },
            });

            await tx.tenantOnboarding.create({
                data: { tenantId: tenant.id },
            });
        });
    } catch (err) {
        // Translate the Prisma unique-violation on Tenant.slug into a
        // friendlier 409. Other Prisma errors bubble as-is for the API
        // wrapper to render.
        if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2002'
        ) {
            throw new ConflictError(
                `A tenant with slug '${slug}' already exists`,
            );
        }
        throw err;
    }

    // Auto-provision OTHER ORG_ADMINs into the new tenant. The creator
    // already has OWNER (higher than ADMIN) — skipDuplicates skips
    // them. Other admins get ADMIN rows tagged with provisionedByOrgId.
    let provisionedAdmins = 0;
    try {
        const result = await provisionAllOrgAdminsToTenant(
            ctx.organizationId,
            tenantId,
        );
        provisionedAdmins = result.created;
    } catch (err) {
        // Provisioning failure is logged but doesn't roll back the
        // tenant creation — the tenant is real and usable; the missing
        // ADMIN rows can be backfilled by re-running provisioning
        // (it's idempotent). Operator visibility via the structured log.
        logger.warn('org-tenants.provision_after_create_failed', {
            component: 'org-tenants',
            organizationId: ctx.organizationId,
            tenantId,
            requestId: ctx.requestId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    logger.info('org-tenants.created', {
        component: 'org-tenants',
        organizationId: ctx.organizationId,
        tenantId,
        slug: tenantSlug,
        creatorUserId: ctx.userId,
        provisionedAdmins,
        requestId: ctx.requestId,
    });

    return {
        tenant: { id: tenantId, name: tenantName, slug: tenantSlug },
        provisionedAdmins,
    };
}

/**
 * Org-tenant management requires `canManageTenants`.
 *
 * ADDED alongside the route gate, not moved from it. Before this, the check
 * lived ONLY at the route handler, so any non-HTTP caller — a job, a script,
 * the MCP surface — reached `deleteTenantUnderOrg` with no permission check at
 * all. Replacing the route check with `requireOrgPermission` without this
 * would have removed the only check there was: a defence-in-depth regression
 * wearing a refactor's clothes.
 */
function assertCanManageOrgTenants(ctx: OrgContext): void {
    if (!ctx.permissions.canManageTenants) {
        throw forbidden(
            'You do not have permission to manage tenants in this organization',
        );
    }
}

/**
 * Soft-delete ("remove") a tenant from the org admin panel.
 *
 * Sets `Tenant.deletedAt`, which the tenant resolver (getTenantContext →
 * 404), the portfolio + org tenant listings, the tenant picker, and the
 * JWT membership claims all filter on — so the tenant becomes
 * inaccessible immediately, everywhere, while its data is retained for
 * compliance and a possible restore. A hard purge (wiping the tenant's
 * rows) is a separate, deliberate operation and is NOT done here.
 *
 * AND REVOKES THE MEMBERSHIPS, in the same transaction (#2747). The
 * paragraph above was a claim about every CURRENT query, not about the
 * grants themselves: `deletedAt` makes the tenant inaccessible only for
 * as long as every future reader remembers the filter, and in the
 * meantime the rows saying "this user may enter this tenant" survive the
 * whole 90-day retention window — 113 of them, when this was measured.
 * A grant that outlives the thing it grants access to is a finding, not
 * a formality; revoking it at deletion time removes the dependency on
 * everyone else's `WHERE` clause.
 *
 * Revocation is a STATUS change (`DEACTIVATED` + `deactivatedAt`), the
 * same shape `deactivateTenantMember` writes in `tenant-admin.ts` — one
 * seam for "this membership no longer grants access", not two.
 *
 * THERE IS NO RESTORE COUNTERPART, and that is why this is safe to do
 * unconditionally. `restoreEntity` in `soft-delete-operations.ts` covers
 * twelve models and `Tenant` is not one of them; nothing in `src/` or
 * `scripts/` clears `Tenant.deletedAt`. A tenant is un-deleted today by a
 * hand-written UPDATE, and whoever writes it must now reactivate the
 * memberships too. If a real restore path is ever built, it belongs
 * beside this function and it owns that half.
 *
 * Org-scoped: only a tenant that belongs to THIS org (and isn't already
 * removed) can be deleted — a foreign / unknown id is a `notFound`, so
 * an org admin can never reach across into another org's tenant.
 *
 * Permission is asserted HERE as well as at the route. This used to read
 * "the caller MUST have passed the `canManageTenants` check at the route
 * layer", which stopped being true in this diff: the route gate became
 * `requireOrgPermission` so denials are audited, and
 * `assertCanManageOrgTenants` above now covers every non-HTTP caller.
 */
export async function deleteTenantUnderOrg(
    ctx: OrgContext,
    tenantId: string,
): Promise<{ tenant: { id: string; slug: string; name: string } }> {
    assertCanManageOrgTenants(ctx);
    const tenant = await prisma.tenant.findFirst({
        where: {
            id: tenantId,
            organizationId: ctx.organizationId,
            deletedAt: null,
        },
        select: { id: true, slug: true, name: true },
    });
    if (!tenant) {
        throw notFound('Tenant not found in this organization');
    }

    // ONE TRANSACTION, because the half-state is the thing to avoid.
    //
    // A soft-delete that commits while the revocation fails leaves a tenant
    // that every view hides and 113 memberships that still grant access —
    // and `Tenant.deletedAt` is exactly what makes that invisible, because
    // the tenant no longer appears on any surface an admin could use to
    // notice. The reverse order fails safe by comparison (access revoked,
    // tenant still listed), but neither half alone is the operation.
    //
    // THE ORDER INSIDE THE ARRAY IS LOAD-BEARING, and not for style.
    // `$transaction([...])` runs its entries sequentially, and the
    // `tenant_membership_last_owner_guard` trigger raises P0001 on any UPDATE
    // that deactivates a tenant's last ACTIVE OWNER — which is precisely what
    // the second statement does. Migration `20260922200000_last_owner_guard_
    // allows_purge` exempts a tenant whose `deletedAt IS NOT NULL`, so the
    // soft-delete MUST be the statement that has already run when the
    // membership UPDATE fires. Swap these two and every tenant deletion
    // aborts on the trigger — and a unit test with a mocked client stays
    // green, because a mock has no triggers.
    const revokedAt = new Date();
    const [, revoked] = await prisma.$transaction([
        prisma.tenant.update({
            where: { id: tenant.id },
            data: { deletedAt: revokedAt },
        }),
        // REVOKED, NOT ERASED. This usecase's docstring promises the data is
        // "retained for compliance and a possible restore", and "who had
        // access to this tenant, and until when?" is a question an auditor
        // asks about a tenant that has been removed. A `deleteMany` here
        // would answer it with silence.
        //
        // ONLY THE ROWS THAT STILL GRANT ACCESS. `deactivatedAt` is evidence
        // of when access actually ended, so a row already carrying one must
        // keep it — overwriting a months-old revocation with today's date
        // would forge the record. `REMOVED` is excluded for the same reason:
        // it is a terminal state `resolveTenantContext` already refuses, and
        // rewriting it to DEACTIVATED loses which of the two happened.
        // ACTIVE and INVITED are what `src/lib/tenant-context.ts` lets
        // through, so they are exactly the live grants.
        prisma.tenantMembership.updateMany({
            where: { tenantId: tenant.id, status: { in: ['ACTIVE', 'INVITED'] } },
            data: { status: 'DEACTIVATED', deactivatedAt: revokedAt },
        }),
    ]);

    // Resolve plan for the KPI label. Self-hosted is always ENTERPRISE —
    // skip the BillingAccount lookup entirely in that mode.
    let plan: Plan = 'ENTERPRISE';
    if (getBillingMode() === 'SAAS') {
        const acct = await prisma.billingAccount.findUnique({
            where: { tenantId: tenant.id },
            select: { plan: true },
        });
        plan = (acct?.plan ?? 'FREE') as Plan;
    }
    recordTenantDeleted({ plan, reason: 'org_admin_delete' });

    logger.info('org-tenants.deleted', {
        component: 'org-tenants',
        organizationId: ctx.organizationId,
        tenantId: tenant.id,
        slug: tenant.slug,
        deletedByUserId: ctx.userId,
        revokedMemberships: revoked.count,
        requestId: ctx.requestId,
    });

    return { tenant };
}
