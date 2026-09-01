/**
 * SCIM 2.0 User Lifecycle Usecases
 *
 * Maps SCIM user operations to local User + TenantMembership lifecycle.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * LIFECYCLE MAPPING
 * ═══════════════════════════════════════════════════════════════════════
 *
 * SCIM create → create User + TenantMembership (ACTIVE, READER by default)
 * SCIM get/list → read User + membership for tenant
 * SCIM patch/put → update User fields + membership active/inactive
 * SCIM deactivate (active=false) → set membership status=DEACTIVATED
 * SCIM activate (active=true) → set membership status=ACTIVE
 * SCIM delete → set membership status=DEACTIVATED (soft-delete)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ROLE MAPPING POLICY
 * ═══════════════════════════════════════════════════════════════════════
 *
 * By default, SCIM provisions users with READER role.
 *
 * Allowed SCIM-to-local role mappings (explicit allow-list):
 *   - "reader"  → READER (default)
 *   - "editor"  → EDITOR
 *   - "auditor" → AUDITOR
 *   - "admin"   → BLOCKED (never via SCIM — requires manual admin action)
 *
 * IdPs can set role via:
 *   PATCH { op: "replace", path: "roles", value: [{ value: "editor" }] }
 *   POST  { ..., "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": { "department": "editor" } }
 *
 * ═══════════════════════════════════════════════════════════════════════
 * SAFETY INVARIANTS
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 1. SCIM NEVER creates or promotes to ADMIN. The ceiling is
 *    `SCIM_ASSIGNABLE_ROLES` in `@/lib/scim/roles` — ONE list, also read by the
 *    SCIM Groups push path, which used to resolve roles through the Entra
 *    group→role mappings where ADMIN is a legal target (#2200).
 * 1b. SCIM never MUTATES an ADMIN or OWNER membership either — not its role and
 *    (since #2200) not its status. Deactivating an admin is a privileged act.
 * 2. Deactivation is reversible (status=DEACTIVATED, not hard-delete)
 * 3. All operations are tenant-scoped via ScimContext.tenantId
 * 4. Historical records (audit, evidence, tasks) remain intact after deprovisioning
 * 5. All mutations emit structured audit events (SCIM_USER_*)
 */
import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { logger } from '@/lib/observability/logger';
import { hashForLookup } from '@/lib/security/encryption';
import { ScimForbiddenError, type ScimContext } from '@/lib/scim/auth';
import {
    SCIM_ASSIGNABLE_ROLES,
    SCIM_DEFAULT_ROLE,
    isScimProtectedRole,
    type ScimAssignableRole,
} from '@/lib/scim/roles';
import { SCIM_SCHEMAS, type ScimUser } from '@/lib/scim/types';
import { appendAuditEntry } from '@/lib/audit/audit-writer';

// ─── Constants ───────────────────────────────────────────────────────

/**
 * Allow-list for SCIM role mapping, keyed by the lowercased value an IdP sends.
 *
 * DERIVED from `SCIM_ASSIGNABLE_ROLES` rather than spelled out again: the
 * ceiling is now shared with the SCIM Groups push path, and two hand-written
 * copies of "which roles may SCIM assign" is exactly how ADMIN became reachable
 * from one path and not the other (#2200). "admin" and "owner" are absent
 * because they are absent from the ceiling — there is one place to change.
 */
const SCIM_ROLE_MAP: Record<string, ScimAssignableRole> = Object.fromEntries(
    SCIM_ASSIGNABLE_ROLES.map((role) => [role.toLowerCase(), role]),
);

// ─── Audit Helper ────────────────────────────────────────────────────

/**
 * Emit a structured SCIM audit event to the immutable audit log.
 * Uses actorType='SCIM' since SCIM operations have no user session.
 */
async function emitScimAudit(
    tenantId: string,
    action: string,
    entityId: string,
    details: Record<string, unknown>
): Promise<void> {
    try {
        await appendAuditEntry({
            tenantId,
            userId: null,
            actorType: 'SCIM',
            entity: 'TenantMembership',
            entityId,
            action,
            detailsJson: {
                category: 'scim_provisioning',
                schemaVersion: 1,
                ...details,
            },
        });
    } catch (err) {
        // Audit failures must never block SCIM provisioning
        logger.error('SCIM audit event failed', {
            component: 'scim', action, entityId,
            error: err instanceof Error ? err : new Error(String(err)),
        });
    }
}

// ─── Membership Protection ───────────────────────────────────────────

