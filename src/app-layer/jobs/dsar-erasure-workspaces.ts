/**
 * Which workspaces a DSAR erasure covers: every tenant where the subject
 * EVER held a membership, read from the audit trail (#5802, owner decision
 * 2026-11-25).
 *
 * ── WHY THE AUDIT TRAIL, AND WHY NOT ONLY THE SUBJECT'S OWN ROWS ───────
 *
 * By the time `eraseUser` runs, the subject holds no `TenantMembership` row:
 * the membership's FK to `User` is ON DELETE RESTRICT, so `planErasure`
 * refuses the erasure while any row is left. The membership TABLE therefore
 * cannot answer "where was this person a member". The audit trail can, and
 * it is the only durable record that can.
 *
 * Before #5802 the erasure read the tenants off the subject's OWN audit rows
 * (`AuditLog.userId = subject`). A member added by somebody else — SCIM,
 * org provisioning — who never acted in that workspace left no such row, so
 * the Managed Agents clean-up never reached it, and the kept sessions there
 * survived the erasure. This module adds the rows each membership WRITER
 * emits naming the subject, whoever the actor was.
 *
 * ── THE RULE, IN ONE PLACE ─────────────────────────────────────────────
 *
 * `erasureWorkspacesFrom` is pure: it classifies audit evidence and decides
 * the tenant set. `readErasureWorkspaces` is the only reader. `eraseUser`
 * calls it inside its own transaction, before the pseudonymization (which
 * nulls the subject's own rows), and hands its tenants to the Managed Agents
 * clean-up; the operator command `scripts/dsar-erase.ts` calls it to
 * print the plan. Neither keeps a narrower rule of its own.
 *
 * ── WHAT COUNTS, AND WHY EACH ──────────────────────────────────────────
 *
 *   OWN_ACTION        `AuditLog.userId` is the subject — today's rule. It is
 *                     how an invite redemption (`MEMBER_INVITE_ACCEPTED`,
 *                     both redemption paths), a platform-admin tenant
 *                     creation (`TENANT_CREATED` / `TENANT_MEMBERSHIP_GRANTED`
 *                     carry the new owner as `userId`) and an Entra role sync
 *                     (`MEMBER_ROLE_CHANGED`, `userId` the member) name them.
 *   MEMBERSHIP_RECORD `entity = 'TenantMembership'`, `entityId` = the subject,
 *                     and an action in `MEMBERSHIP_RECORD_ACTIONS`. SCIM
 *                     writes every row of a member's lifecycle this way
 *                     (`actorType: SCIM`, `userId: null`), org provisioning
 *                     its per-tenant fan-out, and the platform-admin tenant
 *                     creation its grant.
 *   TARGET_RECORD     `detailsJson.targetUserId` is the subject, and the action
 *                     is in `TARGET_RECORD_ACTIONS`: a REMOVAL or deactivation
 *                     of their membership (#5940, owner decision 2026-11-25).
 *                     Every erasure is preceded by one, because `planErasure`
 *                     refuses while any membership row is left, so this is
 *                     what finds a workspace joined through a writer that
 *                     records no row naming the person at the JOIN (credentials
 *                     signup, SSO JIT, `createTenantUnderOrg`, the org fan-out
 *                     into a new tenant, the staging seed). A `targetUserId`
 *                     under an action NOT listed is ignored, not undecided:
 *                     that key is the actor convention on dozens of rows (a
 *                     DSAR transition, a session revocation, an MFA reset)
 *                     which say nothing about a membership.
 *   ORG_TENANT_FANOUT `OrgAuditLog.targetUserId` is the subject and the action
 *                     is an org-admin fan-out, whose `detailsJson.tenantIds`
 *                     names each tenant the fan-out reached. An org invite
 *                     redemption writes ONLY this, never a per-tenant row.
 *                     (A subject the org trail names cannot be erased today —
 *                     `planErasure` blocks on `OrgAuditLog`, reason
 *                     `IMMUTABLE_AUDIT_TRAIL` — so these tenants reach a plan,
 *                     never a clean-up. They are reported so the plan is
 *                     honest about where the person was.)
 *
 * An action is listed, never inferred. A `TenantMembership` row naming the
 * subject under an action this module does not know is UNDECIDED: reported,
 * and not counted. Counting it would mean deleting every kept session in a
 * workspace on a row nobody classified, because the clean-up deletes the
 * workspace's kept sessions, not the person's alone (owner decisions 4 and 7
 * of docs/claude-managed-agents-design.md); leaving it silent would hide a
 * new writer. A fan-out row whose `tenantIds` cannot be read is undecided for
 * the same reason.
 *
 * ── WHAT IT CANNOT SEE ─────────────────────────────────────────────────
 *
 * `MEMBERSHIP_WRITERS_WITHOUT_A_SUBJECT_ROW` lists what still leaves no row
 * naming the subject. Since #5940 that is no longer "the writers that record
 * no row at the join" — the removal that precedes every erasure names them —
 * but the removals written BEFORE #5940, which carry no `targetUserId` (no
 * backfill: the trail is immutable), and the tenant purge, which deletes a
 * purged tenant's memberships without naming anybody. The plan reports that
 * list on every read rather than claiming completeness.
 *
 * @module app-layer/jobs/dsar-erasure-workspaces
 */

