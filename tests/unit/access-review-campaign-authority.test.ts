/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles that stand
 * in for a Prisma client; the file-level disable is this repo's standard for
 * the shape. */
/**
 * What a member access-review campaign may do to a membership (#3727, owner
 * decisions of 2026-10-18).
 *
 * Closing a campaign writes its decisions under `access_reviews.close`, which
 * an ADMIN holds, so before #3727 a campaign was a side door around the members
 * page's OWNER-tier rules: an ADMIN could MODIFY themselves to OWNER and close
 * it, demote or revoke an OWNER, or hand a member a custom role without the
 * grant check. Now:
 *
 *   1. a campaign never promotes anyone to OWNER — refused at the schema and
 *      at close, `CAMPAIGN_NEVER_PROMOTES_TO_OWNER`;
 *   2. lowering an OWNER (REVOKE, or MODIFY) needs a closer holding
 *      `admin.owner_management` — `OWNER_SUBJECT_NEEDS_OWNER_CLOSER`, and the
 *      last-OWNER guard still applies to the closer who may;
 *   3. a MODIFY sets a built-in role only — `CAMPAIGN_MODIFY_SETS_NO_CUSTOM_ROLE`
 *      at the schema and at close.
 *
 * A decision stored before the rule (an open campaign) is refused at close,
 * never applied and never dropped, and every named refusal writes an audit row.
 * The real-database, two-tenant proof is
 * `tests/integration/access-review-campaign-authority.test.ts`.
 */
jest.mock('@/lib/db-context', () => ({ runInTenantContext: jest.fn() }));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

import { NextRequest } from 'next/server';
import { ZodError } from 'zod';

import { makeRequestContext } from '../helpers/make-context';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '@/app-layer/events/audit';
import { CAMPAIGN_MODIFY_ROLES, TENANT_ROLES, BUILT_IN_SCOPE_REFUSAL } from '@/lib/roles';
import { MEMBER_DECISION_REFUSAL } from '@/lib/access-review/member-decision-rules';
import { SubmitDecisionSchema } from '@/app-layer/schemas/access-review.schemas';
import { closeAccessReview, revokeDecision, submitDecision } from '@/app-layer/usecases/access-review';

const mockRunInTx = runInTenantContext as jest.MockedFunction<any>;
const owner = () => makeRequestContext('OWNER', { tenantId: 'tenant-1', userId: 'owner-1' });
const admin = () => makeRequestContext('ADMIN', { tenantId: 'tenant-1', userId: 'admin-1' });

const auditActions = () => (logEvent as jest.Mock).mock.calls.map((c) => c[2].action);
const refusalAudit = (action: string) => (logEvent as jest.Mock).mock.calls.find((c) => c[2].action === action)?.[2];

beforeEach(() => {
    jest.clearAllMocks();
    mockRunInTx.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}));
});

// ─── SUBMISSION ─────────────────────────────────────────────────────

describe('SubmitDecisionSchema — what a MODIFY may name', () => {
    const reasonsOf = (body: Record<string, unknown>) => {
        const r = SubmitDecisionSchema.safeParse({ decision: 'MODIFY', ...body });
        return r.success ? [] : r.error.issues.map((i) => (i as { params?: { reason?: string } }).params?.reason ?? i.code);
    };

    it('MODIFY to OWNER is refused BY NAME, not as an unknown value', () => {
        expect(reasonsOf({ modifiedToRole: 'OWNER' })).toEqual([MEMBER_DECISION_REFUSAL.NEVER_PROMOTES_TO_OWNER]);
        const r = SubmitDecisionSchema.safeParse({ decision: 'MODIFY', modifiedToRole: 'OWNER' });
        expect(r.success ? '' : r.error.issues[0].message).toMatch(/^CAMPAIGN_NEVER_PROMOTES_TO_OWNER: /);
    });

    it('a MODIFY carrying a custom role is refused by name, whatever the role; none (null) is accepted', () => {
        for (const role of CAMPAIGN_MODIFY_ROLES) {
            expect(reasonsOf({ modifiedToRole: role, modifiedToCustomRoleId: 'cr-1' })).toEqual([
                MEMBER_DECISION_REFUSAL.MODIFY_SETS_NO_CUSTOM_ROLE,
            ]);
            expect(reasonsOf({ modifiedToRole: role, modifiedToCustomRoleId: null })).toEqual([]);
            expect(reasonsOf({ modifiedToRole: role })).toEqual([]);
        }
        expect(reasonsOf({ modifiedToRole: 'READER', modifiedToCustomRoleId: '' })).toEqual([
            MEMBER_DECISION_REFUSAL.MODIFY_SETS_NO_CUSTOM_ROLE,
        ]);
    });

    it('the roles a MODIFY may set are every built-in role except OWNER and AI_ADMIN', () => {
        expect([...CAMPAIGN_MODIFY_ROLES].sort()).toEqual(
            TENANT_ROLES.filter((r) => r !== 'OWNER' && r !== 'AI_ADMIN').sort(),
        );
        // AI_ADMIN stays an enum refusal (#3699) — unchanged by #3727.
        expect(SubmitDecisionSchema.safeParse({ decision: 'MODIFY', modifiedToRole: 'AI_ADMIN' }).success).toBe(false);
    });
});

