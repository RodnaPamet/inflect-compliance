/**
 * EI-3 — SCIM 2.0 Groups provisioning.
 *
 * Entra pushes group lifecycle (create / member add / member remove / rename)
 * to IC via SCIM. A `ScimGroup` row mirrors the Entra group; member changes
 * reconcile each affected user's `TenantMembership` through the EI-2 engine
 * (`syncEntraMembershipRole`) for near-real-time (de)provisioning —
 * complementing the pull-based sign-in claim path.
 *
 * RLS: `ScimGroup` is FORCE-RLS'd, so reads/writes run inside
 * `runInTenantContext`. The membership reconciliation runs AFTER the group
 * mutation commits (outside that context) so `syncEntraMembershipRole` owns its
 * own tenant context — no nested transactions.
 *
 * (Re-implemented on the current `TenantEntraGroupMapping` model + the shared
 * `syncEntraMembershipRole` engine; the original EI-3 branch predated both.)
 *
 * **Role ceiling.** `externalId` here is a value a SCIM bearer token pushed, and
 * it is matched against the tenant's admin-curated group→role mappings — where
 * ADMIN *is* a legal target for the sign-in path. Every reconcile therefore
 * passes `SCIM_ASSIGNABLE_ROLES` so this path can resolve to no more than the
 * SCIM Users path could (#2200). Do not drop that argument.
 */
import { runInTenantContext } from '@/lib/db-context';
import prisma from '@/lib/prisma';
import type { RequestContext } from '../types';
import { syncEntraMembershipRole } from '@/lib/auth/entra-group-sync';
import { SCIM_ASSIGNABLE_ROLES } from '@/lib/scim/roles';

export interface ScimContext {
    tenantId: string;
}

interface ScimMember {
    value: string; // SCIM member value = user externalId (AAD oid)
    display?: string;
}

const ctxOf = (c: ScimContext) =>
    ({ tenantId: c.tenantId, userId: null } as unknown as RequestContext);

/**
 * Project a `ScimGroup` row to a SCIM Group resource.
 *
 * Members come from `memberIds` — the RESOLVED, server-owned representation —
 * never from `membersJson`. Two reasons, and either alone would be enough:
 *
 *   1. `membersJson` is whatever a token holder POSTed. Echoing it back to any
 *      reader of `GET /Groups` reflects unvalidated attacker JSON verbatim.
 *   2. It is not even maintained: `scimPatchGroup` updates `memberIds` and
 *      leaves `membersJson` at its create-time value, so after any PATCH it is
 *      simply wrong. `reconcileUsers` has always read `memberIds`.
 *
 * The member `value` is therefore this SP's own User id (what
 * `GET /Users/:id` is keyed by), which is what RFC 7643 asks for. Note the
 * asymmetry with writes: inbound member values are matched against
 * `UserIdentityLink.externalSubject` (the IdP's oid), and deliberately NOT
 * against User ids — resolving those would let a token holder add any user in
 * the tenant to a role-mapped group without an identity link existing.
 */
export function scimGroupResource(g: {
    id: string;
    externalId: string;
    displayName: string;
    memberIds: string[];
}) {
    return {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        id: g.id,
        externalId: g.externalId,
        displayName: g.displayName,
        members: g.memberIds.map((value) => ({ value, type: 'User' })),
        meta: { resourceType: 'Group' },
    };
}

export async function scimListGroups(ctx: ScimContext) {
    return runInTenantContext(ctxOf(ctx), (db) =>
        db.scimGroup.findMany({ where: { tenantId: ctx.tenantId }, take: 200 }),
    );
}

export async function scimGetGroup(ctx: ScimContext, id: string) {
    return runInTenantContext(ctxOf(ctx), (db) =>
        db.scimGroup.findFirst({ where: { id, tenantId: ctx.tenantId } }),
    );
}

export async function scimCreateGroup(
    ctx: ScimContext,
    input: { externalId: string; displayName: string; members?: ScimMember[] },
) {
    const members = normalizeMembers(input.members);
    const userIds = await resolveUserIds(ctx.tenantId, members.map((m) => m.value));

    const group = await runInTenantContext(ctxOf(ctx), (db) =>
        db.scimGroup.create({
            data: {
                tenantId: ctx.tenantId,
                externalId: input.externalId,
                displayName: input.displayName,
                memberIds: userIds,
                membersJson: members as never,
            },
        }),
    );
    await reconcileUsers(ctx.tenantId, userIds);
    return group;
}

/** PUT — full replace of displayName + members. */
export async function scimReplaceGroup(
    ctx: ScimContext,
    id: string,
    input: { displayName?: string; members?: ScimMember[] },
) {
    const members = normalizeMembers(input.members);
    const userIds = await resolveUserIds(ctx.tenantId, members.map((m) => m.value));

    const { affected } = await runInTenantContext(ctxOf(ctx), async (db) => {
        const existing = await db.scimGroup.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!existing) return { group: null, affected: [] as string[] };
        const group = await db.scimGroup.update({
            where: { id },
            data: {
                ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
                ...(input.members !== undefined
                    ? { memberIds: userIds, membersJson: members as never }
                    : {}),
            },
        });
        // union of old + new members must be re-evaluated
        const affected = Array.from(new Set([...existing.memberIds, ...userIds]));
        return { group, affected };
    });
    await reconcileUsers(ctx.tenantId, affected);
    return scimGetGroup(ctx, id);
}

/**
 * PATCH — RFC 7644 PatchOp. Supports member add/remove + displayName replace.
 */