/** Why a tenant is in the plan. */
export type WorkspaceEvidenceKind = 'OWN_ACTION' | 'MEMBERSHIP_RECORD' | 'TARGET_RECORD' | 'ORG_TENANT_FANOUT';

/**
 * `AuditLog` actions that record the subject holding a membership when they
 * are written with `entity = 'TenantMembership'` and `entityId` = the user id.
 * Read off the writers, each named beside its actions.
 */
export const MEMBERSHIP_RECORD_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
    // usecases/scim-users.ts — `emitScimAudit(tenantId, <action>, userId, …)`.
    SCIM_USER_CREATED: 'scim-users.ts: scimCreateUser (new user, or an existing user added to the tenant)',
    SCIM_USER_REACTIVATED: 'scim-users.ts: scimCreateUser on a DEACTIVATED or REMOVED membership',
    SCIM_USER_UPDATED: 'scim-users.ts: scimPatchUser / scimPutUser on a membership',
    SCIM_USER_DEACTIVATED: 'scim-users.ts: scimPatchUser / scimPutUser / scimDeleteUser on a membership',
    // usecases/org-members.ts — `emitOrgMembershipAudit`, one row per tenant
    // whose ADMIN row `org-provisioning.ts` created or deleted.
    ORG_ADMIN_PROVISIONED: 'org-members.ts: addOrgMember / changeOrgMemberRole fan-out (org-provisioning.ts)',
    ORG_ADMIN_DEPROVISIONED: 'org-members.ts: removeOrgMember / changeOrgMemberRole fan-in (org-provisioning.ts)',
    // usecases/tenant-lifecycle.ts — `createTenantWithOwner`.
    TENANT_MEMBERSHIP_GRANTED: 'tenant-lifecycle.ts: createTenantWithOwner (also an OWN_ACTION row)',
});

/**
 * `AuditLog` actions that record the END of the subject's membership and name
 * them as `detailsJson.targetUserId` (#5940). Read off the writers, each named
 * beside its actions. Only these count: the key alone is not membership
 * evidence (see TARGET_RECORD above).
 */
export const TARGET_RECORD_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
    // usecases/tenant-admin.ts — the members page.
    MEMBER_REMOVED: 'tenant-admin.ts: removeTenantMember (the membership row is deleted)',
    MEMBER_DEACTIVATED: 'tenant-admin.ts: deactivateTenantMember',
    // usecases/scim-users.ts — `emitScimAudit` adds the key on a deactivation.
    SCIM_USER_DEACTIVATED: 'scim-users.ts: scimPatchUser / scimPutUser / scimDeleteUser deactivation',
    // usecases/org-members.ts — `emitOrgMembershipAudit`, one row per tenant.
    ORG_ADMIN_DEPROVISIONED: 'org-members.ts: removeOrgMember / changeOrgMemberRole fan-in (org-provisioning.ts)',
    // usecases/access-review.ts — the close's execution row. A REVOKE
    // deactivates and a MODIFY changes the role; either way the subject held a
    // membership in the campaign's tenant.
    ACCESS_REVIEW_DECISION_EXECUTED: 'access-review.ts: closeAccessReview execution of a decision',
});

/**
 * `OrgAuditLog` actions whose `detailsJson.tenantIds` lists the tenants an
 * org-admin fan-out gave (or took) an ADMIN membership in, for `targetUserId`.
 */