describe('submitDecision — a named refusal writes an audit row, and nothing else', () => {
    it('MODIFY to OWNER: the ZodError is thrown and ACCESS_REVIEW_DECISION_REFUSED is audited; no decision is read', async () => {
        const db = { accessReviewDecision: { findFirst: jest.fn(), updateMany: jest.fn() } };
        mockRunInTx.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(db));
        const err = await submitDecision(admin(), 'd-1', { decision: 'MODIFY', modifiedToRole: 'OWNER' }).catch((e) => e);
        expect(err).toBeInstanceOf(ZodError);
        expect(refusalAudit('ACCESS_REVIEW_DECISION_REFUSED')).toMatchObject({
            entityType: 'AccessReviewDecision',
            entityId: 'd-1',
            detailsJson: expect.objectContaining({
                category: 'access',
                after: { reason: MEMBER_DECISION_REFUSAL.NEVER_PROMOTES_TO_OWNER },
            }),
        });
        expect(db.accessReviewDecision.findFirst).not.toHaveBeenCalled();
        expect(db.accessReviewDecision.updateMany).not.toHaveBeenCalled();
    });

    it('an unnamed validation failure (no decision at all) is a plain 400 and writes no refusal row', async () => {
        await expect(submitDecision(admin(), 'd-1', { decision: 'MODIFY' })).rejects.toBeInstanceOf(ZodError);
        expect(auditActions()).toEqual([]);
    });

    it('an accepted MODIFY stores no custom role', async () => {
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        const db = {
            accessReviewDecision: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'd-1',
                    decision: null,
                    subjectUserId: 'u-1',
                    accessReview: { id: 'ar-1', tenantId: 'tenant-1', status: 'IN_REVIEW', reviewerUserId: 'admin-1', deletedAt: null },
                }),
                updateMany,
            },
            accessReview: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        };
        mockRunInTx.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(db));
        await submitDecision(admin(), 'd-1', { decision: 'MODIFY', modifiedToRole: 'READER', modifiedToCustomRoleId: null });
        expect(updateMany.mock.calls[0][0].data).toMatchObject({ modifiedToRole: 'READER', modifiedToCustomRoleId: null });
    });

    it('the decision route refuses it with a 400 and audits it exactly once', async () => {
        getTenantCtxMock.mockResolvedValue(admin());
        const { PUT } = (await import('@/app/api/t/[tenantSlug]/access-reviews/[reviewId]/decisions/[decisionId]/route')) as {
            PUT: (r: NextRequest, a: unknown) => Promise<Response>;
        };
        const res = await PUT(
            new NextRequest('http://localhost/api/t/acme/access-reviews/ar-1/decisions/d-1', {
                method: 'PUT',
                headers: new Headers({ 'content-type': 'application/json' }),
                body: JSON.stringify({ decision: 'MODIFY', modifiedToRole: 'OWNER' }),
            }),
            { params: Promise.resolve({ tenantSlug: 'acme', reviewId: 'ar-1', decisionId: 'd-1' }) },
        );
        expect(res.status).toBe(400);
        expect(JSON.stringify(await res.json())).toContain(MEMBER_DECISION_REFUSAL.NEVER_PROMOTES_TO_OWNER);
        expect(auditActions()).toEqual(['ACCESS_REVIEW_DECISION_REFUSED']);
    });
});

