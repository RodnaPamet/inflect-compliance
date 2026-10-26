/**
 * `borrowedJobActor` — the pick a job makes when it acts for nobody in
 * particular and needs a member so RLS and the read policies have an actor
 * (#4388, owner decision 2026-10-26).
 *
 * The three jobs that do this took the oldest ACTIVE OWNER/ADMIN and called
 * `getPermissionsForRole(membership.role)`. Two defects, and only the first is
 * visible in a diff: the query never SELECTED `customRole`, so the role that
 * actually governs the member could not be seen; and the coarse flags were
 * hand-projected from granular ones rather than computed from the role.
 *
 * So the assertions below are about the two things that distinguish a PICK
 * from a lookup: the candidate's authority is resolved the way a request's is,
 * and coming up empty says WHICH way it came up empty.
 *
 * DO NOT delete the `select` assertion as redundant. A prisma double returns
 * whatever the row literal holds, `select` or no `select`, so with `customRole`
 * dropped from the query every BEHAVIOURAL test here still passes -- measured:
 * removing that line reddens the `select` assertion and nothing else. Against a
 * mock it is the only thing standing between this pick and the original defect;
 * the behavioural half only bites once the resolution is reached.
 */
const prismaMock = { tenantMembership: { findMany: jest.fn() } };
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: prismaMock, prisma: prismaMock }));

import {
    borrowedJobActor,
    BORROW_FAILURE,
    BORROWED_ACTOR_CANDIDATE_CAP,
} from '@/app-layer/context-system';
import { mayPullPolicyFromSharePoint } from '@/app-layer/jobs/sharepoint-policy-jobs';
import { mayRunAppetiteMonitor } from '@/app-layer/jobs/risk-appetite-jobs';
import { mayGeneratePostureSummary } from '@/app-layer/jobs/compliance-posture-summary';
import { getPermissionsForRole } from '@/lib/permissions';
import { computePermissions } from '@/lib/tenant-context';

const ADMIN_APP = getPermissionsForRole('ADMIN');

/** An ADMIN-based custom role that withholds one granular key. */
const withoutUpload = {
    baseRole: 'ADMIN',
    permissionsJson: { ...ADMIN_APP, evidence: { ...ADMIN_APP.evidence, upload: false } },
};

/**
 * A membership whose BUILT-IN role is ADMIN while its custom role is based on
 * READER. This is the shape the old code could not represent at all: it read
 * `membership.role`, so this member looked like a full admin.
 */
const adminDowngradedToReader = {
    baseRole: 'READER',
    permissionsJson: getPermissionsForRole('READER'),
};

const member = (userId: string, role: string, customRole: unknown = null) => ({ userId, role, customRole });

const wantsUpload = (a: { appPermissions: typeof ADMIN_APP }) => a.appPermissions.evidence.upload === true;

beforeEach(() => jest.clearAllMocks());

describe('borrowedJobActor resolves each candidate the way a request does', () => {
    it('passes over a first-in-order member whose custom role withholds the key, for the next one', async () => {
        prismaMock.tenantMembership.findMany.mockResolvedValue([
            member('oldest-custom-admin', 'ADMIN', withoutUpload),
            member('next-admin', 'ADMIN'),
        ]);
        const { actor, reason } = await borrowedJobActor({
            tenantId: 't1',
            roles: ['OWNER', 'ADMIN'],
            orderBy: 'createdAt',
            allows: wantsUpload,
        });
        expect(actor?.userId).toBe('next-admin');
        expect(reason).toBeNull();
    });

    it('SELECTS customRole — without it the governing role is invisible to the resolution', async () => {
        prismaMock.tenantMembership.findMany.mockResolvedValue([member('a', 'ADMIN')]);
        await borrowedJobActor({ tenantId: 't1', orderBy: 'createdAt', allows: () => true });
        const [[args]] = prismaMock.tenantMembership.findMany.mock.calls;
        expect(args.select.customRole).toEqual({ select: { baseRole: true, permissionsJson: true } });
        expect(args.where).toMatchObject({ tenantId: 't1', status: 'ACTIVE' });
        expect(args.take).toBe(BORROWED_ACTOR_CANDIDATE_CAP);
    });

    it("takes the coarse flags from the CUSTOM role's base, not from membership.role", async () => {
        prismaMock.tenantMembership.findMany.mockResolvedValue([
            member('admin-by-membership-reader-by-role', 'ADMIN', adminDowngradedToReader),
        ]);
        const { actor } = await borrowedJobActor({ tenantId: 't1', orderBy: 'createdAt', allows: () => true });
        // The old projection would have produced ADMIN's flags for this member.
        expect(actor?.permissions).toEqual(computePermissions('READER'));
        expect(actor?.permissions.canWrite).toBe(false);
    });

    it('orders by role when asked for the most senior, and by createdAt otherwise', async () => {
        prismaMock.tenantMembership.findMany.mockResolvedValue([member('a', 'ADMIN')]);
        await borrowedJobActor({ tenantId: 't1', orderBy: 'role', allows: () => true });
        expect(prismaMock.tenantMembership.findMany.mock.calls[0][0].orderBy).toEqual({ role: 'asc' });
        await borrowedJobActor({ tenantId: 't1', orderBy: 'createdAt', allows: () => true });
        expect(prismaMock.tenantMembership.findMany.mock.calls[1][0].orderBy).toEqual({ createdAt: 'asc' });
    });
});

describe('coming up empty names WHICH way, because the two are different facts', () => {
    it('reports NO_QUALIFYING_ACTOR when members exist and not one of them may do the work', async () => {
        prismaMock.tenantMembership.findMany.mockResolvedValue([
            member('a', 'ADMIN', withoutUpload),
            member('b', 'ADMIN', withoutUpload),
        ]);
        const { actor, reason } = await borrowedJobActor({
            tenantId: 't1',
            orderBy: 'createdAt',
            allows: wantsUpload,
        });
        expect(actor).toBeNull();
        expect(reason).toBe(BORROW_FAILURE.NO_QUALIFYING_ACTOR);
    });

    it('reports NO_ACTIVE_MEMBER when the tenant has nobody to borrow', async () => {
        prismaMock.tenantMembership.findMany.mockResolvedValue([]);
        const { actor, reason } = await borrowedJobActor({
            tenantId: 't1',
            orderBy: 'createdAt',
            allows: wantsUpload,
        });
        expect(actor).toBeNull();
        expect(reason).toBe(BORROW_FAILURE.NO_ACTIVE_MEMBER);
    });

    it('never falls back to a system context when nobody qualifies', async () => {
        prismaMock.tenantMembership.findMany.mockResolvedValue([member('a', 'ADMIN', withoutUpload)]);
        const { actor } = await borrowedJobActor({ tenantId: 't1', orderBy: 'createdAt', allows: wantsUpload });
        expect(actor).toBeNull();
    });
});

describe("each job's predicate is the key its own usecase asserts", () => {
    const authority = (role: 'OWNER' | 'ADMIN' | 'READER') => ({
        permissions: computePermissions(role),
        appPermissions: getPermissionsForRole(role),
    });

    it('sharepoint-policy requires write — its usecase asserts assertCanWrite', () => {
        expect(mayPullPolicyFromSharePoint(authority('ADMIN'))).toBe(true);
        expect(mayPullPolicyFromSharePoint(authority('READER'))).toBe(false);
    });

    it('risk-appetite and posture require read — both only gather signals', () => {
        for (const may of [mayRunAppetiteMonitor, mayGeneratePostureSummary]) {
            expect(may(authority('ADMIN'))).toBe(true);
            expect(may(authority('READER'))).toBe(true);
        }
    });
});