/**
 * Refuse any SCIM write against a membership whose role SCIM could not itself
 * have assigned (ADMIN / OWNER today).
 *
 * The role writes below already skipped ADMIN. The STATUS writes did not — so a
 * token holder could not change an ADMIN's role but could switch that ADMIN
 * off, which is the more useful half of the two if you are trying to take a
 * tenant's administrators away from it (#2200).
 *
 * This throws rather than skipping silently, unlike the role writes: a DELETE
 * that answers 204 while having written nothing tells the IdP the user was
 * deprovisioned when they were not. `ScimForbiddenError` extends
 * `ScimAuthError`, so every SCIM route's existing catch renders it as a
 * SCIM-shaped 403 with no route change.
 */
function assertScimMayWrite(
    membership: { role: string },
    operation: string,
    userId: string,
    tenantId: string,
): void {
    if (!isScimProtectedRole(membership.role)) return;
    logger.warn('SCIM write refused against a protected membership', {
        component: 'scim', operation, userId, tenantId, role: membership.role,
    });
    throw new ScimForbiddenError(
        `SCIM cannot modify a ${membership.role} membership; change it in the admin UI`,
    );
}

// ─── Role Resolution ─────────────────────────────────────────────────

/**
 * Safely resolve a SCIM role value to a local Role enum.
 *
 * If the value is not in the allow-list (or is "admin"), returns
 * the default READER role and a warning flag.
 */
export function resolveScimRole(
    scimRoleValue?: string
): { role: ScimAssignableRole; blocked: boolean; requestedRole?: string } {
    if (!scimRoleValue) return { role: SCIM_DEFAULT_ROLE, blocked: false };

    const normalized = scimRoleValue.toLowerCase().trim();
    const mapped = SCIM_ROLE_MAP[normalized];

    if (mapped) return { role: mapped, blocked: false };

    // Attempted to set an unmapped role (e.g. "admin") — block silently
    return {
        role: SCIM_DEFAULT_ROLE,
        blocked: true,
        requestedRole: scimRoleValue,
    };
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Map a User + TenantMembership to a SCIM User resource.
 */
export function toScimUser(
    user: { id: string; email: string; name: string | null; createdAt: Date; updatedAt: Date },
    membership: { status: string; role?: string } | null,
    baseUrl: string
): ScimUser {
    const nameParts = (user.name || '').split(' ');
    return {
        schemas: [SCIM_SCHEMAS.User],
        id: user.id,
        userName: user.email,
        name: {
            formatted: user.name || undefined,
            givenName: nameParts[0] || undefined,
            familyName: nameParts.slice(1).join(' ') || undefined,
        },
        displayName: user.name || user.email,
        emails: [
            { value: user.email, type: 'work', primary: true },
        ],
        active: membership?.status === 'ACTIVE',
        meta: {
            resourceType: 'User',
            created: user.createdAt.toISOString(),
            lastModified: user.updatedAt.toISOString(),
            location: `${baseUrl}/api/scim/v2/Users/${user.id}`,
        },
    };
}

// ─── List Users ──────────────────────────────────────────────────────

export async function scimListUsers(
    ctx: ScimContext,
    baseUrl: string,
    options: { startIndex?: number; count?: number; filter?: string } = {}
) {
    const { startIndex = 1, count = 100, filter } = options;

    const memberWhere: Prisma.TenantMembershipWhereInput = {
        tenantId: ctx.tenantId,
        status: { in: ['ACTIVE', 'DEACTIVATED', 'INVITED'] },
    };

    let emailFilter: string | undefined;
    if (filter) {
        const match = filter.match(/userName\s+eq\s+"([^"]+)"/i);
        if (match) emailFilter = match[1].toLowerCase();
    }

    const memberships = await prisma.tenantMembership.findMany({
        where: memberWhere,
        include: {
            user: {
                select: { id: true, email: true, name: true, createdAt: true, updatedAt: true },
            },
        },
        skip: startIndex - 1,
        take: Math.min(count, 200),
        orderBy: { createdAt: 'asc' },
    });

    const filtered = emailFilter
        ? memberships.filter(m => m.user.email.toLowerCase() === emailFilter)
        : memberships;

    const total = emailFilter
        ? filtered.length
        : await prisma.tenantMembership.count({ where: memberWhere });

    const resources = filtered.map(m => toScimUser(m.user, m, baseUrl));

    return { resources, total, startIndex };
}

// ─── Get User ────────────────────────────────────────────────────────

export async function scimGetUser(ctx: ScimContext, userId: string, baseUrl: string) {
    const membership = await prisma.tenantMembership.findFirst({
        where: { tenantId: ctx.tenantId, userId },
        include: {
            user: {
                select: { id: true, email: true, name: true, createdAt: true, updatedAt: true },
            },
        },
    });

    if (!membership) return null;

    return toScimUser(membership.user, membership, baseUrl);
}