// ─── CLOSE ──────────────────────────────────────────────────────────

/** A stored decision, as `getDecisionsForExecution` returns it. */
function stored(
    id: string,
    decision: 'CONFIRM' | 'REVOKE' | 'MODIFY',
    live: { role: string; customRoleId?: string | null } | null,
    modify: { modifiedToRole?: string | null; modifiedToCustomRoleId?: string | null } = {},
) {
    return {
        id,
        membershipId: live ? `m-${id}` : null,
        subjectUserId: `u-${id}`,
        snapshotRole: live?.role ?? 'READER',
        snapshotMembershipStatus: 'ACTIVE',
        decision,
        modifiedToRole: modify.modifiedToRole ?? null,
        modifiedToCustomRoleId: modify.modifiedToCustomRoleId ?? null,
        executedAt: null,
        membership: live
            ? { id: `m-${id}`, userId: `u-${id}`, status: 'ACTIVE', customRoleId: null, ...live }
            : null,
        subjectUser: { id: `u-${id}`, email: `${id}@x`, name: null },
    };
}

const REACHED_OWNER_COUNT = new Error('every #3727 check passed: the close reached the last-OWNER count');

/**
 * A campaign holding `decisions`. The live-OWNER read that follows every
 * #3727 check throws a sentinel, so "not refused" is observable without
 * running the rest of the close; `liveOwners` lets a test run past it instead.
 */
function campaignDb(decisions: unknown[], liveOwners?: Array<{ id: string; userId: string }>) {
    const db = {
        accessReview: {
            findFirst: jest.fn().mockResolvedValue({
                id: 'ar-1',
                tenantId: 'tenant-1',
                name: 'Q4',
                scope: 'ALL_USERS',
                status: 'IN_REVIEW',
                deletedAt: null,
                reviewer: { email: 'r@x' },
                createdBy: { email: 'c@x' },
            }),
        },
        accessReviewDecision: { findMany: jest.fn().mockResolvedValue(decisions) },
        tenantMembership: {
            findMany: liveOwners
                ? jest.fn().mockResolvedValue(liveOwners)
                : jest.fn().mockRejectedValue(REACHED_OWNER_COUNT),
            update: jest.fn(),
        },
    };
    mockRunInTx.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(db));
    return db;
}

