/**
 * Ending an assignment EARLY (#3374).
 *
 * #3297 built no revocation on purpose — its goal ended "and expires on its
 * own", and #3311 measured that Entra does. What nobody could do was end a
 * grant before its date: a mistaken grant, a withdrawn approval, a role change
 * on Tuesday.
 *
 * The decisions are what these cover, because the decisions are where this can
 * do harm. `adminRemove` is addressed by the ASSIGNMENT's id rather than by
 * subject + package, so the id has to be resolved from the live read — and the
 * two ways that resolution can be wrong are "nothing to remove" and "more than
 * one thing it could mean". Both are refusals, neither is a guess.
 */
const findManyMock = jest.fn();
const runInTenantContextMock = jest.fn(
    async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ integrationConnection: { findMany: (a: unknown) => findManyMock(a) } }),
);
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (c: unknown, f: (db: unknown) => unknown) => runInTenantContextMock(c, f),
}));
jest.mock('@/lib/security/encryption', () => ({ decryptField: (v: string) => v }));

const readAssignmentsMock = jest.fn();
const requestAssignmentRemovalMock = jest.fn();
const requestTimeBoundedAssignmentMock = jest.fn();
jest.mock('@/app-layer/integrations/providers/entra-id/entitlement', () => {
    const actual = jest.requireActual(
        '@/app-layer/integrations/providers/entra-id/entitlement',
    ) as Record<string, unknown>;
    return {
        ...actual,
        createEntraEntitlementClient: () => ({
            readAssignments: (a: unknown) => readAssignmentsMock(a),
            requestAssignmentRemoval: (a: unknown) => requestAssignmentRemovalMock(a),
            requestTimeBoundedAssignment: (a: unknown) => requestTimeBoundedAssignmentMock(a),
        }),
    };
});

import { revokeAccessAssignment, ENTRA_PROVIDER } from '@/app-layer/usecases/entra-grant-dispatch';
import type { AccessAssignmentState } from '@/app-layer/integrations/providers/entra-id/entitlement';
import { makeRequestContext } from '../helpers/make-context';

const SECRETS = JSON.stringify({
    tenantId: 'a-tenant-guid',
    clientId: 'an-app-guid',
    clientSecret: 'a-secret', // pragma: allowlist secret -- test fixture
});

const conn = () => ({
    id: 'conn-1',
    name: 'Entra',
    provider: ENTRA_PROVIDER,
    isEnabled: true,
    configJson: {},
    secretEncrypted: SECRETS,
});

/** TYPED, so a field rename in the provider is a compile error here. */
const assignment = (over: Partial<AccessAssignmentState> = {}): AccessAssignmentState => ({
    assignmentId: 'asg-1',
    accessPackageId: 'pkg-1',
    state: 'delivered',
    endDateTime: '2026-12-01T00:00:00.000Z',
    liveness: 'live',
    ...over,
});

const ctx = makeRequestContext('OWNER', { tenantId: 'tenant-A' });
const INPUT = { targetId: 'subj-1', accessPackageId: 'pkg-1' };

beforeEach(() => {
    jest.clearAllMocks();
    findManyMock.mockResolvedValue([conn()]);
    readAssignmentsMock.mockResolvedValue({ all: [assignment()], live: [assignment()] });
    requestAssignmentRemovalMock.mockResolvedValue({ requestId: 'req-1' });
});

