/**
 * Epic G-4 — AccessReview + AccessReviewDecision repository.
 *
 * Every query filters by `tenantId` (defence in depth — RLS already
 * enforces isolation, but the explicit predicate keeps query plans
 * readable and error messages clear when the app layer is correct).
 *
 * The repository deliberately exposes batch operations
 * (`bulkCreateDecisions`) — campaign creation snapshots dozens to
 * thousands of memberships and a per-row create would round-trip
 * the DB the same number of times.
 */
import { Prisma } from '@prisma/client';
import type {
    AccessReviewStatus,
    AccessReviewDecisionType,
    Role,
    MembershipStatus,
} from '@prisma/client';
import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';

// Tight SELECT for list / table views — list pages don't need the
// full decision graph.
const accessReviewListSelect = {
    id: true,
    tenantId: true,
    name: true,
    scope: true,
    status: true,
    periodStartAt: true,
    periodEndAt: true,
    dueAt: true,
    closedAt: true,
    createdAt: true,
    reviewerUserId: true,
    createdByUserId: true,
    _count: { select: { decisions: true } },
} as const;

// SELECT shape for the reviewer page — includes the decision graph
// + every field the table renders (roster, snapshot role, decision).
const accessReviewDetailInclude = {
    reviewer: { select: { id: true, email: true, name: true } },
    createdBy: { select: { id: true, email: true, name: true } },
    closedBy: { select: { id: true, email: true, name: true } },
    /**
     * Step 5a — CONNECTED_APP subjects, which this include did not carry.
     *
     * `AccessReviewDetailClient` renders `review.decisions`, the MEMBER rows.
     * A CONNECTED_APP campaign has none of those — its subjects live in
     * `AccessReviewConnectedDecision` — so the detail page showed a campaign
     * with an empty table and a live Close button, and the only way to see or
     * decide a connected subject was the separate `/connected-decisions`
     * endpoint that no page called. Including them here is what lets the page
     * render the decisions and gate Close on all of them being made.
     *
     * Ordered by `subjectRef` to match `listConnectedDecisions`, so the two
     * surfaces cannot disagree about row order.
     */
    connectedDecisions: {
        orderBy: [{ subjectRef: 'asc' }],
        include: {
            decidedBy: { select: { id: true, email: true, name: true } },
        },
    },
    decisions: {
        orderBy: [{ subjectUserId: 'asc' }],
        include: {
            subjectUser: { select: { id: true, email: true, name: true } },
            decidedBy: { select: { id: true, email: true, name: true } },
            membership: {
                select: {
                    id: true,
                    role: true,
                    status: true,
                    customRoleId: true,
                },
            },
        },
    },
} as const satisfies Prisma.AccessReviewInclude;

// Snapshot input shape — one element per subject membership the
// usecase wants to write into the campaign.
export interface DecisionSnapshotInput {
    membershipId: string | null;
    subjectUserId: string;
    snapshotRole: Role;
    snapshotCustomRoleId: string | null;
    snapshotMembershipStatus: MembershipStatus;
}

