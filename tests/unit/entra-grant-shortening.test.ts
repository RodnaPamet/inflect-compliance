/**
 * #3300 — the prior-state read catches a grant that would SHORTEN access.
 *
 * WHY THIS IS THE INTERESTING FAILURE
 * ───────────────────────────────────
 * A grant is not obviously idempotent — the endpoint declares
 * `idempotentHint: false` — and the dangerous case is not "granting twice is
 * wasteful". It is:
 *
 *   the subject already holds the package until the 1st of December, somebody
 *   grants it until the 1st of November, and if Entra treats `adminAdd` as a
 *   REPLACE rather than an ADD, a month of access just disappeared.
 *
 * Nobody asked for that reduction, nothing in the journal looks wrong, and the
 * row that records it is a successful grant. #3300 names this as the reason the
 * pairing exists at all, so it is refused rather than attempted.
 *
 * WHAT THIS DOES NOT CLAIM
 * ────────────────────────
 * It does not claim to know what `adminAdd` does to an existing assignment.
 * That is measurable against a live tenant and is not measured here; the
 * refusal is correct either way, which is the point of refusing rather than
 * reasoning about it.
 */
const findManyMock = jest.fn();
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_c: unknown, fn: (db: unknown) => unknown) =>
        fn({ integrationConnection: { findMany: findManyMock } }),
}));
jest.mock('@/lib/security/encryption', () => ({ decryptField: (v: string) => v }));

const readAssignmentsMock = jest.fn();
const requestMock = jest.fn(async () => ({ requestId: 'req-1' }));
jest.mock('@/app-layer/integrations/providers/entra-id/entitlement', () => {
    const actual = jest.requireActual('@/app-layer/integrations/providers/entra-id/entitlement');
    return {
        // SPREAD: `expiryRefusal`, `MAX_GRANT_DAYS` and
        // `runsLongerThanRequested`'s collaborators stay REAL. Only the network
        // client is replaced.
        ...actual,
        createEntraEntitlementClient: () => ({
            readAssignments: readAssignmentsMock,
            requestTimeBoundedAssignment: requestMock,
        }),
    };
});

