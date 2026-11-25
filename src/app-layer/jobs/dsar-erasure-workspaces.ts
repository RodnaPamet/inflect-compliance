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
 * clean-up; the operator command `scripts/dsar-erase-user.ts` calls it to
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
 * `MEMBERSHIP_WRITERS_WITHOUT_A_SUBJECT_ROW` lists the membership writers
 * that write no audit row naming the subject at all. A person who joined a
 * workspace only that way, and never acted there, is not found, and no read
 * of the audit trail can find them. The plan reports that list on every
 * read rather than claiming completeness.
 *
 * @module app-layer/jobs/dsar-erasure-workspaces
 */

/** Why a tenant is in the plan. */
export type WorkspaceEvidenceKind = 'OWN_ACTION' | 'MEMBERSHIP_RECORD' | 'ORG_TENANT_FANOUT';

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
 * The allowlisted `TenantMembership` writers (tests/guardrails/no-auto-join)
 * that write NO audit row naming the subject. A workspace joined only through
 * one of these, where the person then never acted, is invisible to this read.
 */
export const MEMBERSHIP_WRITERS_WITHOUT_A_SUBJECT_ROW: readonly string[] = Object.freeze([
    'src/app/api/auth/register/route.ts (credentials self-service signup: tenant + OWNER membership, no audit row)',
    'src/app-layer/usecases/sso.ts (linkExternalIdentity JIT provisioning: user + membership, no audit row)',
    'src/app-layer/usecases/org-tenants.ts (createTenantUnderOrg: the creator\'s OWNER membership, no audit row)',
    'src/app-layer/usecases/org-provisioning.ts (provisionAllOrgAdminsToTenant, the fan-out into a NEW org tenant: no row of either trail)',
    'src/app/api/staging/seed/route.ts (staging-only seed: no audit row)',
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
        if (!ownAction && !namesMembership) continue;
        if (ownAction) add(row.tenantId, 'OWN_ACTION', rows);
        if (!namesMembership) continue;
        if (Object.prototype.hasOwnProperty.call(MEMBERSHIP_RECORD_ACTIONS, row.action)) {
            add(row.tenantId, 'MEMBERSHIP_RECORD', ownAction ? 0 : rows);
        } else if (!ownAction) {
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
 * two CASE columns keep the subject's id where the row names them and drop
 * every other value, which is also what keeps the grouping small.
 *
 * No index serves `userId` or `entityId` alone, so this is a scan of the
 * trail; the erasure's own `findMany({ where: { userId } })` already is.
 */
const AUDIT_EVIDENCE_SQL = `SELECT "tenantId",
       CASE WHEN "userId" = $1 THEN "userId" END AS "userId",
       "entity",
       CASE WHEN "entity" = 'TenantMembership' AND "entityId" = $1 THEN "entityId" END AS "entityId",
       "action",
       count(*)::int AS "rows"
  FROM "AuditLog"
 WHERE "userId" = $1 OR ("entity" = 'TenantMembership' AND "entityId" = $1)
 GROUP BY 1, 2, 3, 4, 5
 ORDER BY 1, 2 NULLS LAST, 3, 4 NULLS LAST, 5
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
        db.$queryRawUnsafe<AuditEvidenceRow[]>(AUDIT_EVIDENCE_SQL, subjectId, limit, offset),
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