export async function scimPatchGroup(
    ctx: ScimContext,
    id: string,
    ops: Array<{ op: string; path?: string; value?: unknown }>,
) {
    const affected = new Set<string>();

    await runInTenantContext(ctxOf(ctx), async (db) => {
        const group = await db.scimGroup.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!group) return;
        let memberIds = [...group.memberIds];
        let displayName = group.displayName;

        for (const op of ops) {
            const path = (op.path ?? '').toLowerCase();
            if (path === 'members' || path === '') {
                if (op.op === 'add') {
                    const ext = membersOf(op.value).map((m) => m.value);
                    const uids = await resolveUserIds(ctx.tenantId, ext, db);
                    for (const u of uids) { if (!memberIds.includes(u)) memberIds.push(u); affected.add(u); }
                } else if (op.op === 'remove') {
                    const ext = membersOf(op.value).map((m) => m.value);
                    const uids = await resolveUserIds(ctx.tenantId, ext, db);
                    memberIds = memberIds.filter((m) => !uids.includes(m));
                    uids.forEach((u) => affected.add(u));
                }
            } else if (path === 'displayname' && op.op === 'replace') {
                displayName = String(op.value ?? displayName);
            }
        }

        await db.scimGroup.update({
            where: { id },
            data: { memberIds, displayName },
        });
        // Keep the linked role mapping's cached display name in sync (UI only).
        await db.tenantEntraGroupMapping.updateMany({
            where: { tenantId: ctx.tenantId, aadGroupId: group.externalId },
            data: { aadGroupName: displayName },
        });
    });

    await reconcileUsers(ctx.tenantId, Array.from(affected));
    return scimGetGroup(ctx, id);
}

export async function scimDeleteGroup(ctx: ScimContext, id: string) {
    const { ok, members } = await runInTenantContext(ctxOf(ctx), async (db) => {
        const group = await db.scimGroup.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!group) return { ok: false, members: [] as string[] };
        await db.scimGroup.deleteMany({ where: { id, tenantId: ctx.tenantId } });
        // The role mapping itself is admin-curated (TenantEntraGroupMapping has
        // no active flag) — deleting the SCIM group just removes this membership
        // source. Reconcile the ex-members so they lose any role this group gave.
        return { ok: true, members: group.memberIds };
    });
    if (ok) await reconcileUsers(ctx.tenantId, members);
    return { ok };
}

// ─── helpers ───────────────────────────────────────────────────────────

/** A PatchOp `value` may be a single member object or an array of them. */
function membersOf(value: unknown): ScimMember[] {
    if (Array.isArray(value)) return normalizeMembers(value);
    if (value && typeof value === 'object' && 'value' in (value as object))
        return normalizeMembers([value]);
    return [];
}

/** Hard cap on members accepted in one push — a bound, not a business rule. */
const MAX_MEMBERS_PER_PUSH = 1000;

/**
 * Coerce a pushed `members` array to the only shape this module understands:
 * `{ value: string, display?: string }`. Anything else is dropped rather than
 * carried into `membersJson` or into a Prisma `{ in: [...] }` filter — the
 * values are unauthenticated-by-role input on a public middleware path.
 */
function normalizeMembers(input: unknown): ScimMember[] {
    if (!Array.isArray(input)) return [];
    const out: ScimMember[] = [];
    for (const raw of input.slice(0, MAX_MEMBERS_PER_PUSH)) {
        if (!raw || typeof raw !== 'object') continue;
        const { value, display } = raw as { value?: unknown; display?: unknown };
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (!trimmed) continue;
        out.push(typeof display === 'string' ? { value: trimmed, display } : { value: trimmed });
    }
    return out;
}

/** Minimal structural db — satisfied by both the global client and a PrismaTx. */
type IdentityLinkDb = {
    userIdentityLink: {
        findMany(args: {
            where: { tenantId: string; externalSubject: { in: string[] } };
            select: { userId: true };
        }): Promise<Array<{ userId: string }>>;
    };
};

/** Resolve SCIM member externalIds (AAD oids) → IC User ids via UserIdentityLink. */
async function resolveUserIds(
    tenantId: string,
    externalSubjects: string[],
    db: IdentityLinkDb = prisma,
): Promise<string[]> {
    if (externalSubjects.length === 0) return [];
    const links = await db.userIdentityLink.findMany({
        where: { tenantId, externalSubject: { in: externalSubjects } },
        select: { userId: true },
    });
    return Array.from(new Set(links.map((l) => l.userId)));
}

/**
 * Recompute each affected user's group membership from ALL their ScimGroups,
 * then reconcile their role through the EI-2 engine. Runs outside the group
 * mutation's tenant context so `syncEntraMembershipRole` owns its own.
 */
async function reconcileUsers(tenantId: string, userIds: string[]): Promise<void> {
    // `userIds` is a single SCIM op's member delta (typically 1, bounded by the
    // push payload). Each user's reconcile needs its OWN tenant context for the
    // sync call that follows; batching would cross-contaminate.
    for (const userId of userIds) { // guardrail-allow: n+1
        const groups = await runInTenantContext(
            { tenantId, userId: null } as unknown as RequestContext,
            (db) =>
                db.scimGroup.findMany({
                    where: { tenantId, memberIds: { has: userId } },
                    select: { externalId: true },
                }),
        );
        const aadGroups = groups.map((g) => g.externalId);
        await syncEntraMembershipRole({
            userId,
            tenantId,
            aadGroups,
            // The ceiling. Without it a token holder who can guess (or read
            // from the admin UI) an ADMIN-mapped group id promotes themselves
            // by pushing a group with that externalId. See `@/lib/scim/roles`.
            assignableRoles: SCIM_ASSIGNABLE_ROLES,
        });
    }
}