describe('closeAccessReview — a stored decision that is now refused refuses the whole close, by name, audited', () => {
    it.each([
        [
            'a MODIFY to OWNER (rule 1)',
            stored('d-1', 'MODIFY', { role: 'EDITOR' }, { modifiedToRole: 'OWNER' }),
            409,
            MEMBER_DECISION_REFUSAL.NEVER_PROMOTES_TO_OWNER,
        ],
        [
            'a MODIFY carrying a custom role (rule 3)',
            stored('d-1', 'MODIFY', { role: 'EDITOR' }, { modifiedToRole: 'READER', modifiedToCustomRoleId: 'cr-1' }),
            409,
            MEMBER_DECISION_REFUSAL.MODIFY_SETS_NO_CUSTOM_ROLE,
        ],
    ] as const)('%s — even for an OWNER closer', async (_label, decision, status, reason) => {
        const db = campaignDb([stored('d-0', 'CONFIRM', { role: 'READER' }), decision]);
        const err = await closeAccessReview(owner(), 'ar-1').catch((e) => e);
        expect(err).toMatchObject({ status, details: { reason, decisionIds: ['d-1'] } });
        expect(err.message).toContain(reason);
        expect(db.tenantMembership.findMany).not.toHaveBeenCalled();
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
        expect(refusalAudit('ACCESS_REVIEW_CLOSE_REFUSED')).toMatchObject({
            entityType: 'AccessReview',
            entityId: 'ar-1',
            detailsJson: expect.objectContaining({ after: { reason, decisionIds: ['d-1'] } }),
        });
        expect(auditActions()).not.toContain('ACCESS_REVIEW_CLOSED');
    });

    it.each([
        ['REVOKE', {}],
        ['MODIFY', { modifiedToRole: 'READER' }],
    ] as const)('an ADMIN closer cannot %s a live OWNER (rule 2) — 403, named, audited', async (kind, modify) => {
        const db = campaignDb([stored('d-own', kind, { role: 'OWNER' }, modify), stored('d-ed', 'REVOKE', { role: 'EDITOR' })]);
        const err = await closeAccessReview(admin(), 'ar-1').catch((e) => e);
        expect(err).toMatchObject({
            status: 403,
            details: { reason: MEMBER_DECISION_REFUSAL.OWNER_SUBJECT_NEEDS_OWNER_CLOSER, decisionIds: ['d-own'] },
        });
        expect(err.message).toMatch(/only an OWNER can close this campaign/);
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
        expect(auditActions()).toEqual(['ACCESS_REVIEW_CLOSE_REFUSED']);
    });

    it('an OWNER closer passes rule 2, and an ADMIN closer passes it when no LIVE OWNER is lowered', async () => {
        campaignDb([stored('d-own', 'REVOKE', { role: 'OWNER' })]);
        await expect(closeAccessReview(owner(), 'ar-1')).rejects.toBe(REACHED_OWNER_COUNT);

        // Snapshot said OWNER; the member was demoted to ADMIN since — the
        // write no longer lowers an OWNER.
        const demotedSince = { ...stored('d-was-owner', 'REVOKE', { role: 'ADMIN' }), snapshotRole: 'OWNER' };
        campaignDb([demotedSince, stored('d-conf', 'CONFIRM', { role: 'OWNER' })]);
        await expect(closeAccessReview(admin(), 'ar-1')).rejects.toBe(REACHED_OWNER_COUNT);
        expect(auditActions()).toEqual([]);
    });

    it('the last-OWNER guard still applies to an OWNER closer', async () => {
        campaignDb([stored('d-own', 'REVOKE', { role: 'OWNER' })], [{ id: 'm-d-own', userId: 'u-d-own' }]);
        await expect(closeAccessReview(owner(), 'ar-1')).rejects.toThrow(/zero ACTIVE OWNERs/);
    });

    it('a REVOKE of a legacy OWNER that still carries a custom role is named, not a database error mid-close', async () => {
        const db = campaignDb([stored('d-own', 'REVOKE', { role: 'OWNER', customRoleId: 'cr-legacy' })]);
        await expect(closeAccessReview(owner(), 'ar-1')).rejects.toMatchObject({
            status: 409,
            details: { reason: BUILT_IN_SCOPE_REFUSAL, decisionIds: ['d-own'] },
        });
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });

    it('an unnamed refusal (a pending decision) writes no refusal row', async () => {
        campaignDb([{ ...stored('d-1', 'CONFIRM', { role: 'READER' }), decision: null }]);
        await expect(closeAccessReview(admin(), 'ar-1')).rejects.toThrow(/pending/);
        expect(auditActions()).toEqual([]);
    });
});

// ─── #4130 — nobody decides their own access ─────────────────────────

/**
 * A pending (or decided) row whose SUBJECT is `subjectUserId`, on a campaign
 * reviewed by `reviewerUserId`, as `getDecision` returns it.
 */