// ─── Create User ─────────────────────────────────────────────────────

export interface ScimCreateUserInput {
    userName: string;
    name?: { givenName?: string; familyName?: string; formatted?: string };
    displayName?: string;
    active?: boolean;
    externalId?: string;
    roles?: Array<{ value: string }>;
}

export async function scimCreateUser(
    ctx: ScimContext,
    input: ScimCreateUserInput,
    baseUrl: string
): Promise<{ user: ScimUser; created: boolean }> {
    const email = input.userName.toLowerCase();
    const displayName = input.displayName
        || input.name?.formatted
        || [input.name?.givenName, input.name?.familyName].filter(Boolean).join(' ')
        || email.split('@')[0];

    // Resolve role from SCIM input (safe allow-list)
    const roleInput = input.roles?.[0]?.value;
    const { role, blocked, requestedRole } = resolveScimRole(roleInput);

    if (blocked) {
        logger.warn('SCIM role mapping blocked', {
            component: 'scim', requestedRole, assignedRole: role, email,
        });
    }

    logger.info('SCIM create user', { component: 'scim', email, tenantId: ctx.tenantId, role });

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
        where: { emailHash: hashForLookup(email) },
        select: { id: true, email: true, name: true, createdAt: true, updatedAt: true },
    });

    if (existingUser) {
        const existingMembership = await prisma.tenantMembership.findUnique({
            where: { tenantId_userId: { tenantId: ctx.tenantId, userId: existingUser.id } },
        });

        if (existingMembership) {
            // ── Idempotent: already exists ──
            const needsReactivation =
                existingMembership.status === 'DEACTIVATED' || existingMembership.status === 'REMOVED';
            // The fourth status write. A protected membership is NOT reactivated
            // by a SCIM push: a tenant admin switched that admin off deliberately,
            // and the IdP's directory is not the authority on whether an ADMIN is
            // on. Skipped rather than 403'd — POST /Users is the idempotent create
            // verb, and the response below reports the membership's REAL status,
            // so the IdP is told what actually happened.
            const mayReactivate = needsReactivation && !isScimProtectedRole(existingMembership.role);
            if (needsReactivation && !mayReactivate) {
                logger.warn('SCIM reactivation refused against a protected membership', {
                    component: 'scim', userId: existingUser.id, tenantId: ctx.tenantId,
                    role: existingMembership.role,
                });
            }

            if (mayReactivate) {
                await prisma.tenantMembership.update({
                    where: { id: existingMembership.id },
                    data: { status: 'ACTIVE', deactivatedAt: null },
                });

                await emitScimAudit(ctx.tenantId, 'SCIM_USER_REACTIVATED', existingUser.id, {
                    email, previousStatus: existingMembership.status, role: existingMembership.role,
                    tokenLabel: ctx.tokenLabel,
                });

                logger.info('SCIM reactivated existing user', { component: 'scim', userId: existingUser.id });
            }

            return {
                user: toScimUser(
                    existingUser,
                    { status: mayReactivate ? 'ACTIVE' : existingMembership.status },
                    baseUrl,
                ),
                created: false,
            };
        }

        // User exists but no membership — add to tenant
        const membership = await prisma.tenantMembership.create({
            data: {
                tenantId: ctx.tenantId,
                userId: existingUser.id,
                role,
                status: input.active === false ? 'DEACTIVATED' : 'ACTIVE',
            },
        });

        await emitScimAudit(ctx.tenantId, 'SCIM_USER_CREATED', existingUser.id, {
            email, role, existingUser: true, tokenLabel: ctx.tokenLabel,
        });

        return {
            user: toScimUser(existingUser, membership, baseUrl),
            created: true,
        };
    }

    // Create new user + membership in transaction
    const result = await prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
            data: { email, emailHash: hashForLookup(email), name: displayName },
        });

        const membership = await tx.tenantMembership.create({
            data: {
                tenantId: ctx.tenantId,
                userId: newUser.id,
                role,
                status: input.active === false ? 'DEACTIVATED' : 'ACTIVE',
            },
        });

        return { user: newUser, membership };
    });

    await emitScimAudit(ctx.tenantId, 'SCIM_USER_CREATED', result.user.id, {
        email, role, displayName, existingUser: false, tokenLabel: ctx.tokenLabel,
    });

    logger.info('SCIM created new user', { component: 'scim', userId: result.user.id, role });

    return {
        user: toScimUser(
            { ...result.user, createdAt: result.user.createdAt, updatedAt: result.user.updatedAt },
            result.membership,
            baseUrl
        ),
        created: true,
    };
}

