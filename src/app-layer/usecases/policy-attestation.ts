/**
 * Policy attestation — Audit Coherence S4 (2026-05-22).
 *
 * ISO 27001 §7.3 requires evidence that personnel have acknowledged
 * policies. The `PolicyAcknowledgement` model existed in the schema
 * but had no operational surface — no usecase, no API. This module
 * provides:
 *
 *   - `attestPolicy(ctx, policyId)` — current user records that they
 *     have read + accepted the policy's currently-published version.
 *     Idempotent on the `(policyVersionId, userId)` unique constraint.
 *   - `getPolicyAttestation(ctx, policyId, userId?)` — has the user
 *     attested the current version? Returns the row or null.
 *   - `getPolicyAcknowledgementRoster(ctx, policyId)` — admin/audit
 *     roster: who was required, who acknowledged the current version
 *     (stale acks excluded), provenance, and the "who attested" log.
 *
 * Only PUBLISHED policies can be attested; attesting a DRAFT or
 * ARCHIVED version doesn't satisfy the ISO control.
 */
import { z } from 'zod';
import { Role } from '@prisma/client';
import { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanRead, assertCanAdmin } from '../policies/common';
import { logEvent } from '../events/audit';
import { notFound, badRequest } from '@/lib/errors/types';
import { PolicyRepository } from '../repositories/PolicyRepository';

export interface AttestPolicyResult {
    acknowledgementId: string;
    policyVersionId: string;
    userId: string;
    acknowledgedAt: Date;
    /** True if this call created a new row; false if the user had already attested. */
    created: boolean;
}

/**
 * Record an attestation for the current user against the policy's
 * currently-published version.
 *
 * Authorization — any tenant member can attest a policy they have
 * read access to (`assertCanRead`). Attestation is a "I have read
 * this" gesture — not a privileged write.
 *
 * Idempotency: the schema's `@@unique([policyVersionId, userId])`
 * means a second call returns the existing row with `created: false`.
 */
/**
 * Read EVERY row matching a version-scoped assignment/acknowledgement query.
 *
 * These lists back a COMPLIANCE roster: a flat `take` silently drops people
 * past the cap, so the roster under-reports who still owes an acknowledgement
 * and over-reports percent-complete. Cursor-paginated on `userId` (covered by
 * the `(policyVersionId, userId)` composite unique), so the walk is
 * index-backed and stable while rows are being inserted underneath it.
 */
async function readAllByUser<T extends { userId: string }>(
    page: (cursorUserId: string | null, take: number) => Promise<T[]>,
): Promise<T[]> {
    const PAGE = 1000;
    const out: T[] = [];
    let cursor: string | null = null;
    for (;;) {
        const rows = await page(cursor, PAGE);
        out.push(...rows);
        if (rows.length < PAGE) break;
        cursor = rows[rows.length - 1].userId;
    }
    return out;
}

export async function attestPolicy(
    ctx: RequestContext,
    policyId: string,
): Promise<AttestPolicyResult> {
    assertCanRead(ctx);

    return runInTenantContext(ctx, async (db) => {
        const policy = await PolicyRepository.getById(db, ctx, policyId);
        if (!policy) throw notFound('Policy not found');

        if (policy.status !== 'PUBLISHED') {
            throw badRequest(
                `Only PUBLISHED policies can be attested. ${policyId} is ${policy.status}.`,
            );
        }
        if (!policy.currentVersionId) {
            throw badRequest(
                'Policy is PUBLISHED but has no currentVersionId — administrator must re-publish.',
            );
        }

        // Idempotent upsert via the (policyVersionId, userId) unique.
        const existing = await db.policyAcknowledgement.findUnique({
            where: {
                policyVersionId_userId: {
                    policyVersionId: policy.currentVersionId,
                    userId: ctx.userId,
                },
            },
        });
        if (existing) {
            return {
                acknowledgementId: existing.id,
                policyVersionId: existing.policyVersionId,
                userId: existing.userId,
                acknowledgedAt: existing.acknowledgedAt,
                created: false,
            };
        }

        const row = await db.policyAcknowledgement.create({
            data: {
                policyVersionId: policy.currentVersionId,
                userId: ctx.userId,
            },
        });

        await logEvent(db, ctx, {
            action: 'POLICY_ATTESTED',
            entityType: 'Policy',
            entityId: policyId,
            details: `User attested policy version ${policy.currentVersionId}`,
            detailsJson: {
                category: 'access',
                entityName: 'Policy',
                summary: `User ${ctx.userId} attested policy ${policyId}`,
                after: {
                    policyVersionId: policy.currentVersionId,
                    userId: ctx.userId,
                },
            },
        });

        return {
            acknowledgementId: row.id,
            policyVersionId: row.policyVersionId,
            userId: row.userId,
            acknowledgedAt: row.acknowledgedAt,
            created: true,
        };
    });
}