export const ORG_TENANT_FANOUT_ACTIONS: readonly string[] = Object.freeze([
    // org-members.ts addOrgMember / changeOrgMemberRole, org-invites.ts redeemOrgInvite.
    'ORG_ADMIN_PROVISIONED_TO_TENANTS',
    // org-members.ts changeOrgMemberRole (and removal) — the subject held ADMIN there until then.
    'ORG_ADMIN_DEPROVISIONED_FROM_TENANTS',
]);

/**
 * What leaves no audit row naming the subject, so a workspace reached only
 * that way, where the person then never acted, is invisible to this read.
 *
 * The five allowlisted `TenantMembership` writers (tests/guardrails/no-auto-join)
 * that record no row at the JOIN — credentials signup (`auth/register`), SSO
 * JIT (`sso.ts`), `createTenantUnderOrg`, the fan-out into a new org tenant
 * (`provisionAllOrgAdminsToTenant`) and the staging seed — are covered since
 * #5940 by the REMOVAL that must precede every erasure (TARGET_RECORD). What
 * is left is listed here.
 */
export const MEMBERSHIP_WRITERS_WITHOUT_A_SUBJECT_ROW: readonly string[] = Object.freeze([
    'a removal written before #5940 (MEMBER_REMOVED / MEMBER_DEACTIVATED / SCIM_USER_DEACTIVATED with no detailsJson.targetUserId) of a membership joined through credentials signup, SSO JIT, createTenantUnderOrg, the org fan-out into a new tenant or the staging seed: not backfilled, the trail is immutable',
    'src/app-layer/usecases/tenant-purge.ts (the purge deletes a purged tenant\'s memberships and names nobody; it runs its own Managed Agents clean-up before it does)',
]);

/**
 * One `AuditLog` row, or a group of identical rows, as the reader returns it.
 * `userId` and `entityId` are the subject's id when the row names them there
 * and null otherwise, so a raw row and a grouped one classify alike.
 */
export interface AuditEvidenceRow {
    tenantId: string;
    userId: string | null;
    entity: string;
    entityId: string | null;
    action: string;
    /**
     * `detailsJson.targetUserId` when it is the subject AND the action is in
     * `TARGET_RECORD_ACTIONS`, null otherwise. Optional so evidence built
     * before #5940 still classifies (read as null).
     */
    targetUserId?: string | null;
    /** How many rows this evidence row stands for. Defaults to 1. */
    rows?: number;
}

/** One `OrgAuditLog` row naming the subject as `targetUserId`. */
export interface OrgFanoutEvidenceRow {
    id: string;
    targetUserId: string | null;
    action: string;
    detailsJson: unknown;
}

export interface ErasureWorkspace {
    tenantId: string;
    /** Every kind of evidence that put the tenant here, sorted. */
    kinds: WorkspaceEvidenceKind[];
    /** Rows of evidence, summed across kinds. */
    rows: number;
}

/** Evidence naming the subject that this module would not classify. */
export interface UndecidedEvidence {
    trail: 'AuditLog' | 'OrgAuditLog';
    /** The tenant, when the row has one. */
    tenantId: string | null;
    action: string;
    reason: 'UNLISTED_MEMBERSHIP_ACTION' | 'FANOUT_TENANTS_UNREADABLE';
    rows: number;
}

export interface ErasureWorkspaces {
    /** Sorted, distinct. What the erasure's clean-up runs over. */
    tenantIds: string[];
    workspaces: ErasureWorkspace[];
    undecided: UndecidedEvidence[];
    /** Always the full list: what no read of the audit trail can see. */
    writersWithoutASubjectRow: readonly string[];
}

/**
 * Decide the workspaces from evidence. Pure. Evidence not naming `subjectId`
 * is ignored, so a caller handing over more rows than it filtered cannot
 * widen the set.
 */