// ─── Patch User ──────────────────────────────────────────────────────

export interface ScimPatchOperation {
    op: 'add' | 'remove' | 'replace';
    path?: string;
    value?: unknown;
}

export async function scimPatchUser(
    ctx: ScimContext,
    userId: string,
    operations: ScimPatchOperation[],
    baseUrl: string
): Promise<ScimUser | null> {
    const membership = await prisma.tenantMembership.findFirst({
        where: { tenantId: ctx.tenantId, userId },
        include: { user: true },
    });

    if (!membership) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userUpdates: Record<string, any> = {};
    let statusUpdate: 'ACTIVE' | 'DEACTIVATED' | undefined;
    let roleUpdate: ScimAssignableRole | undefined;
    const changes: string[] = [];

    for (const op of operations) {
        if (op.op === 'replace' || op.op === 'add') {
            const path = op.path?.toLowerCase();

            if (path === 'active') {
                statusUpdate = op.value === true || op.value === 'true' ? 'ACTIVE' : 'DEACTIVATED';
                changes.push(`active=${statusUpdate}`);
            } else if (path === 'displayname' || path === 'name.formatted') {
                userUpdates.name = String(op.value);
                changes.push(`displayName=${op.value}`);
            } else if (path === 'name.givenname') {
                const currentParts = (membership.user.name || '').split(' ');
                currentParts[0] = String(op.value);
                userUpdates.name = currentParts.join(' ');
                changes.push(`givenName=${op.value}`);
            } else if (path === 'name.familyname') {
                const currentParts = (membership.user.name || '').split(' ');
                if (currentParts.length > 1) {
                    currentParts[currentParts.length - 1] = String(op.value);
                } else {
                    currentParts.push(String(op.value));
                }
                userUpdates.name = currentParts.join(' ');
                changes.push(`familyName=${op.value}`);
            } else if (path === 'roles') {
                // Role mapping from SCIM — safe allow-list
                const roles = op.value as Array<{ value: string }>;
                if (Array.isArray(roles) && roles.length > 0) {
                    const { role, blocked, requestedRole } = resolveScimRole(roles[0].value);
                    if (blocked) {
                        logger.warn('SCIM role mapping blocked in PATCH', {
                            component: 'scim', requestedRole, userId,
                        });
                        changes.push(`role_blocked=${requestedRole}`);
                    } else {
                        roleUpdate = role;
                        changes.push(`role=${role}`);
                    }
                }
            } else if (!path) {
                // Root-level replace
                const val = op.value as Record<string, unknown> | undefined;
                if (val) {
                    if ('active' in val) {
                        statusUpdate = val.active === true || val.active === 'true' ? 'ACTIVE' : 'DEACTIVATED';
                        changes.push(`active=${statusUpdate}`);
                    }
                    if ('displayName' in val) {
                        userUpdates.name = String(val.displayName);
                        changes.push(`displayName=${val.displayName}`);
                    }
                    if ('name' in val && typeof val.name === 'object') {
                        const n = val.name as Record<string, string>;
                        userUpdates.name = [n.givenName, n.familyName].filter(Boolean).join(' ') || n.formatted;
                        changes.push(`name=${userUpdates.name}`);
                    }
                }
            }
        }
    }

    // Apply user profile updates. Guarded for the same reason as the PUT path:
    // `User.name` is global, so an unguarded write here lets one tenant's SCIM
    // token rename another tenant's ADMIN. Unlike the status guard below, this
    // one is NOT narrowed to a real transition — there is no value the write
    // could carry that makes it safe against a protected principal.
    if (Object.keys(userUpdates).length > 0) {
        assertScimMayWrite(membership, 'patch:profile', userId, ctx.tenantId);
        await prisma.user.update({
            where: { id: userId },
            data: userUpdates,
        });
    }

    // Apply membership status update
    if (statusUpdate) {
        // Only a REAL transition is refused. A full IdP sync re-pushes
        // `active: true` for every user every cycle; 403-ing that on an ADMIN
        // whose status is already ACTIVE would break routine provisioning
        // without protecting anything.
        if (statusUpdate !== membership.status) {
            assertScimMayWrite(membership, 'patch:active', userId, ctx.tenantId);
        }
        await prisma.tenantMembership.update({
            where: { id: membership.id },
            data: {
                status: statusUpdate,
                ...(statusUpdate === 'DEACTIVATED' ? { deactivatedAt: new Date() } : { deactivatedAt: null }),
            },
        });
    }

    // Apply safe role update (never against a protected membership)
    if (roleUpdate && !isScimProtectedRole(membership.role)) {
        await prisma.tenantMembership.update({
            where: { id: membership.id },
            data: { role: roleUpdate },
        });
    }

    // Determine audit event type
    const auditAction = statusUpdate === 'DEACTIVATED'
        ? 'SCIM_USER_DEACTIVATED'
        : 'SCIM_USER_UPDATED';

    await emitScimAudit(ctx.tenantId, auditAction, userId, {
        email: membership.user.email, changes,
        previousStatus: membership.status,
        newStatus: statusUpdate || membership.status,
        tokenLabel: ctx.tokenLabel,
    });

    logger.info('SCIM patched user', {
        component: 'scim', userId, changes,
    });

    return scimGetUser(ctx, userId, baseUrl);
}

