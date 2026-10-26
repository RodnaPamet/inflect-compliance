/**
 * A campaign's reviewer must be an ACTIVE member of the caller's tenant, on
 * every path that names one (`assertReviewerIsActiveMember`).
 *
 * The agent create and the settings change always asked this; the member,
 * connected and legacy creates did not, and stored any existing user id. This
 * file holds the rule with the database mocked: the predicate, its refusal,
 * and for each create that the refusal comes before anything is read or
 * written. The same rule against a real database, with a user from another
 * tenant and a deactivated member, is
 * `tests/integration/access-review-reviewer-member.test.ts`.
 */
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/app-layer/repositories/AccessReviewRepository', () => ({
    AccessReviewRepository: {
        create: jest.fn(async () => ({ id: 'ar-new', name: 'Q4' })),
        createAgentCampaign: jest.fn(async () => ({ id: 'ar-new', name: 'Q4' })),
        resolveMembershipsForScope: jest.fn(async () => [
            { id: 'm-1', userId: 'u-1', role: 'READER', status: 'ACTIVE', customRoleId: null },
        ]),
        bulkCreateDecisions: jest.fn(async () => 1),
    },
}));

import { AccessReviewRepository } from '@/app-layer/repositories/AccessReviewRepository';
import { createAccessReview } from '@/app-layer/usecases/access-review';
import { createConnectedAccessReview } from '@/app-layer/usecases/access-review-connected';
import { createLegacyAccessReview } from '@/app-layer/usecases/access-review-legacy';
import { createAgentAccessReview } from '@/app-layer/usecases/access-review-agent';
import {
    REVIEWER_NOT_A_MEMBER,
    assertReviewerIsActiveMember,
} from '@/app-layer/usecases/access-review-reviewer';
import { ValidationError } from '@/lib/errors/types';
import { makeRequestContext } from '../helpers/make-context';

const mockDb = {
    tenantMembership: { findFirst: jest.fn() },
    connectedIdentityAccount: { findMany: jest.fn() },
    legacyAccessSnapshot: { findFirst: jest.fn() },
    registeredAgent: { findMany: jest.fn() },
    accessReviewConnectedDecision: { createMany: jest.fn() },
};

const ctx = () => makeRequestContext('ADMIN', { tenantId: 'tenant-1', userId: 'u-admin' });

/** The refusal every path gives: one class, one status, the code first. */
const REFUSAL = {
    status: 400,
    code: 'BAD_REQUEST',
    message: expect.stringMatching(new RegExp(`^${REVIEWER_NOT_A_MEMBER}: `)),
};

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.tenantMembership.findFirst.mockResolvedValue(null);
});

describe('assertReviewerIsActiveMember — the one predicate', () => {
    it('asks for an ACTIVE membership of this user in the CALLER\'s tenant', async () => {
        mockDb.tenantMembership.findFirst.mockResolvedValue({ id: 'm-rev' });
        await assertReviewerIsActiveMember(mockDb as never, ctx(), 'u-rev');
        expect(mockDb.tenantMembership.findFirst).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', userId: 'u-rev', status: 'ACTIVE' },
            select: { id: true },
        });
    });

    it('refuses when there is none, as a ValidationError carrying the code', async () => {
        const refused = assertReviewerIsActiveMember(mockDb as never, ctx(), 'stranger');
        await expect(refused).rejects.toBeInstanceOf(ValidationError);
        await expect(assertReviewerIsActiveMember(mockDb as never, ctx(), 'stranger')).rejects.toMatchObject(REFUSAL);
    });
});

describe('every create refuses a non-member reviewer before it reads or writes anything else', () => {
    it('createAccessReview (member scopes)', async () => {
        await expect(createAccessReview(ctx(), { name: 'Q4', reviewerUserId: 'stranger' })).rejects.toMatchObject(REFUSAL);
        expect(AccessReviewRepository.resolveMembershipsForScope).not.toHaveBeenCalled();
        expect(AccessReviewRepository.create).not.toHaveBeenCalled();
        expect(AccessReviewRepository.bulkCreateDecisions).not.toHaveBeenCalled();
    });

    it('createConnectedAccessReview', async () => {
        await expect(
            createConnectedAccessReview(ctx(), { name: 'Q4', reviewerUserId: 'stranger' }),
        ).rejects.toMatchObject(REFUSAL);
        expect(mockDb.connectedIdentityAccount.findMany).not.toHaveBeenCalled();
        expect(AccessReviewRepository.create).not.toHaveBeenCalled();
        expect(mockDb.accessReviewConnectedDecision.createMany).not.toHaveBeenCalled();
    });

    it('createLegacyAccessReview — before any of its five snapshot refusals', async () => {
        await expect(
            createLegacyAccessReview(ctx(), { name: 'Q4', connectionId: 'conn-l', reviewerUserId: 'stranger' }),
        ).rejects.toMatchObject(REFUSAL);
        expect(mockDb.legacyAccessSnapshot.findFirst).not.toHaveBeenCalled();
        expect(AccessReviewRepository.create).not.toHaveBeenCalled();
        expect(mockDb.accessReviewConnectedDecision.createMany).not.toHaveBeenCalled();
    });

    it('createAgentAccessReview — the same refusal it gave before the rule was shared', async () => {
        await expect(
            createAgentAccessReview(ctx(), { name: 'Q4', reviewerUserId: 'stranger', preparerAgentId: 'agent-a' }),
        ).rejects.toMatchObject(REFUSAL);
        expect(mockDb.registeredAgent.findMany).not.toHaveBeenCalled();
        expect(AccessReviewRepository.createAgentCampaign).not.toHaveBeenCalled();
    });

    it('each asked about the reviewer it was given, in the caller\'s tenant', () => {
        // A positive control on the four cases above: they refused because the
        // membership read answered null for THEIR reviewer, not for some other
        // reason that happens to share the code.
        return Promise.all([
            createAccessReview(ctx(), { name: 'Q4', reviewerUserId: 'r-member' }).catch(() => undefined),
            createConnectedAccessReview(ctx(), { name: 'Q4', reviewerUserId: 'r-connected' }).catch(() => undefined),
            createLegacyAccessReview(ctx(), { name: 'Q4', connectionId: 'c', reviewerUserId: 'r-legacy' }).catch(() => undefined),
            createAgentAccessReview(ctx(), { name: 'Q4', reviewerUserId: 'r-agent', preparerAgentId: 'a' }).catch(() => undefined),
        ]).then(() => {
            const asked = mockDb.tenantMembership.findFirst.mock.calls.map((c) => c[0].where);
            expect(asked).toEqual(expect.arrayContaining(
                ['r-member', 'r-connected', 'r-legacy', 'r-agent'].map((userId) => ({
                    tenantId: 'tenant-1', userId, status: 'ACTIVE',
                })),
            ));
            expect(asked).toHaveLength(4);
        });
    });
});