export function erasureWorkspacesFrom(
    subjectId: string,
    evidence: { audit: readonly AuditEvidenceRow[]; orgFanout: readonly OrgFanoutEvidenceRow[] },
): ErasureWorkspaces {
    if (!subjectId) throw new Error('dsar-erasure-workspaces: a subject id is required.');

    const byTenant = new Map<string, { kinds: Set<WorkspaceEvidenceKind>; rows: number }>();
    const add = (tenantId: string, kind: WorkspaceEvidenceKind, rows: number) => {
        const entry = byTenant.get(tenantId) ?? { kinds: new Set<WorkspaceEvidenceKind>(), rows: 0 };
        entry.kinds.add(kind);
        entry.rows += rows;
        byTenant.set(tenantId, entry);
    };
    const undecided: UndecidedEvidence[] = [];

    for (const row of evidence.audit) {
        const rows = row.rows ?? 1;
        const ownAction = row.userId === subjectId;
        const namesMembership = row.entity === 'TenantMembership' && row.entityId === subjectId;
        // Listed, never inferred: the key under an unlisted action is ignored.
        const targetsSubject = row.targetUserId === subjectId
            && Object.prototype.hasOwnProperty.call(TARGET_RECORD_ACTIONS, row.action);
        if (!ownAction && !namesMembership && !targetsSubject) continue;
        if (ownAction) add(row.tenantId, 'OWN_ACTION', rows);
        // A row counted once: an own-action row adds its rows there.
        if (targetsSubject) add(row.tenantId, 'TARGET_RECORD', ownAction ? 0 : rows);
        if (!namesMembership) continue;
        if (Object.prototype.hasOwnProperty.call(MEMBERSHIP_RECORD_ACTIONS, row.action)) {
            add(row.tenantId, 'MEMBERSHIP_RECORD', ownAction || targetsSubject ? 0 : rows);
        } else if (!ownAction && !targetsSubject) {
            // An own-action row already counts; only a row that would add a
            // tenant on an unclassified action is held back.
            undecided.push({ trail: 'AuditLog', tenantId: row.tenantId, action: row.action, reason: 'UNLISTED_MEMBERSHIP_ACTION', rows });
        }
    }

    for (const row of evidence.orgFanout) {
        if (row.targetUserId !== subjectId || !ORG_TENANT_FANOUT_ACTIONS.includes(row.action)) continue;
        const tenantIds = fanoutTenantIds(row.detailsJson);
        if (tenantIds === null) {
            undecided.push({ trail: 'OrgAuditLog', tenantId: null, action: row.action, reason: 'FANOUT_TENANTS_UNREADABLE', rows: 1 });
            continue;
        }
        for (const tenantId of tenantIds) add(tenantId, 'ORG_TENANT_FANOUT', 1);
    }

    const tenantIds = [...byTenant.keys()].sort();
    return {
        tenantIds,
        workspaces: tenantIds.map((tenantId) => {
            const entry = byTenant.get(tenantId)!;
            return { tenantId, kinds: [...entry.kinds].sort(), rows: entry.rows };
        }),
        undecided: undecided.sort((a, b) =>
            `${a.trail}|${a.tenantId ?? ''}|${a.action}`.localeCompare(`${b.trail}|${b.tenantId ?? ''}|${b.action}`),
        ),
        writersWithoutASubjectRow: MEMBERSHIP_WRITERS_WITHOUT_A_SUBJECT_ROW,
    };
}

/** `detailsJson.tenantIds` as a list of non-empty strings, or null when it is not one. */
function fanoutTenantIds(detailsJson: unknown): string[] | null {
    if (detailsJson === null || typeof detailsJson !== 'object' || Array.isArray(detailsJson)) return null;
    const ids = (detailsJson as { tenantIds?: unknown }).tenantIds;
    if (!Array.isArray(ids) || ids.length === 0) return null;
    if (!ids.every((id): id is string => typeof id === 'string' && id.length > 0)) return null;
    return ids;
}

// ─────────────────────────────────────────────────────────────────────────
//  THE READ — bounded and paged
// ─────────────────────────────────────────────────────────────────────────

/** The slice of a client the read needs: raw SELECTs only. */
export interface WorkspaceDiscoveryDb {
    $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
}

export const DISCOVERY_PAGE_SIZE = 500;
export const DISCOVERY_MAX_PAGES = 200;

/**
 * The read could not finish within its bound. Refused, never truncated: a
 * partial tenant set is a clean-up that misses a workspace and reports done.
 */
export class ErasureWorkspaceDiscoveryTruncatedError extends Error {
    constructor(readonly trail: 'AuditLog' | 'OrgAuditLog', readonly bound: number) {
        super(
            `dsar-erasure-workspaces: the ${trail} read for this subject exceeded ${bound} row(s) and was `
                + 'refused rather than truncated: a partial workspace set would leave a workspace uncleaned.',
        );
        this.name = 'ErasureWorkspaceDiscoveryTruncatedError';
    }
}

