/**
 * #3674, deploy 1 of 2 — the AGENT access-review scope exists, every reader
 * handles it, and nothing creates or acts on an AGENT campaign.
 *
 * One describe per writer and per acting reader. The structural half — one
 * create seam, no Zod schema over the generated enum, every file that names the
 * value listed — is `tests/guards/access-review-agent-scope.test.ts`; this file
 * is what each path DOES when it meets the value.
 *
 * Why the acting readers refuse rather than "handle" AGENT: in deploy 1 the
 * paths that could decide or close a campaign were written for other scopes.
 * The member close has no zero-subject guard, and the connected decide does
 * not know that an agent's owner may not decide their own agent. A container
 * running this build serves requests during deploy 2's rollout, which is the
 * first moment an AGENT row exists, so each refuses by name.
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
        create: jest.fn(async (_db: unknown, _ctx: unknown, data: { name: string }) => ({ id: 'ar-new', name: data.name })),
        closeCampaign: jest.fn(async () => 1),
        getById: jest.fn(),
        getLastActivityByUser: jest.fn(async () => ({})),
        resolveMembershipsForScope: jest.fn(async () => [
            { id: 'm-1', userId: 'u-1', role: 'READER', status: 'ACTIVE', customRoleId: null },
        ]),
        bulkCreateDecisions: jest.fn(async () => 1),
        getDecisionsForExecution: jest.fn(async () => []),
    },
}));

import { AccessReviewRepository } from '@/app-layer/repositories/AccessReviewRepository';
import {
    closeAccessReview,
    createAccessReview,
    getAccessReview,
    getAccessReviewWithActivity,
    narrowAgentSubjects,
} from '@/app-layer/usecases/access-review';
import {
    closeConnectedAccessReview,
    createConnectedAccessReview,
    listConnectedDecisions,
    remediationDescription,
    submitConnectedDecision,
} from '@/app-layer/usecases/access-review-connected';
import { createLegacyAccessReview } from '@/app-layer/usecases/access-review-legacy';
import {
    assertNotUnimplementedAgentCampaign,
    refuseAgentCampaign,
} from '@/app-layer/usecases/access-review-scope-gate';
import { DomainError } from '@/lib/errors/types';
import { CreateAccessReviewSchema } from '@/app-layer/schemas/access-review.schemas';
import {
    readAgentSubjectSnapshot,
    scopeLabelKey,
    subjectTableOf,
} from '@/lib/access-review/scope';
import { makeRequestContext } from '../helpers/make-context';

const NOW = new Date('2026-10-18T09:00:00.000Z');

const mockDb = {
    connectedIdentityAccount: { findMany: jest.fn() },
    identityAccountLink: { findMany: jest.fn() },
    accessReviewConnectedDecision: { createMany: jest.fn(), findMany: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn() },
    accessReview: { findFirst: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    tenantMembership: { findMany: jest.fn() },
    task: { create: jest.fn() },
    user: { findUnique: jest.fn() },
    tenant: { findUnique: jest.fn() },
    fileRecord: { create: jest.fn() },
    legacyAccessSnapshot: { findFirst: jest.fn() },
    legacyAccountResolution: { findFirst: jest.fn(), findMany: jest.fn() },
    legacyAccount: { findMany: jest.fn() },
    legacyIdentityAlias: { findMany: jest.fn() },
    employee: { findMany: jest.fn() },
};

/** An AGENT campaign row as deploy 2 would write it. */
function agentReview(over: Record<string, unknown> = {}) {
    return {
        id: 'ar-agent', name: 'Q4 agents', description: null, scope: 'AGENT',
        periodStartAt: null, periodEndAt: null, status: 'OPEN', deletedAt: null,
        snapshotTruncated: false, reviewerUserId: 'u-rev',
        reviewer: { email: 'rev@x.com' }, createdBy: { email: 'creator@x.com' },
        tenant: { name: 'Acme' },
        ...over,
    };
}