/**
 * Get a single user's attestation status for the policy's current
 * version. `userId` defaults to the caller; passing a different
 * userId requires admin authority (an admin checking who has /
 * hasn't attested).
 */
export async function getPolicyAttestation(
    ctx: RequestContext,
    policyId: string,
    userId?: string,
) {
    assertCanRead(ctx);
    const targetUserId = userId ?? ctx.userId;
    if (targetUserId !== ctx.userId) {
        assertCanAdmin(ctx);
    }

    return runInTenantContext(ctx, async (db) => {
        const policy = await PolicyRepository.getById(db, ctx, policyId);
        if (!policy) throw notFound('Policy not found');
        if (!policy.currentVersionId) return null;

        return db.policyAcknowledgement.findUnique({
            where: {
                policyVersionId_userId: {
                    policyVersionId: policy.currentVersionId,
                    userId: targetUserId,
                },
            },
        });
    });
}

// The former standalone `listPolicyAttestations` (a flat "who attested the
// current version" list) was orphaned — no route ever called it. Its data is
// now surfaced through `getPolicyAcknowledgementRoster().attestations` (the
// auditor log), which the acknowledgements panel renders, so the auditor
// "who has attested" view is reachable without a second round-trip.

// ─── Required-acknowledgement campaign (assign + roster) ─────────────────

/**
 * Audience for a required-acknowledgement campaign. `all` targets every active
 * member; `role` targets active members holding a role; `users` targets a named
 * list (intersected with active membership so a stale id can't be assigned).
 */
export const RequireAcknowledgementSchema = z.object({
    audience: z.discriminatedUnion('type', [
        z.object({ type: z.literal('all') }),
        z.object({ type: z.literal('role'), role: z.nativeEnum(Role) }),
        z.object({ type: z.literal('users'), userIds: z.array(z.string().min(1)).min(1).max(2000) }),
    ]),
});
export type RequireAcknowledgementInput = z.infer<typeof RequireAcknowledgementSchema>;

export interface RequireAcknowledgementResult {
    policyVersionId: string;
    assignedCount: number;
}

/**
 * Require a set of users to acknowledge the policy's currently-published
 * version. Admin-only. Idempotent — re-running skips users already assigned to
 * this version (`skipDuplicates`). Assignees get an in-app notification.
 */
export async function requirePolicyAcknowledgement(
    ctx: RequestContext,
    policyId: string,
    input: RequireAcknowledgementInput,
): Promise<RequireAcknowledgementResult> {
    assertCanAdmin(ctx);
    const { audience } = RequireAcknowledgementSchema.parse(input);

    return runInTenantContext(ctx, async (db) => {
        const policy = await PolicyRepository.getById(db, ctx, policyId);
        if (!policy) throw notFound('Policy not found');
        if (policy.status !== 'PUBLISHED') {
            throw badRequest(`Only PUBLISHED policies can require acknowledgement. ${policyId} is ${policy.status}.`);
        }
        if (!policy.currentVersionId) {
            throw badRequest('Policy is PUBLISHED but has no currentVersionId — administrator must re-publish.');
        }
        const policyVersionId = policy.currentVersionId;

        // Resolve the audience to a set of ACTIVE member userIds (a named list
        // is intersected with membership so a stale/foreign id is dropped).
        const members = await db.tenantMembership.findMany({
            where: {
                tenantId: ctx.tenantId,
                status: 'ACTIVE',
                ...(audience.type === 'role' ? { role: audience.role } : {}),
                ...(audience.type === 'users' ? { userId: { in: audience.userIds } } : {}),
            },
            select: { userId: true },
        });
        const userIds = [...new Set(members.map((m) => m.userId))];

        if (userIds.length === 0) {
            throw badRequest('The selected audience resolved to zero active members.');
        }

        await db.policyAcknowledgementAssignment.createMany({
            data: userIds.map((userId) => ({ policyVersionId, userId, assignedById: ctx.userId })),
            skipDuplicates: true,
        });

        // Notify each assignee (best-effort — a notification failure must not
        // fail the assignment). dedupeKey keeps a re-run from double-notifying.
        const title = `Action required: acknowledge "${policy.title}"`;
        const message = `You have been asked to read and acknowledge the policy "${policy.title}".`;
        for (const userId of userIds) {
            await db.notification
                .create({
                    data: {
                        tenantId: ctx.tenantId,
                        userId,
                        type: 'GENERAL',
                        title,
                        message,
                        linkUrl: `/policies/${policyId}`,
                        dedupeKey: `POLICY_ACK_REQUIRED:${policyVersionId}:${userId}`,
                    },
                })
                .catch(() => {
                    /* dedupe collision / notification failure must not fail dispatch */
                });
        }

        await logEvent(db, ctx, {
            action: 'POLICY_ACK_REQUESTED',
            entityType: 'Policy',
            entityId: policyId,
            details: `Required acknowledgement of policy version ${policyVersionId} from ${userIds.length} user(s)`,
            detailsJson: {
                category: 'access',
                entityName: 'Policy',
                summary: `Required acknowledgement of "${policy.title}" from ${userIds.length} user(s)`,
                after: { policyVersionId, audienceType: audience.type, assignedCount: userIds.length },
            },
        });

        return { policyVersionId, assignedCount: userIds.length };
    });
}

