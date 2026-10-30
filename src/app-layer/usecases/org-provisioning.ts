/**
 * Hub-and-spoke organization auto-provisioning engine (Epic O-2).
 *
 * An ORG_ADMIN inherits full tenant ADMIN on every child tenant of the
 * org (changed from the original read-only AUDITOR — an org admin is a
 * customer administrator who operates their tenants, not just audits
 * them). Three lifecycle entry points keep that relationship coherent:
 *
 *   1. `provisionOrgAdminToTenants(orgId, userId)`
 *      Fan-out on ORG_ADMIN add. For every tenant in the org, create
 *      an ADMIN `TenantMembership` tagged with `provisionedByOrgId`.
 *
 *   2. `provisionAllOrgAdminsToTenant(orgId, tenantId)`
 *      Fan-out on tenant add. For every existing ORG_ADMIN of the
 *      org, create the same ADMIN membership in the new tenant.
 *
 *   3. `deprovisionOrgAdmin(orgId, userId)`
 *      Fan-in on ORG_ADMIN remove. Delete ONLY rows tagged with this
 *      org's id (and whose role is ADMIN — defence-in-depth). Manual
 *      memberships (provisionedByOrgId = NULL) and rows from a
 *      different org survive untouched.
 *
 * ## Idempotency
 *
 * Both fan-out functions use `createMany({ skipDuplicates: true })`.
 * The unique constraint that drives the conflict is the existing
 * `@@unique([tenantId, userId])` on TenantMembership. Skipping on
 * conflict means:
 *   - Re-running the fan-out is a no-op.
 *   - A pre-existing manual ADMIN/EDITOR/READER row is preserved
 *     (never overwritten with ADMIN).
 *   - A pre-existing auto-provisioned row from this same org is left
 *     in place.
 *
 * Deprovision uses `deleteMany` — naturally idempotent (zero rows
 * matching the predicate is a successful no-op).
 *
 * ## Why no RLS bypass
 *
 * These functions cross tenant boundaries (one ORG_ADMIN add fans out
 * to N tenants). They run on the global Prisma client, which Postgres
 * sees as the `postgres` role. The `superuser_bypass` policy on
 * `TenantMembership` (`USING (current_setting('role') != 'app_user')`)
 * fires here and grants access — that's the legitimate privileged
 * path. RLS is not turned off; the role just isn't `app_user`. Same
 * pattern as `tenant-invites.ts:redeemInvite`.
 *
 * ## Why no audit emission inside the service
 *
 * Audit attribution requires a `tenantId` and a request context, but
 * these operations are inherently cross-tenant and are usually
 * triggered from an org-level API route. The caller (which owns the
 * org-level `OrgContext`) is the right place to emit a single org-
 * level audit event summarising the fan-out, plus optional per-tenant
 * audit rows if desired. The service returns rich result metadata so
 * the caller has everything it needs.
 *
 * ## Allowlist
 *
 * This file is the seventh allowlisted membership-creation site.
 * Registered in `tests/guardrails/no-auto-join.test.ts` so a future
 * "where does this membership row come from?" audit reads exactly
 * this file.
 */

import { Prisma, Role } from '@prisma/client';

import prisma from '@/lib/prisma';
import { ORG_ADMIN_TIER_ROLES } from '@/lib/org-roles';

/**
 * Helpers accept either the global Prisma client or an in-flight
 * `$transaction` callback's tx client. This lets the role-change
 * usecase wrap the OrgMembership update + the fan-out/fan-in in a
 * single atomic transaction without duplicating the provisioning
 * SQL inside the usecase.
 *
 * The default — the global client — preserves every existing call
 * site (addOrgMember, removeOrgMember, createTenantUnderOrg) which
 * is happy with helper-internal atomicity.
 */
type DbClient = Prisma.TransactionClient | typeof prisma;

// ── Result types ──────────────────────────────────────────────────────

