import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';

export class PolicyApprovalRepository {
    static async request(db: PrismaTx, ctx: RequestContext, policyId: string, versionId: string) {
        return db.policyApproval.create({
            data: {
                tenantId: ctx.tenantId,
                policyId,
                policyVersionId: versionId,
                requestedByUserId: ctx.userId,
                status: 'PENDING',
            },
            include: {
                requestedBy: { select: { id: true, name: true } },
                policyVersion: { select: { versionNumber: true } },
            },
        });
    }

    /**
     * Decide a PENDING approval.
     *
     * `status: 'PENDING'` in the WHERE is the concurrency guard, not
     * decoration. The caller checks `status === 'PENDING'` on a prior read,
     * but under READ COMMITTED two concurrent decides can both pass that
     * read and both write — the second silently overwriting the first's
     * decision and approver. Making the UPDATE itself conditional turns the
     * check-then-act into a single atomic claim (same shape as
     * `redeemInvite`), and `count === 0` tells the caller it lost the race.
     *
     * Returns null when the claim was lost, so the caller can distinguish
     * "already decided" from "not found".
     */
    static async decide(db: PrismaTx, ctx: RequestContext, approvalId: string, decision: 'APPROVED' | 'REJECTED', comment?: string) {
        // updateMany so the WHERE can carry the tenantId defence-in-depth
        // filter (Prisma `update` only accepts unique fields in `where`).
        const claimed = await db.policyApproval.updateMany({
            where: { id: approvalId, tenantId: ctx.tenantId, status: 'PENDING' },
            data: {
                status: decision,
                approvedByUserId: ctx.userId,
                decidedAt: new Date(),
                comment,
            },
        });
        if (claimed.count === 0) return null;
        return db.policyApproval.findFirst({
            where: { id: approvalId, tenantId: ctx.tenantId },
            include: {
                policy: { select: { id: true, tenantId: true, title: true } },
                policyVersion: { select: { versionNumber: true } },
                requestedBy: { select: { id: true, name: true } },
                approvedBy: { select: { id: true, name: true } },
            },
        });
    }

    /**
     * @param policyId when supplied, the approval must belong to THIS policy.
     *   The decide route takes both a policy id (from the URL) and an approval
     *   id (from the body) but never related them, so any approval in the
     *   tenant could be decided through any policy's URL — the tenant filter
     *   alone does not make the pair coherent.
     */
    static async getById(db: PrismaTx, ctx: RequestContext, id: string, policyId?: string) {
        return db.policyApproval.findFirst({
            where: { id, tenantId: ctx.tenantId, ...(policyId ? { policyId } : {}) },
            include: {
                // `status` is selected because the caller must refuse to decide
                // an approval whose policy has already moved on (a stale row).
                policy: { select: { id: true, tenantId: true, title: true, status: true } },
                policyVersion: { select: { versionNumber: true } },
            },
        });
    }

    /**
     * The approval that put this policy into APPROVED — the most recently
     * decided one. `publishPolicy` binds the version it publishes to this
     * row's `policyVersionId`.
     */
    static async latestApproved(db: PrismaTx, ctx: RequestContext, policyId: string) {
        return db.policyApproval.findFirst({
            where: { tenantId: ctx.tenantId, policyId, status: 'APPROVED' },
            orderBy: { decidedAt: 'desc' },
            select: { id: true, policyVersionId: true, decidedAt: true },
        });
    }

    /** PENDING approvals for a policy — used for the concurrent-request dedupe. */
    static async findPending(db: PrismaTx, ctx: RequestContext, policyId: string) {
        return db.policyApproval.findMany({
            where: { tenantId: ctx.tenantId, policyId, status: 'PENDING' },
            select: { id: true, policyVersionId: true },
            take: 50,
        });
    }

    /**
     * Resolve every outstanding PENDING approval for a policy — called when a
     * publish settles the question by other means (an emergency bypass, or a
     * republish). Without this the row stays PENDING forever and a later
     * Reject on it would drop a LIVE policy back to DRAFT.
     */
    static async supersedePending(db: PrismaTx, ctx: RequestContext, policyId: string, comment: string) {
        return db.policyApproval.updateMany({
            where: { tenantId: ctx.tenantId, policyId, status: 'PENDING' },
            data: {
                status: 'REJECTED',
                approvedByUserId: ctx.userId,
                decidedAt: new Date(),
                comment,
            },
        });
    }

    static async listPending(db: PrismaTx, ctx: RequestContext) {
        return db.policyApproval.findMany({
            where: {
                tenantId: ctx.tenantId,
                status: 'PENDING',
            },
            orderBy: { createdAt: 'desc' },
            include: {
                policy: { select: { id: true, title: true, slug: true } },
                policyVersion: { select: { versionNumber: true } },
                requestedBy: { select: { id: true, name: true } },
            },
        });
    }
}