function agentSubject(over: Record<string, unknown> = {}) {
    return {
        id: 'dec-1',
        subjectRef: 'agent:ag-1',
        notes: 'kept for the quarterly close',
        decision: null,
        decidedAt: null,
        executedAt: null,
        snapshotJson: {
            kind: 'AGENT', agentId: 'ag-1', agentName: 'Evidence collector', agentStatus: 'ACTIVE',
            ownerUserId: 'u-owner', ownerEmail: 'owner@x.com', grantCount: 3,
        },
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.accessReview.findFirst.mockResolvedValue(agentReview());
    mockDb.accessReview.updateMany.mockResolvedValue({ count: 1 });
    mockDb.accessReviewConnectedDecision.findFirst.mockResolvedValue({
        id: 'dec-1', decision: null,
        accessReview: { reviewerUserId: 'u-rev', status: 'OPEN', deletedAt: null, scope: 'AGENT' },
    });
    mockDb.accessReviewConnectedDecision.findMany.mockResolvedValue([agentSubject()]);
    mockDb.accessReviewConnectedDecision.updateMany.mockResolvedValue({ count: 1 });
    mockDb.accessReviewConnectedDecision.createMany.mockResolvedValue({ count: 1 });
    mockDb.connectedIdentityAccount.findMany.mockResolvedValue([
        { id: 'acc-1', provider: 'okta', email: 'a@x.com', displayName: 'A', isAdmin: false, mfaEnrolled: true, groupsJson: [], connectionId: 'conn-1', externalUserId: 'ext-a' },
    ]);
    mockDb.identityAccountLink.findMany.mockResolvedValue([]);
});

// ─── The refusal itself ─────────────────────────────────────────────────

describe('the one named refusal', () => {
    it('is a 409 DomainError carrying AGENT_CAMPAIGN_NOT_AVAILABLE, for each action', () => {
        for (const action of ['create', 'decide', 'close'] as const) {
            let caught: unknown;
            try {
                refuseAgentCampaign(action);
            } catch (err) {
                caught = err;
            }
            expect(caught).toBeInstanceOf(DomainError);
            expect((caught as DomainError).domainCode).toBe('AGENT_CAMPAIGN_NOT_AVAILABLE');
            expect((caught as DomainError).status).toBe(409);
            expect((caught as Error).message).toMatch(/^AGENT_CAMPAIGN_NOT_AVAILABLE:/);
        }
    });

    it('fires for AGENT and for nothing else', () => {
        expect(() => assertNotUnimplementedAgentCampaign('AGENT', 'decide')).toThrow(/AGENT_CAMPAIGN_NOT_AVAILABLE/);
        for (const scope of ['ALL_USERS', 'ADMIN_ONLY', 'CUSTOM', 'CONNECTED_APP', 'LEGACY_APP', null, undefined]) {
            expect(() => assertNotUnimplementedAgentCampaign(scope, 'decide')).not.toThrow();
        }
    });
});

// ─── Writers ────────────────────────────────────────────────────────────