export interface ProvisionResult {
    /** Number of NEW TenantMembership rows actually inserted. */
    created: number;
    /**
     * Number of (tenantId, userId) pairs that already had a membership
     * and were skipped via the unique-constraint conflict. Sum of
     * `created + skipped` is `totalConsidered`.
     */
    skipped: number;
    /** Total number of (tenantId, userId) pairs the call considered. */
    totalConsidered: number;
    /**
     * Tenant ids where a new ADMIN row was created. Caller fans an
     * audit-event row out to each tenant in this list. A tenant whose
     * membership pre-existed is intentionally omitted — its access
     * did not change as a result of this call, and an audit row there
     * would mislead a tenant auditor about when access was granted.
     */
    tenantIds: string[];
}

export interface DeprovisionResult {
    /** Number of auto-provisioned memberships actually deleted. */
    deleted: number;
    /**
     * Tenant ids the user was deprovisioned from. The caller can use
     * this to emit per-tenant audit rows or trigger downstream
     * notifications. Empty when no rows matched.
     */
    tenantIds: string[];
}

// ── Provision: fan-out ON ORG_ADMIN ADD ───────────────────────────────

/**
 * Provision an ORG_ADMIN into every tenant under `orgId`.
 *
 * Caller is responsible for verifying that:
 *   - the user already holds an `OrgMembership(role=ORG_ADMIN)` for
 *     this org (or is about to — this function does not enforce that
 *     pre-condition, on purpose, so callers can sequence the inserts
 *     in their preferred order).
 *
 * Idempotent + safe under retries. Re-running with no schema state
 * change yields the same final state and reports `created=0,
 * skipped=N, totalConsidered=N`.
 */
export async function provisionOrgAdminToTenants(
    orgId: string,
    userId: string,
    db: DbClient = prisma,
): Promise<ProvisionResult> {
    const tenants = await db.tenant.findMany({
        where: { organizationId: orgId },
        select: { id: true },
    });
    if (tenants.length === 0) {
        return { created: 0, skipped: 0, totalConsidered: 0, tenantIds: [] };
    }

    // Pre-query existing memberships so we can return the precise
    // `tenantIds` set of newly-created rows. `createMany skipDuplicates`
    // alone returns only a `count`, which is insufficient for the
    // audit fan-out — the caller needs to know exactly which tenants
    // gained access as a result of this call.
    const existing = await db.tenantMembership.findMany({
        where: { userId, tenantId: { in: tenants.map((t) => t.id) } },
        select: { tenantId: true },
    });
    const existingSet = new Set(existing.map((e) => e.tenantId));
    const toCreate = tenants.filter((t) => !existingSet.has(t.id));

    if (toCreate.length === 0) {
        return {
            created: 0,
            skipped: tenants.length,
            totalConsidered: tenants.length,
            tenantIds: [],
        };
    }

    // skipDuplicates kept on as a race safety net — if a concurrent
    // process inserted a row between our findMany and createMany, the
    // unique constraint catches it without aborting the rest of the
    // batch. The audit row in that race case still truthfully records
    // the org-level intent at this timestamp.
    await db.tenantMembership.createMany({
        data: toCreate.map((t) => ({
            tenantId: t.id,
            userId,
            role: Role.ADMIN,
            provisionedByOrgId: orgId,
        })),
        skipDuplicates: true,
    });

    return {
        created: toCreate.length,
        skipped: tenants.length - toCreate.length,
        totalConsidered: tenants.length,
        tenantIds: toCreate.map((t) => t.id),
    };
}

// ── Provision: fan-out ON TENANT ADD ──────────────────────────────────

/**
 * Provision every existing `ORG_ADMIN` of `orgId` into the newly-
 * linked `tenantId`. Called from the tenant-creation path right after
 * the new Tenant + Tenant.organizationId link is committed.
 *
 * `ORG_READER` members are deliberately excluded — readers don't
 * drill down into per-tenant detail and so don't need the
 * ADMIN `TenantMembership`.
 */