// ─── Put User (full replace) ─────────────────────────────────────────

export async function scimPutUser(
    ctx: ScimContext,
    userId: string,
    input: ScimCreateUserInput,
    baseUrl: string
): Promise<ScimUser | null> {
    const membership = await prisma.tenantMembership.findFirst({
        where: { tenantId: ctx.tenantId, userId },
    });

    if (!membership) return null;

    const displayName = input.displayName
        || input.name?.formatted
        || [input.name?.givenName, input.name?.familyName].filter(Boolean).join(' ')
        || input.userName.split('@')[0];

    // The profile write is refused for a protected membership, and it must be
    // refused BEFORE the write, not after.
    //
    // It used to run unconditionally, above the status guard. With
    // `active: false` that meant the ADMIN was renamed and THEN 403'd — and
    // because the throw precedes `emitScimAudit`, no audit row was written
    // either. With `active: true` the status guard is not reached at all, so
    // the rename returned 200. A token holder could rename every admin in the
    // tenant, silently and repeatably.
    //
    // The reason this outranks the routine-sync argument that (correctly)
    // keeps the STATUS guard narrow: `User.name` is on the GLOBAL user row,
    // not on the tenant membership. A SCIM token issued by tenant A can
    // therefore rewrite the display name of somebody who is an ADMIN of
    // tenant B. That is a cross-tenant write, and no IdP sync convenience
    // justifies leaving it open.
    assertScimMayWrite(membership, 'put:profile', userId, ctx.tenantId);

    await prisma.user.update({
        where: { id: userId },
        data: { name: displayName },
    });

    const newStatus = input.active === false ? 'DEACTIVATED' : 'ACTIVE';
    if (membership.status !== newStatus) {
        assertScimMayWrite(membership, 'put:active', userId, ctx.tenantId);
        await prisma.tenantMembership.update({
            where: { id: membership.id },
            data: {
                status: newStatus,
                ...(newStatus === 'DEACTIVATED' ? { deactivatedAt: new Date() } : { deactivatedAt: null }),
            },
        });
    }

    // Safe role mapping for PUT
    if (input.roles?.[0]?.value && !isScimProtectedRole(membership.role)) {
        const { role, blocked } = resolveScimRole(input.roles[0].value);
        if (!blocked) {
            await prisma.tenantMembership.update({
                where: { id: membership.id },
                data: { role },
            });
        }
    }

    const auditAction = newStatus === 'DEACTIVATED' ? 'SCIM_USER_DEACTIVATED' : 'SCIM_USER_UPDATED';
    await emitScimAudit(ctx.tenantId, auditAction, userId, {
        displayName, active: input.active, previousStatus: membership.status,
        tokenLabel: ctx.tokenLabel,
    });

    return scimGetUser(ctx, userId, baseUrl);
}

// ─── Delete User (soft-delete via deactivation) ──────────────────────

export async function scimDeleteUser(ctx: ScimContext, userId: string): Promise<boolean> {
    const membership = await prisma.tenantMembership.findFirst({
        where: { tenantId: ctx.tenantId, userId },
        include: { user: { select: { email: true } } },
    });

    if (!membership) return false;

    assertScimMayWrite(membership, 'delete', userId, ctx.tenantId);

    await prisma.tenantMembership.update({
        where: { id: membership.id },
        data: { status: 'DEACTIVATED', deactivatedAt: new Date() },
    });

    await emitScimAudit(ctx.tenantId, 'SCIM_USER_DEACTIVATED', userId, {
        email: membership.user.email,
        previousStatus: membership.status,
        method: 'DELETE',
        tokenLabel: ctx.tokenLabel,
    });

    logger.info('SCIM deactivated user', { component: 'scim', userId, tenantId: ctx.tenantId });
    return true;
}