describe('the member creation route refuses AGENT by name', () => {
    it('CreateAccessReviewSchema rejects AGENT with AGENT_CAMPAIGN_NOT_AVAILABLE', () => {
        const r = CreateAccessReviewSchema.safeParse({ name: 'Q4', reviewerUserId: 'u-rev', scope: 'AGENT' });
        expect(r.success).toBe(false);
        expect(r.error?.issues[0]?.message).toMatch(/^AGENT_CAMPAIGN_NOT_AVAILABLE:/);
    });

    it('…and points the other non-member scopes at their own routes, rather than snapshotting members into them', () => {
        for (const scope of ['CONNECTED_APP', 'LEGACY_APP']) {
            const r = CreateAccessReviewSchema.safeParse({ name: 'Q4', reviewerUserId: 'u-rev', scope });
            expect(r.success).toBe(false);
            expect(r.error?.issues[0]?.message).toMatch(/^SCOPE_HAS_ITS_OWN_ROUTE:/);
        }
    });

    it('still accepts the member scopes, and defaults to ALL_USERS', () => {
        expect(CreateAccessReviewSchema.parse({ name: 'Q4', reviewerUserId: 'u-rev' }).scope).toBe('ALL_USERS');
        for (const scope of ['ALL_USERS', 'ADMIN_ONLY'] as const) {
            expect(CreateAccessReviewSchema.parse({ name: 'Q4', reviewerUserId: 'u-rev', scope }).scope).toBe(scope);
        }
    });

    it('createAccessReview refuses AGENT before any row is written', async () => {
        await expect(
            createAccessReview(makeRequestContext('ADMIN'), { name: 'Q4', reviewerUserId: 'u-rev', scope: 'AGENT' }),
        ).rejects.toThrow(/AGENT_CAMPAIGN_NOT_AVAILABLE/);
        expect(AccessReviewRepository.create).not.toHaveBeenCalled();
        expect(AccessReviewRepository.bulkCreateDecisions).not.toHaveBeenCalled();
    });
});

describe('AccessReviewRepository.create — the one create seam — refuses AGENT at run time', () => {
    // The real seam, not the mock above: the type already excludes AGENT
    // (proved in the guard), and this is the caller that arrived by a cast.
    const Real = jest.requireActual<typeof import('@/app-layer/repositories/AccessReviewRepository')>(
        '@/app-layer/repositories/AccessReviewRepository',
    ).AccessReviewRepository;

    it('throws AGENT_CAMPAIGN_NOT_AVAILABLE and never calls the delegate', async () => {
        await expect(
            Real.create(mockDb as never, makeRequestContext('ADMIN'), {
                name: 'Q4', reviewerUserId: 'u-rev', scope: 'AGENT' as never,
            }),
        ).rejects.toThrow(/AGENT_CAMPAIGN_NOT_AVAILABLE/);
        expect(mockDb.accessReview.create).not.toHaveBeenCalled();
    });

    it('writes every other scope', async () => {
        mockDb.accessReview.create.mockResolvedValue({ id: 'ar-1' });
        await Real.create(mockDb as never, makeRequestContext('ADMIN'), { name: 'Q4', reviewerUserId: 'u-rev', scope: 'CONNECTED_APP' });
        expect(mockDb.accessReview.create.mock.calls[0][0].data.scope).toBe('CONNECTED_APP');
    });
});

describe('the connected and legacy writers cannot be asked for AGENT', () => {
    it('createConnectedAccessReview ignores a smuggled scope and writes CONNECTED_APP', async () => {
        await createConnectedAccessReview(makeRequestContext('ADMIN'), { name: 'Q4', reviewerUserId: 'u-rev', scope: 'AGENT' });
        expect((AccessReviewRepository.create as jest.Mock).mock.calls[0][2].scope).toBe('CONNECTED_APP');
    });

    it('createLegacyAccessReview ignores a smuggled scope and writes LEGACY_APP', async () => {
        mockDb.legacyAccessSnapshot.findFirst.mockResolvedValue({
            id: 'snap-1', status: 'COMPLETE', completedAt: new Date(NOW.getTime() - 60_000),
            payloadHash: 'h', mappingVersion: 1, rowCount: 1,
        });
        mockDb.legacyAccountResolution.findFirst.mockResolvedValue({ executionId: 'exec-1' });
        mockDb.legacyAccount.findMany.mockResolvedValue([{
            accountKey: 'jsmith', displayName: 'J Smith', email: 'j@x.com', department: null, title: null,
            managerRef: null, status: 'ACTIVE', accountType: 'USER', isPrivileged: false, lastLoginAt: null,
            sourceCreatedAt: null, entitlements: [], employeeNumber: null,
        }]);
        mockDb.legacyAccountResolution.findMany.mockResolvedValue([]);
        mockDb.legacyIdentityAlias.findMany.mockResolvedValue([]);
        mockDb.accessReview.findFirst.mockResolvedValue(null);

        await createLegacyAccessReview(
            makeRequestContext('ADMIN'),
            { name: 'Q4 legacy', connectionId: 'conn-l', reviewerUserId: 'u-rev', scope: 'AGENT' },
            NOW,
        );
        expect((AccessReviewRepository.create as jest.Mock).mock.calls[0][2].scope).toBe('LEGACY_APP');
    });
});