export class AccessReviewRepository {
    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        options: {
            take?: number;
            status?: AccessReviewStatus;
            includeDeleted?: boolean;
        } = {},
    ) {
        return db.accessReview.findMany({
            where: {
                tenantId: ctx.tenantId,
                ...(options.includeDeleted ? {} : { deletedAt: null }),
                ...(options.status ? { status: options.status } : {}),
            },
            orderBy: { createdAt: 'desc' },
            select: accessReviewListSelect,
            ...(options.take ? { take: options.take } : {}),
        });
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.accessReview.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            include: accessReviewDetailInclude,
        });
    }

    /**
     * Map subject userId → most recent UserSession.lastActiveAt for
     * this tenant. Returns the empty map when no sessions exist.
     * Used by the review page to surface "last activity date" without
     * a per-user round-trip from the client.
     */
    static async getLastActivityByUser(
        db: PrismaTx,
        ctx: RequestContext,
        userIds: readonly string[],
    ): Promise<Record<string, Date>> {
        if (userIds.length === 0) return {};
        const rows = await db.userSession.groupBy({
            by: ['userId'],
            where: {
                tenantId: ctx.tenantId,
                userId: { in: [...userIds] },
                revokedAt: null,
            },
            _max: { lastActiveAt: true },
        });
        const map: Record<string, Date> = {};
        for (const r of rows) {
            if (r._max.lastActiveAt) {
                map[r.userId] = r._max.lastActiveAt;
            }
        }
        return map;
    }

    static async create(
        db: PrismaTx,
        ctx: RequestContext,
        data: {
            name: string;
            description?: string | null;
            scope: Prisma.AccessReviewUncheckedCreateInput['scope'];
            periodStartAt?: Date | null;
            periodEndAt?: Date | null;
            reviewerUserId: string;
            dueAt?: Date | null;
            /**
             * Step 5a — the subject snapshot was cut off at the cap. Optional
             * because the member flow has no cap to hit; defaults false, which
             * is the truthful value for a campaign that enumerated everything.
             */
            snapshotTruncated?: boolean;
        },
    ) {
        return db.accessReview.create({
            data: {
                tenantId: ctx.tenantId,
                name: data.name,
                description: data.description ?? null,
                scope: data.scope,
                periodStartAt: data.periodStartAt ?? null,
                periodEndAt: data.periodEndAt ?? null,
                reviewerUserId: data.reviewerUserId,
                dueAt: data.dueAt ?? null,
                snapshotTruncated: data.snapshotTruncated ?? false,
                createdByUserId: ctx.userId,
            },
            select: accessReviewListSelect,
        });
    }

    /**
     * Snapshot subject memberships into AccessReviewDecision rows.
     *
     * `createMany` is a single round-trip and `skipDuplicates: true`
     * makes the operation idempotent against the
     * (accessReviewId, subjectUserId) unique constraint — re-snapshotting
     * the same campaign is a safe no-op. Returns the count of rows
     * inserted (Prisma's createMany contract).
     */
    static async bulkCreateDecisions(
        db: PrismaTx,
        ctx: RequestContext,
        accessReviewId: string,
        rows: readonly DecisionSnapshotInput[],
    ): Promise<number> {
        if (rows.length === 0) return 0;
        const result = await db.accessReviewDecision.createMany({
            data: rows.map((r) => ({
                tenantId: ctx.tenantId,
                accessReviewId,
                membershipId: r.membershipId,
                subjectUserId: r.subjectUserId,
                snapshotRole: r.snapshotRole,
                snapshotCustomRoleId: r.snapshotCustomRoleId,
                snapshotMembershipStatus: r.snapshotMembershipStatus,
            })),
            skipDuplicates: true,
        });
        return result.count;
    }

    static async getDecision(db: PrismaTx, ctx: RequestContext, decisionId: string) {
        return db.accessReviewDecision.findFirst({
            where: { id: decisionId, tenantId: ctx.tenantId },
            include: {
                accessReview: {
                    select: {
                        id: true,
                        tenantId: true,
                        status: true,
                        reviewerUserId: true,
                        deletedAt: true,
                    },
                },
            },
        });
    }

    static async updateDecision(
        db: PrismaTx,
        ctx: RequestContext,
        decisionId: string,
        data: {
            decision: AccessReviewDecisionType;
            decidedAt: Date;
            decidedByUserId: string;
            notes?: string | null;
            modifiedToRole?: Role | null;
            modifiedToCustomRoleId?: string | null;
        },
    ) {
        // updateMany scoped by tenantId so a stale id from another
        // tenant cannot mutate a foreign row even if RLS were bypassed
        // somehow upstream. Returns count for caller-side optimistic-
        // concurrency check (count === 0 ⇒ row missing or wrong tenant).
        const r = await db.accessReviewDecision.updateMany({
            where: { id: decisionId, tenantId: ctx.tenantId },
            data: {
                decision: data.decision,
                decidedAt: data.decidedAt,
                decidedByUserId: data.decidedByUserId,
                notes: data.notes ?? null,
                modifiedToRole: data.modifiedToRole ?? null,
                modifiedToCustomRoleId: data.modifiedToCustomRoleId ?? null,
            },
        });
        return r.count;
    }

    /**
     * Reset a previously-submitted decision back to pending. The
     * row stays in place (snapshot fields preserved) but the
     * verdict + reviewer fields go null. Only callable while the
     * campaign is OPEN / IN_REVIEW and the decision is not yet
     * executed — the usecase enforces both gates before calling.
     *
     * (Audit Coherence S7, 2026-05-24)
     */
    static async resetDecision(
        db: PrismaTx,
        ctx: RequestContext,
        decisionId: string,
    ) {
        const r = await db.accessReviewDecision.updateMany({
            where: {
                id: decisionId,
                tenantId: ctx.tenantId,
                // Executed rows are immutable — campaign is closed
                // or the row was executed by closeout. Refuse here
                // so the count===0 caller path surfaces a notFound
                // instead of silently undoing an audit-evidentiary
                // write.
                executedAt: null,
            },
            data: {
                decision: null,
                decidedAt: null,
                decidedByUserId: null,
                notes: null,
                modifiedToRole: null,
                modifiedToCustomRoleId: null,
            },
        });
        return r.count;
    }

    static async setReviewStatus(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        status: AccessReviewStatus,
    ) {
        const r = await db.accessReview.updateMany({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            data: { status },
        });
        return r.count;
    }

    /**
     * Mark a campaign CLOSED + record the closer + (optionally) link
     * the evidence FileRecord. Two-phase callers (close first, attach
     * evidence later) leave `evidenceFileRecordId` undefined on the
     * first call and update it in a follow-up.
     */
    static async closeCampaign(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        closedAt: Date,
        evidenceFileRecordId?: string | null,
    ) {
        // NOTE: this is intentionally unconditional — the member close flow
        // (Epic G-4) calls it twice (flip status, then attach
        // evidenceFileRecordId after PDF generation). The connected-flow TOCTOU
        // guard lives in `closeConnectedAccessReview` via a conditional status
        // claim, so it does not depend on this shared method's predicate.
        const r = await db.accessReview.updateMany({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            data: {
                status: 'CLOSED',
                closedAt,
                closedByUserId: ctx.userId,
                ...(evidenceFileRecordId !== undefined
                    ? { evidenceFileRecordId }
                    : {}),
            },
        });
        return r.count;
    }

    /**
     * Mark a single decision row as executed. Both fields are set
     * together so the `_executed_pair` CHECK constraint is satisfied.
     */
    static async markDecisionExecuted(
        db: PrismaTx,
        ctx: RequestContext,
        decisionId: string,
        executedAt: Date,
    ) {
        const r = await db.accessReviewDecision.updateMany({
            where: { id: decisionId, tenantId: ctx.tenantId },
            data: {
                executedAt,
                executedByUserId: ctx.userId,
            },
        });
        return r.count;
    }

    /**
     * Fetch every decision in a campaign in a shape suitable for the
     * closeout executor (each row carries the snapshot fields, the
     * verdict, and the live membership it should mutate).
     */
    static async getDecisionsForExecution(
        db: PrismaTx,
        ctx: RequestContext,
        accessReviewId: string,
    ) {
        return db.accessReviewDecision.findMany({
            where: { accessReviewId, tenantId: ctx.tenantId },
            select: {
                id: true,
                membershipId: true,
                subjectUserId: true,
                snapshotRole: true,
                snapshotMembershipStatus: true,
                decision: true,
                modifiedToRole: true,
                modifiedToCustomRoleId: true,
                executedAt: true,
                /// Joined live membership state. SetNull cascade means
                /// this can be `null` if the user has been offboarded
                /// outside the campaign — the executor skips with a
                /// "stale subject" audit annotation.
                membership: {
                    select: {
                        id: true,
                        userId: true,
                        role: true,
                        status: true,
                    },
                },
                subjectUser: {
                    select: { id: true, email: true, name: true },
                },
            },
        });
    }

    /**
     * Resolve the membership population for a campaign's snapshot
     * step. ALL_USERS / ADMIN_ONLY enumerate from TenantMembership;
     * CUSTOM accepts a curated list of membership IDs.
     *
     * Always filters tenantId and excludes DEACTIVATED / REMOVED
     * memberships so a campaign doesn't accidentally include rows
     * the tenant has already retired.
     */
    static async resolveMembershipsForScope(
        db: PrismaTx,
        ctx: RequestContext,
        scope: Prisma.AccessReviewUncheckedCreateInput['scope'],
        customMembershipIds?: readonly string[],
    ) {
        const where: Prisma.TenantMembershipWhereInput = {
            tenantId: ctx.tenantId,
            // Reviewing a never-active or already-removed membership
            // is wasted reviewer time — and the snapshot rows would
            // immediately be moot. INVITED + ACTIVE are the only
            // states a reviewer can do anything useful with.
            status: { in: ['ACTIVE', 'INVITED'] },
        };
        if (scope === 'ADMIN_ONLY') {
            where.role = { in: ['OWNER', 'ADMIN'] };
        } else if (scope === 'CUSTOM') {
            where.id = { in: [...(customMembershipIds ?? [])] };
        }
        return db.tenantMembership.findMany({
            where,
            select: {
                id: true,
                userId: true,
                role: true,
                status: true,
                customRoleId: true,
            },
        });
    }
}