/**
 * Per-user acknowledgement status for the CURRENT published version.
 *   - ACKNOWLEDGED            — acknowledged the current version (compliant).
 *   - ACKNOWLEDGED_SUPERSEDED — acknowledged an EARLIER version but not the
 *                               current one; a stale ack that must NOT read as
 *                               compliant (they owe a fresh acknowledgement).
 *   - OUTSTANDING             — never acknowledged any version.
 */
export type AcknowledgementStatus = 'ACKNOWLEDGED' | 'ACKNOWLEDGED_SUPERSEDED' | 'OUTSTANDING';

export interface AcknowledgementRosterEntry {
    userId: string;
    name: string | null;
    email: string | null;
    /** True when this user was REQUIRED to acknowledge (has an assignment). */
    required: boolean;
    /** When they acknowledged the CURRENT version, or null if not (outstanding or stale). */
    acknowledgedAt: Date | null;
    /** Status against the current version — stale acks read as non-compliant. */
    status: AcknowledgementStatus;
    /** When they acknowledged a SUPERSEDED version (informational), else null. */
    supersededAckAt: Date | null;
    /** Provenance — who requested this user's acknowledgement, and when. */
    assignedById: string | null;
    assignedByName: string | null;
    assignedAt: Date | null;
}

/** Flat auditor "who has attested the current version" log entry. */
export interface AttestationLogEntry {
    userId: string;
    name: string | null;
    email: string | null;
    acknowledgedAt: Date;
}

export interface AcknowledgementRoster {
    policyVersionId: string | null;
    assignedCount: number;
    /** REQUIRED users who acknowledged the CURRENT version (stale acks excluded). */
    acknowledgedCount: number;
    /** % of REQUIRED users who have acknowledged the current version. */
    pctComplete: number;
    entries: AcknowledgementRosterEntry[];
    /** Auditor log: everyone who has attested the current version, newest first. */
    attestations: AttestationLogEntry[];
}

/**
 * Admin roster for the current published version: who was required to
 * acknowledge, who has (with timestamps), % complete, and voluntary
 * acknowledgers (acknowledged without being assigned). Admin/audit only.
 */
