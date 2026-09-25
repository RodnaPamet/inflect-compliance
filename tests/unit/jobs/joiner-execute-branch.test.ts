/**
 * The joiner ACTS on its plan — the branch #2674 and #2714 built everything
 * for and nobody called (#2843 findings 8 and 15).
 *
 * ═══ WHY THIS SUITE MOCKS THE CLAMP ═══
 *
 * `JOINER_MAX_MODE` is `DRY_RUN`, so the pass returns at the clamp before any
 * mode above it is reached. That is correct and is the point: the clamp is the
 * gate. But an assertion written against the real constant would be a vacuous
 * pass — the branch would never run and the test would prove nothing.
 *
 * So the ceiling is raised to `AUTOMATIC` for this suite, the same technique
 * `identity-write-ceiling-matches-the-pass` uses for the same reason. What
 * this proves is the shape BEHIND the clamp: that raising it produces creates
 * rather than, as before, nothing at all.
 */
const mockResolveProvisioner = jest.fn();
const mockResolveWriter = jest.fn();
const mockCreateAccount = jest.fn();
const mockDisable = jest.fn(async (_id: string, _prior: unknown) => undefined);
const mockPolicy = jest.fn();
const mockStarters = jest.fn();

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {}, prisma: {} }));
/**
 * Every model the pass reads, not just the ones this suite thinks about.
 *
 * A `{}` here is a SUBSET of what the code under test reaches for, and the
 * failure surfaces as the pass returning ERROR from its own catch — which
 * reads as "the branch did not run" rather than "the fixture was incomplete"
 * (#2897). One starter, no prior link, one department rule: the minimum that
 * yields a PLANNED decision.
 */
const START = new Date('2026-09-25T00:00:00.000Z');
const fakeDb = {
    employee: {
        findMany: jest.fn(async () => [
            {
                id: 'emp-1',
                fullName: 'Ada Lovelace',
                workEmail: 'ada.lovelace@corp.example.test',
                startDate: START,
                department: 'Engineering',
                status: 'ACTIVE',
                externalId: 'e-1',
            },
        ]),
    },
    identityAccountLink: { findMany: jest.fn(async () => []) },
    connectedIdentityAccount: { findMany: jest.fn(async () => []) },
    identityDepartmentGroupRule: {
        findMany: jest.fn(async () => [
            { department: 'Engineering', groupId: 'CN=Eng,DC=corp,DC=example,DC=test', groupName: 'Eng' },
        ]),
    },
    tenantSecuritySettings: { findUnique: jest.fn(async () => ({})) },
    integrationExecution: { create: jest.fn(async () => ({ id: 'x' })), findMany: jest.fn(async () => []) },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (db: unknown) => unknown) => fn(fakeDb),
}));

// The ceiling, raised. Over a `requireActual` spread so `planJoinerPass` and
// everything else this module exports stays real — a subset factory here is
// the #2897 shape, and the pass imports several of them.
// The ceiling raised AND the planner stubbed, because overriding the constant
// alone does not work: the real `planJoinerPass` computes `MODE_ABOVE_CLAMP`
// from its own reference to it, so the plan arrives already refused and the
// branch is never reached. The planner has its own suite; what is under test
// here is what the pass DOES with a plan.
//
// Over a `requireActual` spread — this module has a dozen exports the pass
// imports, and a subset factory is the #2897 shape.
jest.mock('@/app-layer/usecases/identity-joiner-pass', () => ({
    ...jest.requireActual('@/app-layer/usecases/identity-joiner-pass'),
    JOINER_MAX_MODE: 'AUTOMATIC',
    planJoinerPass: (args: { mode: string; starters: readonly { employeeId: string }[] }) => ({
        mode: args.mode,
        clamp: 'AUTOMATIC',
        refusal: null,
        detail: 'fixture plan',
        starters: args.starters.length,
        wouldCreate: args.starters.length,
        decisions: args.starters.map((c) => ({
            employeeId: c.employeeId,
            outcome: 'PLANNED',
            reason: null,
            intendedAddress: 'ada.lovelace@corp.example.test',
            rosterAddress: null,
            nameSource: 'ROSTER_DISPLAY_NAME',
            department: 'Engineering',
            groupId: 'CN=Eng,DC=corp,DC=example,DC=test',
            groupIsDefaultFallback: false,
        })),
    }),
}));
jest.mock('@/app-layer/usecases/identity-write-policy', () => ({
    ...jest.requireActual('@/app-layer/usecases/identity-write-policy'),
    getIdentityWritePolicy: (...a: unknown[]) => mockPolicy(...a),
}));
jest.mock('@/app-layer/integrations/identity-provisioner-factory', () => ({
    resolveDirectoryProvisioner: (...a: unknown[]) => mockResolveProvisioner(...a),
}));
jest.mock('@/app-layer/integrations/identity-writer-factory', () => ({
    ...jest.requireActual('@/app-layer/integrations/identity-writer-factory'),
    resolveDirectoryWriter: (...a: unknown[]) => mockResolveWriter(...a),
}));
jest.mock('@/app-layer/usecases/identity-create-account', () => ({
    ...jest.requireActual('@/app-layer/usecases/identity-create-account'),
    createDirectoryAccount: (...a: unknown[]) => mockCreateAccount(...a),
}));