// ─── Acting readers ─────────────────────────────────────────────────────

describe('deciding an AGENT subject is refused by name', () => {
    it('submitConnectedDecision refuses, even for the assigned reviewer, and writes nothing', async () => {
        await expect(
            submitConnectedDecision(makeRequestContext('ADMIN', { userId: 'u-rev' }), 'dec-1', { decision: 'CONFIRM' }, NOW),
        ).rejects.toThrow(/AGENT_CAMPAIGN_NOT_AVAILABLE/);
        expect(mockDb.accessReviewConnectedDecision.updateMany).not.toHaveBeenCalled();
    });

    it('a CONNECTED_APP subject is still decidable', async () => {
        mockDb.accessReviewConnectedDecision.findFirst.mockResolvedValue({
            id: 'dec-1', decision: null,
            accessReview: { reviewerUserId: 'u-rev', status: 'OPEN', deletedAt: null, scope: 'CONNECTED_APP' },
        });
        await expect(
            submitConnectedDecision(makeRequestContext('ADMIN', { userId: 'u-rev' }), 'dec-1', { decision: 'CONFIRM' }, NOW),
        ).resolves.toMatchObject({ decision: 'CONFIRM' });
    });
});

describe('closing an AGENT campaign is refused by name, by both closes', () => {
    it('closeConnectedAccessReview refuses before claiming the close or writing a task', async () => {
        mockDb.accessReviewConnectedDecision.findMany.mockResolvedValue([agentSubject({ decision: 'CONFIRM', decidedAt: NOW })]);
        await expect(closeConnectedAccessReview(makeRequestContext('ADMIN'), 'ar-agent', NOW)).rejects.toThrow(
            /AGENT_CAMPAIGN_NOT_AVAILABLE/,
        );
        expect(mockDb.accessReview.updateMany).not.toHaveBeenCalled();
        expect(mockDb.task.create).not.toHaveBeenCalled();
    });

    it('closeAccessReview — the member close, which has no zero-subject guard — refuses it too', async () => {
        await expect(closeAccessReview(makeRequestContext('ADMIN'), 'ar-agent')).rejects.toThrow(/AGENT_CAMPAIGN_NOT_AVAILABLE/);
        expect(AccessReviewRepository.getDecisionsForExecution).not.toHaveBeenCalled();
        expect(AccessReviewRepository.closeCampaign).not.toHaveBeenCalled();
    });

    it('…and refuses every other non-member scope, which would close over zero member rows', async () => {
        for (const scope of ['CONNECTED_APP', 'LEGACY_APP']) {
            mockDb.accessReview.findFirst.mockResolvedValue(agentReview({ scope }));
            await expect(closeAccessReview(makeRequestContext('ADMIN'), 'ar-agent')).rejects.toThrow(/does not close through the member flow/);
        }
        expect(AccessReviewRepository.closeCampaign).not.toHaveBeenCalled();
    });
});

// ─── Reading readers ────────────────────────────────────────────────────

