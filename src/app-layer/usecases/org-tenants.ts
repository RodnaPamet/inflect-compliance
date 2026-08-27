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
 * Create a tenant linked to the org named on `ctx`. The caller must
 * have already passed the `canManageTenants` permission check at the
 * route layer.
 */
export async function createTenantUnderOrg(
    ctx: OrgContext,
    input: CreateTenantUnderOrgInput,
): Promise<CreateTenantUnderOrgResult> {
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
 * Soft-delete ("remove") a tenant from the org admin panel.
 *
 * Sets `Tenant.deletedAt`, which the tenant resolver (getTenantContext →
 * 404), the portfolio + org tenant listings, the tenant picker, and the
 * JWT membership claims all filter on — so the tenant becomes
 * inaccessible immediately, everywhere, while its data is retained for
 * compliance and a possible restore. A hard purge (wiping the tenant's
 * rows) is a separate, deliberate operation and is NOT done here.
 *
 * Org-scoped: only a tenant that belongs to THIS org (and isn't already
 * removed) can be deleted — a foreign / unknown id is a `notFound`, so
 * an org admin can never reach across into another org's tenant.
 *
 * The caller MUST have passed the `canManageTenants` permission check at
 * the route layer.
 */
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
            'You do not have permission to remove tenants from this organization',
        );
    }
}

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

    await prisma.tenant.update({
        where: { id: tenant.id },
        data: { deletedAt: new Date() },
    });

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
        requestId: ctx.requestId,
    });

    return { tenant };
}