function ownRowDb(opts: { subjectUserId: string; reviewerUserId: string; decision?: 'CONFIRM' | null }) {
    const db = {
        accessReviewDecision: {
            findFirst: jest.fn().mockResolvedValue({
                id: 'd-self',
                decision: opts.decision ?? null,
                executedAt: null,
                subjectUserId: opts.subjectUserId,
                accessReview: {
                    id: 'ar-1',
                    tenantId: 'tenant-1',
                    status: 'IN_REVIEW',
                    reviewerUserId: opts.reviewerUserId,
                    deletedAt: null,
                },
            }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        accessReview: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    mockRunInTx.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(db));
    return db;
}

const reader = () => makeRequestContext('READER', { tenantId: 'tenant-1', userId: 'reader-1' });

describe('submitDecision — nobody records the verdict on their own access (#4130)', () => {
    it.each([
        ['the assigned reviewer (a READER)', reader, 'reader-1'],
        ['an ADMIN acting as backup', admin, 'someone-else'],
        ['an OWNER acting as backup', owner, 'someone-else'],
    ] as const)('%s is refused on their own row — 403, named, audited, nothing written', async (_label, who, reviewerUserId) => {
        const ctx = who();
        const db = ownRowDb({ subjectUserId: ctx.userId, reviewerUserId });
        const err = await submitDecision(ctx, 'd-self', { decision: 'CONFIRM', notes: 'all good' }).catch((e) => e);
        expect(err).toMatchObject({ status: 403, details: { reason: MEMBER_DECISION_REFUSAL.DECIDER_IS_SUBJECT } });
        expect(err.message).toContain(MEMBER_DECISION_REFUSAL.DECIDER_IS_SUBJECT);
        expect(db.accessReviewDecision.updateMany).not.toHaveBeenCalled();
        expect(db.accessReview.updateMany).not.toHaveBeenCalled();
        expect(auditActions()).toEqual(['ACCESS_REVIEW_DECISION_REFUSED']);
        expect(refusalAudit('ACCESS_REVIEW_DECISION_REFUSED')).toMatchObject({
            entityType: 'AccessReviewDecision',
            entityId: 'd-self',
            detailsJson: expect.objectContaining({
                category: 'access',
                after: { reason: MEMBER_DECISION_REFUSAL.DECIDER_IS_SUBJECT },
            }),
        });
    });

    it('the same caller decides somebody else’s row on the same campaign', async () => {
        const db = ownRowDb({ subjectUserId: 'u-other', reviewerUserId: 'reader-1' });
        await expect(submitDecision(reader(), 'd-self', { decision: 'CONFIRM' })).resolves.toMatchObject({
            decision: 'CONFIRM',
        });
        expect(db.accessReviewDecision.updateMany).toHaveBeenCalledTimes(1);
        expect(auditActions()).toEqual(['ACCESS_REVIEW_DECISION_SUBMITTED']);
    });

    it('a caller who may not decide the campaign at all is told THAT, not the own-row rule', async () => {
        ownRowDb({ subjectUserId: 'reader-1', reviewerUserId: 'somebody-else' });
        const err = await submitDecision(reader(), 'd-self', { decision: 'CONFIRM' }).catch((e) => e);
        expect(err).toMatchObject({ status: 403 });
        expect(err.message).toMatch(/Only the assigned reviewer/);
        expect(auditActions()).toEqual([]);
    });
});

describe('revokeDecision — nobody discards the verdict on their own access (#4130)', () => {
    it('an ADMIN discarding a verdict another reviewer recorded on the ADMIN is refused — named, audited, nothing reset', async () => {
        const db = ownRowDb({ subjectUserId: 'admin-1', reviewerUserId: 'reader-1', decision: 'CONFIRM' });
        const err = await revokeDecision(admin(), 'd-self', { reason: 'wrong verdict' }).catch((e) => e);
        expect(err).toMatchObject({ status: 403, details: { reason: MEMBER_DECISION_REFUSAL.DECIDER_IS_SUBJECT } });
        expect(db.accessReviewDecision.updateMany).not.toHaveBeenCalled();
        expect(auditActions()).toEqual(['ACCESS_REVIEW_DECISION_REVOKE_REFUSED']);
    });

    it('the reviewer discards a verdict on somebody else’s row', async () => {
        const db = ownRowDb({ subjectUserId: 'u-other', reviewerUserId: 'reader-1', decision: 'CONFIRM' });
        await expect(revokeDecision(reader(), 'd-self', { reason: 'wrong verdict' })).resolves.toMatchObject({
            decisionId: 'd-self',
        });
        expect(db.accessReviewDecision.updateMany).toHaveBeenCalledTimes(1);
        expect(auditActions()).toEqual(['ACCESS_REVIEW_DECISION_REVOKED']);
    });
});

describe('closeAccessReview — a verdict its own subject recorded is never executed (#4130)', () => {
    const selfDecided = (id: string, decision: 'CONFIRM' | 'REVOKE') => ({
        ...stored(id, decision, { role: 'ADMIN' }),
        decidedByUserId: `u-${id}`,
    });

    it('refuses the WHOLE close by name, even for an OWNER closer, before any row executes', async () => {
        const db = campaignDb([stored('d-0', 'CONFIRM', { role: 'READER' }), selfDecided('d-self', 'CONFIRM')]);
        const err = await closeAccessReview(owner(), 'ar-1').catch((e) => e);
        expect(err).toMatchObject({
            status: 409,
            details: { reason: MEMBER_DECISION_REFUSAL.DECIDER_IS_SUBJECT, decisionIds: ['d-self'] },
        });
        expect(db.tenantMembership.findMany).not.toHaveBeenCalled();
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
        expect(auditActions()).toEqual(['ACCESS_REVIEW_CLOSE_REFUSED']);
    });

    it('closes once somebody else decided that row', async () => {
        campaignDb([{ ...stored('d-self', 'CONFIRM', { role: 'ADMIN' }), decidedByUserId: 'reviewer-1' }]);
        await expect(closeAccessReview(admin(), 'ar-1')).rejects.toBe(REACHED_OWNER_COUNT);
        expect(auditActions()).toEqual([]);
    });
});

describe('closeAccessReview — changing or revoking an AI admin is OWNER-tier, as on the members page (#4130, #4118)', () => {
    const aiAdminModify = () => stored('d-ai', 'MODIFY', { role: 'AI_ADMIN' }, { modifiedToRole: 'READER' });

    it('an ADMIN closer cannot MODIFY a live AI admin — 403, named, audited, nothing executed', async () => {
        const db = campaignDb([aiAdminModify(), stored('d-ed', 'REVOKE', { role: 'EDITOR' })]);
        const err = await closeAccessReview(admin(), 'ar-1').catch((e) => e);
        expect(err).toMatchObject({
            status: 403,
            details: { reason: MEMBER_DECISION_REFUSAL.AI_ADMIN_SUBJECT_NEEDS_OWNER_CLOSER, decisionIds: ['d-ai'] },
        });
        expect(db.tenantMembership.findMany).not.toHaveBeenCalled();
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
        expect(auditActions()).toEqual(['ACCESS_REVIEW_CLOSE_REFUSED']);
    });

    it('an ADMIN closer cannot REVOKE a live AI admin either — the members page refuses an ADMIN that deactivation', async () => {
        const db = campaignDb([stored('d-ai', 'REVOKE', { role: 'AI_ADMIN' }), stored('d-ed', 'REVOKE', { role: 'EDITOR' })]);
        const err = await closeAccessReview(admin(), 'ar-1').catch((e) => e);
        expect(err).toMatchObject({
            status: 403,
            details: { reason: MEMBER_DECISION_REFUSAL.AI_ADMIN_SUBJECT_NEEDS_OWNER_CLOSER, decisionIds: ['d-ai'] },
        });
        expect(db.tenantMembership.findMany).not.toHaveBeenCalled();
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
        expect(auditActions()).toEqual(['ACCESS_REVIEW_CLOSE_REFUSED']);
    });

    it('an OWNER closer may MODIFY or REVOKE one', async () => {
        campaignDb([aiAdminModify()]);
        await expect(closeAccessReview(owner(), 'ar-1')).rejects.toBe(REACHED_OWNER_COUNT);

        campaignDb([stored('d-ai', 'REVOKE', { role: 'AI_ADMIN' })]);
        await expect(closeAccessReview(owner(), 'ar-1')).rejects.toBe(REACHED_OWNER_COUNT);
        expect(auditActions()).toEqual([]);
    });

    it('a CONFIRM of an AI admin is not refused to an ADMIN closer', async () => {
        campaignDb([stored('d-ai', 'CONFIRM', { role: 'AI_ADMIN' })]);
        await expect(closeAccessReview(admin(), 'ar-1')).rejects.toBe(REACHED_OWNER_COUNT);
        expect(auditActions()).toEqual([]);
    });
});