describe('an AGENT campaign’s subjects are narrowed to the reviewer or a register reader', () => {
    const review = { ...agentReview(), connectedDecisions: [agentSubject()] };

    it('a READER who is not the reviewer sees the rows, without the register data', () => {
        const out = narrowAgentSubjects(makeRequestContext('READER', { userId: 'u-other' }), review);
        expect(out.subjectsRestricted).toBe(true);
        expect(out.connectedDecisions).toHaveLength(1);
        expect(out.connectedDecisions[0]).toMatchObject({ id: 'dec-1', subjectRef: 'agent', snapshotJson: null, notes: null });
    });

    it('the assigned reviewer sees them, whatever their role', () => {
        const out = narrowAgentSubjects(makeRequestContext('READER', { userId: 'u-rev' }), review);
        expect(out.subjectsRestricted).toBe(false);
        expect(readAgentSubjectSnapshot(out.connectedDecisions[0].snapshotJson)?.agentName).toBe('Evidence collector');
    });

    it('a holder of admin.agent_registry sees them', () => {
        const out = narrowAgentSubjects(makeRequestContext('ADMIN', { userId: 'u-other' }), review);
        expect(out.subjectsRestricted).toBe(false);
        expect(out.connectedDecisions[0].subjectRef).toBe('agent:ag-1');
    });

    it('every other scope passes through untouched', () => {
        const connected = { ...review, scope: 'CONNECTED_APP' };
        const out = narrowAgentSubjects(makeRequestContext('READER', { userId: 'u-other' }), connected);
        expect(out.subjectsRestricted).toBe(false);
        expect(out.connectedDecisions[0]).toBe(connected.connectedDecisions[0]);
    });

    it('getAccessReview and getAccessReviewWithActivity both apply it', async () => {
        (AccessReviewRepository.getById as jest.Mock).mockResolvedValue({ ...review, decisions: [] });
        const ctx = makeRequestContext('READER', { userId: 'u-other' });
        expect((await getAccessReview(ctx, 'ar-agent')).subjectsRestricted).toBe(true);
        const detail = await getAccessReviewWithActivity(ctx, 'ar-agent');
        expect(detail.subjectsRestricted).toBe(true);
        expect(detail.connectedDecisions[0].snapshotJson).toBeNull();
    });

    it('listConnectedDecisions — the same rows by another route — applies it too', async () => {
        const restricted = await listConnectedDecisions(makeRequestContext('READER', { userId: 'u-other' }), 'ar-agent');
        expect(restricted[0]).toMatchObject({ subjectRef: 'agent', snapshotJson: null, notes: null });
        const reviewer = await listConnectedDecisions(makeRequestContext('READER', { userId: 'u-rev' }), 'ar-agent');
        expect(reviewer[0].subjectRef).toBe('agent:ag-1');
    });
});

describe('the scope facts every reader keys on', () => {
    it('an AGENT campaign’s subjects are in the connected table; an unknown scope never reaches the member close', () => {
        expect(subjectTableOf('AGENT')).toBe('CONNECTED');
        expect(subjectTableOf('ALL_USERS')).toBe('MEMBER');
        expect(subjectTableOf('SOMETHING_NEW')).toBe('CONNECTED');
    });

    it('labels every stored scope, and says so when it meets one it does not know', () => {
        expect(scopeLabelKey('AGENT')).toBe('AGENT');
        expect(scopeLabelKey('SOMETHING_NEW')).toBe('UNKNOWN');
    });

    it('reads an agent subject, and refuses anything else rather than inventing one', () => {
        expect(readAgentSubjectSnapshot(agentSubject().snapshotJson)).toMatchObject({ agentId: 'ag-1', grantCount: 3 });
        expect(readAgentSubjectSnapshot(null)).toBeNull();
        expect(readAgentSubjectSnapshot({ provider: 'okta', email: 'a@x.com' })).toBeNull();
        expect(readAgentSubjectSnapshot({ kind: 'AGENT', agentId: 'ag-2', grantCount: 'three' })).toMatchObject({ grantCount: null, agentName: null });
    });

    it('the remediation wording for an agent sends the reviewer to the register, not the identity provider', () => {
        const text = remediationDescription({ scope: 'AGENT', reviewName: 'Q4', decision: 'REVOKE', subjectRef: 'agent:ag-1' });
        expect(text).toMatch(/AGENT REGISTER/);
        expect(text).not.toMatch(/identity provider/);
    });
});