import { runIdentityJoinerPass } from '@/app-layer/usecases/identity-joiner-run';

const closeProv = jest.fn(async () => undefined);
const closeWriter = jest.fn(async () => undefined);

const liveProvisioner = () => ({
    kind: 'live' as const,
    provisioner: { provider: 'active-directory' },
    close: closeProv,
});
const liveWriter = () => ({
    kind: 'live' as const,
    writer: { provider: 'active-directory', disable: mockDisable },
    close: closeWriter,
    readiness: { readiness: 'DEDICATED_WRITE_BIND' as const, detail: 'fixture' },
});

const run = () =>
    runIdentityJoinerPass({
        tenantId: 't-1',
        provider: 'active-directory',
        now: new Date('2026-09-26T00:00:00.000Z'),
    });

describe('the joiner acts on its plan once the clamp permits', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockPolicy.mockResolvedValue({
            joiner: { mode: 'AUTOMATIC', dryRunSince: null },
            leaver: { mode: 'DISABLED', dryRunSince: null },
        });
        mockResolveProvisioner.mockResolvedValue(liveProvisioner());
        mockResolveWriter.mockResolvedValue(liveWriter());
        mockCreateAccount.mockResolvedValue({ kind: 'APPLIED', externalUserId: 'ext-1' });
    });

    it('resolves a provisioner at all — which nothing in src/ did before', async () => {
        await run();
        expect(mockResolveProvisioner).toHaveBeenCalled();
    });

it('CREATES for a planned decision — the call nothing in src/ made before', async () => {
        const r = await run();

        expect(mockCreateAccount).toHaveBeenCalledTimes(1);
        expect(r.created).toBe(1);
    });

    it('takes the display name from the STARTER, which the decision does not carry', async () => {
        // `JoinerDecision` has `nameSource` but no name, and `DerivedIdentity`
        // has none either — so a create built from the decision alone would
        // have nothing to put in `displayName`.
        await run();

        const req = mockCreateAccount.mock.calls[0][1] as { candidate: { displayName: string } };
        expect(req.candidate.displayName).toBe('Ada Lovelace');
    });

    it('hands the undo the leaver verb, with the state the create left behind', async () => {
        // Decision 4: the rollback is the live-proven disable, injected. The
        // prior state is known rather than re-read — this pass enabled the
        // account moments ago.
        await run();

        const req = mockCreateAccount.mock.calls[0][1] as {
            disableCreated: (id: string) => Promise<void>;
        };
        await req.disableCreated('ext-9');

        expect(mockDisable).toHaveBeenCalledWith('ext-9', expect.objectContaining({ enabled: true }));
    });

    it('counts a partial as neither created nor refused', async () => {
        // The three PARTIAL_* states are terminal and real; collapsing them
        // into "created" would report an account that has no entitlements as
        // a success.
        mockCreateAccount.mockResolvedValue({ kind: 'PARTIAL_NO_GROUP', externalUserId: 'e' });

        const r = await run();

        expect(r.created).toBe(0);
    });

        it('REFUSES every create when the connection cannot also disable', async () => {
        // Decision 4 injects the undo as the leaver verb, and AD gates the two
        // grants separately. Create-without-disable would leave a partial
        // create nobody can reach, so the pass refuses before the first one.
        mockResolveWriter.mockResolvedValue({
            kind: 'none',
            refusal: 'WRITES_NOT_ENABLED',
            detail: 'no leaver grant',
        });

        await run();

        expect(mockCreateAccount).not.toHaveBeenCalled();
    });

    it('closes the provisioner it opened when it refuses for want of a writer', async () => {
        mockResolveWriter.mockResolvedValue({ kind: 'none', refusal: 'X', detail: 'd' });

        await run();

        expect(closeProv).toHaveBeenCalled();
    });

    it('does not act at DRY_RUN, where PLANNED is the terminal state', async () => {
        mockPolicy.mockResolvedValue({
            joiner: { mode: 'DRY_RUN', dryRunSince: new Date('2026-09-01T00:00:00.000Z') },
            leaver: { mode: 'DISABLED', dryRunSince: null },
        });

        await run();

        expect(mockResolveProvisioner).not.toHaveBeenCalled();
        expect(mockCreateAccount).not.toHaveBeenCalled();
    });
});