export async function getPolicyAcknowledgementRoster(
    ctx: RequestContext,
    policyId: string,
): Promise<AcknowledgementRoster> {
    assertCanAdmin(ctx);

    return runInTenantContext(ctx, async (db) => {
        const policy = await PolicyRepository.getById(db, ctx, policyId);
        if (!policy) throw notFound('Policy not found');
        if (!policy.currentVersionId) {
            return { policyVersionId: null, assignedCount: 0, acknowledgedCount: 0, pctComplete: 0, entries: [], attestations: [] };
        }
        const policyVersionId = policy.currentVersionId;

        // All version ids for this policy — the SUPERSEDED ones let us
        // distinguish a stale ack (acknowledged an earlier version) from a
        // genuinely-current one, so stale acks don't read as compliant.
        const versions = await db.policyVersion.findMany({ where: { policyId }, select: { id: true } });
        const priorVersionIds = versions.map((v) => v.id).filter((id) => id !== policyVersionId);

        const [assignments, acknowledgements] = await Promise.all([
            readAllByUser((cursor, take) =>
                db.policyAcknowledgementAssignment.findMany({
                    where: { policyVersionId, ...(cursor ? { userId: { gt: cursor } } : {}) },
                    select: { userId: true, assignedById: true, assignedAt: true },
                    orderBy: { userId: 'asc' },
                    take,
                }),
            ),
            readAllByUser((cursor, take) =>
                db.policyAcknowledgement.findMany({
                    where: { policyVersionId, ...(cursor ? { userId: { gt: cursor } } : {}) },
                    select: { userId: true, acknowledgedAt: true },
                    orderBy: { userId: 'asc' },
                    take,
                }),
            ),
        ]);

        const assignedUserIds = new Set(assignments.map((a) => a.userId));
        const assignmentByUser = new Map(assignments.map((a) => [a.userId, a]));
        const ackByUser = new Map(acknowledgements.map((a) => [a.userId, a.acknowledgedAt]));

        // For assigned users WITHOUT a current-version ack, look up whether they
        // acknowledged a superseded version (informational; still non-compliant).
        const outstandingIds = [...assignedUserIds].filter((id) => !ackByUser.has(id));
        const supersededAckByUser = new Map<string, Date>();
        if (priorVersionIds.length > 0 && outstandingIds.length > 0) {
            // `distinct` rather than a flat cap: the loop below only ever
            // keeps the FIRST (most recent) row per user, so asking the
            // database for one row per user says exactly that — and makes
            // `take` precisely bounded by the input set instead of a
            // guessed 5000 that could silently drop users.
            const priorAcks = await db.policyAcknowledgement.findMany({
                where: { policyVersionId: { in: priorVersionIds }, userId: { in: outstandingIds } },
                select: { userId: true, acknowledgedAt: true },
                orderBy: { acknowledgedAt: 'desc' },
                distinct: ['userId'],
                take: outstandingIds.length,
            });
            for (const a of priorAcks) {
                if (!supersededAckByUser.has(a.userId)) supersededAckByUser.set(a.userId, a.acknowledgedAt);
            }
        }

        // Union of required + voluntary acknowledgers + assigners → display info.
        const allUserIds = [...new Set([...assignedUserIds, ...ackByUser.keys()])];
        const lookupIds = [...new Set([...allUserIds, ...assignments.map((a) => a.assignedById)])];
        const users = lookupIds.length
            ? await db.user.findMany({ where: { id: { in: lookupIds } }, select: { id: true, name: true, email: true } })
            : [];
        const userById = new Map(users.map((u) => [u.id, u]));

        const entries: AcknowledgementRosterEntry[] = allUserIds.map((userId) => {
            const currentAck = ackByUser.get(userId) ?? null;
            const supersededAckAt = supersededAckByUser.get(userId) ?? null;
            const status: AcknowledgementStatus = currentAck
                ? 'ACKNOWLEDGED'
                : supersededAckAt
                    ? 'ACKNOWLEDGED_SUPERSEDED'
                    : 'OUTSTANDING';
            const assignment = assignmentByUser.get(userId);
            return {
                userId,
                name: userById.get(userId)?.name ?? null,
                email: userById.get(userId)?.email ?? null,
                required: assignedUserIds.has(userId),
                acknowledgedAt: currentAck,
                status,
                supersededAckAt,
                assignedById: assignment?.assignedById ?? null,
                assignedByName: assignment ? (userById.get(assignment.assignedById)?.name ?? null) : null,
                assignedAt: assignment?.assignedAt ?? null,
            };
        });
        // Outstanding/stale (required, not current-acked) first, then acknowledged.
        entries.sort((a, b) => {
            const aOut = a.required && !a.acknowledgedAt ? 0 : 1;
            const bOut = b.required && !b.acknowledgedAt ? 0 : 1;
            if (aOut !== bOut) return aOut - bOut;
            return (a.email ?? '').localeCompare(b.email ?? '');
        });

        const assignedCount = assignedUserIds.size;
        // Stale (superseded) acks are excluded — only a CURRENT-version ack counts.
        const acknowledgedCount = [...assignedUserIds].filter((id) => ackByUser.has(id)).length;
        const pctComplete = assignedCount > 0 ? Math.round((acknowledgedCount / assignedCount) * 100) : 0;

        // Auditor log — everyone who attested the current version, newest first.
        const attestations: AttestationLogEntry[] = [...acknowledgements]
            .sort((a, b) => b.acknowledgedAt.getTime() - a.acknowledgedAt.getTime())
            .map((a) => ({
                userId: a.userId,
                name: userById.get(a.userId)?.name ?? null,
                email: userById.get(a.userId)?.email ?? null,
                acknowledgedAt: a.acknowledgedAt,
            }));

        return { policyVersionId, assignedCount, acknowledgedCount, pctComplete, entries, attestations };
    });
}