describe('a withdrawal is addressed by the assignment resolved from the live read', () => {
    it('sends the id of the one live assignment', async () => {
        const out = await revokeAccessAssignment(ctx, INPUT);
        expect(out).toEqual({ ok: true, requestId: 'req-1' });
        expect(requestAssignmentRemovalMock).toHaveBeenCalledTimes(1);
        expect(requestAssignmentRemovalMock.mock.calls[0][0]).toMatchObject({
            assignmentId: 'asg-1',
        });
    });

    it('takes the id from LIVE, not from ALL — which differ in order here', async () => {
        // The discriminating case, and it was missing: every other fixture put
        // the same assignment in both arrays, so `live[0]` and `all[0]` were
        // indistinguishable and swapping them passed the whole suite.
        //
        // `all` is ordered with a LAPSED assignment first, which is what Graph
        // returns for a subject who held the package before. Withdrawing that
        // one is a no-op: it settles ACCEPTED, never promotes, and leaves the
        // live access in place while the journal says a withdrawal was asked
        // for.
        const lapsed = assignment({ assignmentId: 'asg-old', state: 'expired', liveness: 'inactive' });
        const held = assignment({ assignmentId: 'asg-held' });
        readAssignmentsMock.mockResolvedValue({ all: [lapsed, held], live: [held] });
        const out = await revokeAccessAssignment(ctx, INPUT);
        expect(out.ok).toBe(true);
        expect(requestAssignmentRemovalMock.mock.calls[0][0]).toMatchObject({
            assignmentId: 'asg-held',
        });
    });

    it('passes a justification through when given, and omits the key when not', async () => {
        await revokeAccessAssignment(ctx, { ...INPUT, justification: 'ticket-9' });
        expect(requestAssignmentRemovalMock.mock.calls[0][0]).toMatchObject({
            justification: 'ticket-9',
        });
        jest.clearAllMocks();
        findManyMock.mockResolvedValue([conn()]);
        readAssignmentsMock.mockResolvedValue({ all: [assignment()], live: [assignment()] });
        requestAssignmentRemovalMock.mockResolvedValue({ requestId: 'req-2' });
        await revokeAccessAssignment(ctx, INPUT);
        expect(requestAssignmentRemovalMock.mock.calls[0][0]).not.toHaveProperty('justification');
    });

    it('reads the SAME subject and package it was asked about', async () => {
        await revokeAccessAssignment(ctx, INPUT);
        expect(readAssignmentsMock.mock.calls[0][0]).toEqual({
            targetId: 'subj-1',
            accessPackageId: 'pkg-1',
        });
    });
});

describe('it refuses rather than guessing', () => {
    it('refuses when the subject holds nothing live, and sends nothing', async () => {
        // Not politeness: a removal of something not held changes nothing at
        // the far end, so the journal row would settle ACCEPTED and the
        // reconcile pass would never see a disappearance — #3334's defect
        // through a new door.
        readAssignmentsMock.mockResolvedValue({ all: [], live: [] });
        const out = await revokeAccessAssignment(ctx, INPUT);
        expect(out.ok).toBe(false);
        if (out.ok) return;
        expect(out.refused).toMatch(/nothing to withdraw/i);
        expect(requestAssignmentRemovalMock).not.toHaveBeenCalled();
    });

    it('refuses when an EXPIRED assignment is all there is', async () => {
        // The #3326 distinction, on this side: a lapsed assignment is listed
        // but is not a holding, so there is still nothing to withdraw.
        const expired = assignment({ state: 'expired', liveness: 'inactive' });
        readAssignmentsMock.mockResolvedValue({ all: [expired], live: [] });
        const out = await revokeAccessAssignment(ctx, INPUT);
        expect(out.ok).toBe(false);
        expect(requestAssignmentRemovalMock).not.toHaveBeenCalled();
    });

    it('refuses when more than one live assignment could be meant', async () => {
        // Picking the first would be a silent choice about somebody's access.
        readAssignmentsMock.mockResolvedValue({
            all: [assignment(), assignment({ assignmentId: 'asg-2' })],
            live: [assignment(), assignment({ assignmentId: 'asg-2' })],
        });
        const out = await revokeAccessAssignment(ctx, INPUT);
        expect(out.ok).toBe(false);
        if (out.ok) return;
        expect(out.refused).toMatch(/2 live assignments/);
        expect(requestAssignmentRemovalMock).not.toHaveBeenCalled();
    });

    it('refuses when no usable Entra connection resolves, before reading anything', async () => {
        findManyMock.mockResolvedValue([]);
        const out = await revokeAccessAssignment(ctx, INPUT);
        expect(out.ok).toBe(false);
        expect(readAssignmentsMock).not.toHaveBeenCalled();
        expect(requestAssignmentRemovalMock).not.toHaveBeenCalled();
    });
});

describe('a withdrawal carries no expiry, so none of the grant expiry rules apply', () => {
    it('needs no end date and never calls the grant verb', async () => {
        // `expiryRefusal`'s clauses — required, parseable, future, within
        // MAX_GRANT_DAYS — are all about a field this operation does not have.
        // The input type has no endDateTime, and the grant verb must stay
        // unreachable from here.
        const out = await revokeAccessAssignment(ctx, INPUT);
        expect(out.ok).toBe(true);
        expect(requestTimeBoundedAssignmentMock).not.toHaveBeenCalled();
    });
});