export async function provisionAllOrgAdminsToTenant(
    orgId: string,
    tenantId: string,
    db: DbClient = prisma,
): Promise<ProvisionResult> {
    const admins = await db.orgMembership.findMany({
        // Every administrator of the org, its owner included (#4576).
        where: { organizationId: orgId, role: { in: [...ORG_ADMIN_TIER_ROLES] } },
        select: { userId: true },
    });
    if (admins.length === 0) {
        return { created: 0, skipped: 0, totalConsidered: 0, tenantIds: [] };
    }

    const result = await db.tenantMembership.createMany({
        data: admins.map((a) => ({
            tenantId,
            userId: a.userId,
            role: Role.ADMIN,
            provisionedByOrgId: orgId,
        })),
        skipDuplicates: true,
    });

    // The tenant fan-out callsite (createTenantUnderOrg) is the only
    // consumer today; it doesn't yet emit per-tenant audit rows for
    // each admin promoted-by-virtue-of-new-tenant. When that audit
    // fan-out is added, swap to the pre-query path used by
    // provisionOrgAdminToTenants so `tenantIds` lists the actually-
    // created (admin, tenantId) pairs. For now the array is left
    // empty — over-reporting would attribute admin promotion to the
    // wrong moment.
    return {
        created: result.count,
        skipped: admins.length - result.count,
        totalConsidered: admins.length,
        tenantIds: [],
    };
}

// ── Deprovision: fan-in ON ORG_ADMIN REMOVE ───────────────────────────

/**
 * Reverse the auto-provisioning. Deletes ONLY rows that match BOTH:
 *   - `provisionedByOrgId === orgId` (this exact org tagged the row)
 *   - `role === ADMIN` (defence-in-depth: the column is intended
 *     for ADMIN rows only; refusing to widen lets a misconfigured
 *     row survive for a human to investigate rather than silently
 *     vanish).
 *
 * Manual memberships (`provisionedByOrgId IS NULL`) and rows
 * provisioned by a different org are intentionally untouched. A user
 * who is ORG_ADMIN in two orgs and gets removed from one keeps their
 * ADMIN memberships in the other org's tenants.
 *
 * Wrapped in a transaction so the result's `tenantIds` reflects
 * exactly which rows were deleted — without the transaction, a
 * concurrent provisioner could insert a row between the read and
 * the delete and skew the metadata. (The deletion itself would still
 * be correct under the schema's unique constraint; only the result
 * shape benefits from the lock.)
 */
export async function deprovisionOrgAdmin(
    orgId: string,
    userId: string,
    db?: Prisma.TransactionClient,
): Promise<DeprovisionResult> {
    // When the caller already owns a transaction (e.g. the role-change
    // usecase), reuse it so the OrgMembership update + the ADMIN
    // delete commit together. Otherwise open our own — the explicit
    // transaction is what guarantees the result's `tenantIds` reflects
    // the rows we actually deleted, even if a concurrent provisioner
    // races.
    if (db) {
        return doDeprovision(db, orgId, userId);
    }
    return prisma.$transaction((tx) => doDeprovision(tx, orgId, userId));
}

async function doDeprovision(
    db: DbClient,
    orgId: string,
    userId: string,
): Promise<DeprovisionResult> {
    const targets = await db.tenantMembership.findMany({
        where: {
            userId,
            provisionedByOrgId: orgId,
            role: Role.ADMIN,
        },
        select: { tenantId: true },
    });

    if (targets.length === 0) {
        return { deleted: 0, tenantIds: [] };
    }

    const result = await db.tenantMembership.deleteMany({
        where: {
            userId,
            provisionedByOrgId: orgId,
            role: Role.ADMIN,
        },
    });

    return {
        deleted: result.count,
        tenantIds: targets.map((t) => t.tenantId),
    };
}