/**
 * Grouped, so a subject with a long history reads one row per (tenant,
 * action, entity, how it names them) rather than one per audit entry. The
 * three CASE columns keep the subject's id where the row names them and drop
 * every other value, which is also what keeps the grouping small. The
 * `targetUserId` arm is read only under a listed action ($4), so an unrelated
 * row carrying the key (a DSAR transition, a session revocation) is neither
 * read nor grouped.
 *
 * No index serves `userId` or `entityId` alone, so this is a scan of the
 * trail; the erasure's own `findMany({ where: { userId } })` already is.
 */
const AUDIT_EVIDENCE_SQL = `SELECT "tenantId",
       CASE WHEN "userId" = $1 THEN "userId" END AS "userId",
       "entity",
       CASE WHEN "entity" = 'TenantMembership' AND "entityId" = $1 THEN "entityId" END AS "entityId",
       "action",
       CASE WHEN "action" = ANY($4::text[]) AND "detailsJson"->>'targetUserId' = $1 THEN $1 END AS "targetUserId",
       count(*)::int AS "rows"
  FROM "AuditLog"
 WHERE "userId" = $1
    OR ("entity" = 'TenantMembership' AND "entityId" = $1)
    OR ("action" = ANY($4::text[]) AND "detailsJson"->>'targetUserId' = $1)
 GROUP BY 1, 2, 3, 4, 5, 6
 ORDER BY 1, 2 NULLS LAST, 3, 4 NULLS LAST, 5, 6 NULLS LAST
 LIMIT $2 OFFSET $3`;

const ORG_FANOUT_EVIDENCE_SQL = `SELECT "id", "targetUserId", "action"::text AS "action", "detailsJson"
  FROM "OrgAuditLog"
 WHERE "targetUserId" = $1 AND "action"::text = ANY($2::text[])
 ORDER BY "id"
 LIMIT $3 OFFSET $4`;

/**
 * OFFSET paging over a sorted, grouped result. Each page is its own statement,
 * so at READ COMMITTED a group inserted ahead of the offset between two pages
 * could be skipped; one page holds `DISCOVERY_PAGE_SIZE` GROUPS, not rows, so a
 * subject needs that many distinct (tenant, action, entity) groups before a
 * second page is read at all.
 */
async function readPaged<T>(
    trail: 'AuditLog' | 'OrgAuditLog',
    pageSize: number,
    maxPages: number,
    page: (limit: number, offset: number) => Promise<T[]>,
): Promise<T[]> {
    const out: T[] = [];
    for (let n = 0; n < maxPages; n += 1) {
        const rows = await page(pageSize, n * pageSize);
        out.push(...rows);
        if (rows.length < pageSize) return out;
    }
    // Every page came back full. Read one past the bound before refusing, so
    // a set of exactly `pageSize * maxPages` rows is not refused.
    const beyond = await page(1, maxPages * pageSize);
    if (beyond.length === 0) return out;
    throw new ErasureWorkspaceDiscoveryTruncatedError(trail, pageSize * maxPages);
}

/**
 * Read the evidence and decide. Issues SELECTs only. The caller supplies a
 * connection that sees every tenant (`runInGlobalContext`, or the erasure's
 * own transaction, which `planErasure` has already shown is unconstrained):
 * under RLS this would see one tenant's rows and report the rest as absent.
 */
export async function readErasureWorkspaces(
    db: WorkspaceDiscoveryDb,
    subjectId: string,
    options: { pageSize?: number; maxPages?: number } = {},
): Promise<ErasureWorkspaces> {
    if (!subjectId) throw new Error('dsar-erasure-workspaces: a subject id is required.');
    const pageSize = options.pageSize ?? DISCOVERY_PAGE_SIZE;
    const maxPages = options.maxPages ?? DISCOVERY_MAX_PAGES;

    const audit = await readPaged('AuditLog', pageSize, maxPages, (limit, offset) =>
        db.$queryRawUnsafe<AuditEvidenceRow[]>(
            AUDIT_EVIDENCE_SQL,
            subjectId,
            limit,
            offset,
            Object.keys(TARGET_RECORD_ACTIONS),
        ),
    );
    const orgFanout = await readPaged('OrgAuditLog', pageSize, maxPages, (limit, offset) =>
        db.$queryRawUnsafe<OrgFanoutEvidenceRow[]>(
            ORG_FANOUT_EVIDENCE_SQL,
            subjectId,
            [...ORG_TENANT_FANOUT_ACTIONS],
            limit,
            offset,
        ),
    );
    return erasureWorkspacesFrom(subjectId, {
        audit: audit.map((r) => ({ ...r, rows: Number(r.rows ?? 1) })),
        orgFanout,
    });
}