import {
    grantTimeBoundedAccess,
    runsLongerThanRequested,
} from '@/app-layer/usecases/entra-grant-dispatch';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('OWNER', { tenantId: 'tenant-A' });
const NOW = new Date('2026-10-09T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const REQUESTED = new Date(NOW.getTime() + 7 * DAY); // 2026-10-16

const SECRETS = JSON.stringify({
    tenantId: '0fc6f345-0eee-4408-89a9-96fdd1b6439d',
    clientId: 'e8c77dc2-69b3-43f4-bc51-3213c9d915b4',
    clientSecret: 'shh', // pragma: allowlist secret -- test fixture
});

const grant = {
    targetId: '46184453-e63b-4f20-86c2-c557ed5d5df9',
    accessPackageId: 'a914b616-e04e-476b-aa37-91038f0b165b',
    assignmentPolicyId: '2264bf65-76ba-417b-a27d-54d291f0cbc8',
    endDateTime: REQUESTED,
};

const assignment = (over: Record<string, unknown> = {}) => ({
    assignmentId: 'asg-1',
    accessPackageId: grant.accessPackageId,
    state: 'delivered',
    endDateTime: new Date(NOW.getTime() + 30 * DAY).toISOString(),
    liveness: 'live' as const,
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    findManyMock.mockResolvedValue([{ id: 'conn-1', configJson: {}, secretEncrypted: SECRETS }]);
    readAssignmentsMock.mockResolvedValue({ all: [], live: [] });
    requestMock.mockResolvedValue({ requestId: 'req-1' });
});

describe('runsLongerThanRequested — unknown never means shorter', () => {
    it.each([
        ['a later end date', new Date(NOW.getTime() + 30 * DAY).toISOString(), true],
        ['an earlier end date', new Date(NOW.getTime() + 1 * DAY).toISOString(), false],
        ['EXACTLY the requested date', REQUESTED.toISOString(), false],
        ['no end date at all — a permanent holding', null, true],
        ['an empty end date', '', true],
        ['a date that will not parse', 'next Thursday', true],
    ])('%s -> %s', (_label, endDateTime, expected) => {
        expect(runsLongerThanRequested({ endDateTime }, REQUESTED)).toBe(expected);
    });

    it('an unreadable date is not evidence that it ends sooner', () => {
        // Stated as its own test because it is the judgement call, not an edge
        // case: letting the grant through on the strength of a value nobody
        // could read would cause exactly the harm this check prevents.
        expect(runsLongerThanRequested({ endDateTime: 'garbage' }, REQUESTED)).toBe(true);
    });
});

describe('a grant that would shorten existing access is refused, not attempted', () => {
    it('REFUSES when a live assignment runs longer, and sends nothing', async () => {
        readAssignmentsMock.mockResolvedValue({ all: [assignment()], live: [assignment()] });
        const out = await grantTimeBoundedAccess(ctx, grant, NOW);
        expect(out.ok).toBe(false);
        // The only way to state "nothing was sent".
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('the refusal names the existing end date and what to do', async () => {
        readAssignmentsMock.mockResolvedValue({ all: [assignment()], live: [assignment()] });
        const out = await grantTimeBoundedAccess(ctx, grant, NOW);
        const text = out.ok === false ? out.refused : '';
        expect(text).toContain('already holds');
        expect(text).toContain('2026-11-08'); // NOW + 30 days
        expect(text).toContain('Request a later end date');
        // Says it did nothing, so a reader does not have to infer it.
        expect(text).toContain('nothing was sent');
    });

    it('reads the prior state BEFORE writing, never after', async () => {
        // An implementation that verified afterwards would satisfy nothing:
        // #3300 says so in as many words. Order is asserted by the call
        // sequence, which is the only thing that can express it.
        readAssignmentsMock.mockResolvedValue({ all: [], live: [] });
        await grantTimeBoundedAccess(ctx, grant, NOW);
        expect(readAssignmentsMock).toHaveBeenCalled();
        expect(requestMock).toHaveBeenCalled();
        const readAt = readAssignmentsMock.mock.invocationCallOrder[0];
        const wroteAt = requestMock.mock.invocationCallOrder[0];
        expect(readAt).toBeLessThan(wroteAt);
    });

    it('scopes the read to the SAME subject and package the write targets', async () => {
        // A read returning tenant-wide state would technically pair while
        // capturing nothing about this subject — the control-that-cannot-fail
        // shape #3300 warns about.
        await grantTimeBoundedAccess(ctx, grant, NOW);
        expect(readAssignmentsMock).toHaveBeenCalledWith({
            targetId: grant.targetId,
            accessPackageId: grant.accessPackageId,
        });
    });
});

describe('what must NOT be mistaken for a holding', () => {
    it('an EXPIRED assignment running longer does not block the grant', async () => {
        // The #3326 case, and the direction that matters: a lapsed assignment
        // with a later stored end date is history, not access. Refusing here
        // would deny the grant that is exactly what the subject needs.
        const lapsed = assignment({ state: 'expired', liveness: 'inactive' });
        readAssignmentsMock.mockResolvedValue({ all: [lapsed], live: [] });
        const out = await grantTimeBoundedAccess(ctx, grant, NOW);
        expect(out.ok).toBe(true);
        expect(requestMock).toHaveBeenCalled();
    });

    it('a live assignment ending SOONER does not block the grant — an extension', async () => {
        const shorter = assignment({
            endDateTime: new Date(NOW.getTime() + 1 * DAY).toISOString(),
        });
        readAssignmentsMock.mockResolvedValue({ all: [shorter], live: [shorter] });
        const out = await grantTimeBoundedAccess(ctx, grant, NOW);
        expect(out.ok).toBe(true);
    });

    it('no assignments at all proceeds — the positive control', async () => {
        // Paired with the refusals above, so "refuses" is about the prior state
        // and not about this function refusing everything.
        const out = await grantTimeBoundedAccess(ctx, grant, NOW);
        expect(out.ok).toBe(true);
        expect(out.ok && out.requestId).toBe('req-1');
    });

    it('a BAD EXPIRY still costs no read at all', async () => {
        // The expiry refusal runs before the connection resolve, so it must
        // also run before this new read. Otherwise a grant that must not happen
        // would touch the customer's directory to find that out.
        await grantTimeBoundedAccess(
            ctx,
            { ...grant, endDateTime: new Date(NOW.getTime() - DAY) },
            NOW,
        );
        expect(readAssignmentsMock).not.toHaveBeenCalled();
        expect(requestMock).not.toHaveBeenCalled();
    });
});
