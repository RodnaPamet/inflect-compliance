/**
 * A plan the planner REFUSED creates nothing, at any rung (owner decision
 * 2026-11-14).
 *
 * `runIdentityJoinerPass` used to hand every plan above DRY_RUN to
 * `executePlannedCreates` without reading `plan.refusal`. Three of the
 * planner's refusals — `BATCH_OVER_CAP`, `NO_DEPARTMENT_MAP` and
 * `NO_DEFAULT_GROUP` — still carry their per-starter decisions, PLANNED ones
 * included, because the identity verdicts are the point of the rung. So at
 * AUTOMATIC a refused plan went on to create accounts in the customer's
 * directory: the cap that exists to stop thirty "starters" from one bad roster
 * morning was a sentence on the row and nothing more.
 *
 * Behavioural, with the REAL planner: each refusal is produced the way a tenant
 * produces it (six starters today; no department rules; rules but no fallback),
 * so the test cannot pass on a hand-built plan the real planner would never
 * return. A positive control proves the same fixture creates when nothing is
 * refused — without it, "no creates" could be the fixture failing to plan.
 */
const mockDb = {
    tenantSecuritySettings: { findUnique: jest.fn() },
    identityDepartmentGroupRule: { findMany: jest.fn() },
    employee: { findMany: jest.fn() },
    identityAccountLink: { findMany: jest.fn() },
    connectedIdentityAccount: { findMany: jest.fn() },
    integrationExecution: { create: jest.fn(), updateMany: jest.fn(), findMany: jest.fn() },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockResolveProvisioner = jest.fn();
const mockResolveWriter = jest.fn();
const mockCreateAccount = jest.fn();
const mockProbe = jest.fn();

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
import { MAX_CREATES_PER_RUN } from '@/app-layer/usecases/identity-joiner-pass';

const TENANT = 'tenant-1';
const PROVIDER = 'entra-id';
const NOW = new Date('2026-09-20T09:00:00.000Z');
const STARTS_TODAY = new Date('2026-09-20T00:00:00.000Z');
const ENG_GROUP = 'group-eng';
const FALLBACK_GROUP = 'group-fallback';

const NAMES = ['Jane Smith', 'Sam Doe', 'Ada Byron', 'Lee Park', 'Kim Lane', 'Max Ward', 'Ivy Ross'];

/** A starter the real planner PLANS: HRIS-sourced, starts today, derivable. */
function starter(i: number) {
    const name = NAMES[i];
    const [first, last] = name.toLowerCase().split(' ');
    return {
        id: `emp-${i}`,
        fullName: name,
        workEmail: `${first}.${last}@acme.com`,
        source: 'workday',
        externalId: `WD-${1000 + i}`,
        department: fixture.departments[i] ?? 'Engineering',
        startDate: STARTS_TODAY,
    };
}

const fixture = {
    starters: 1,
    /** Per-index department override; anything absent is the mapped one. */
    departments: {} as Record<number, string>,
    rules: [{ department: 'Engineering', groupId: ENG_GROUP }] as Array<{ department: string; groupId: string }>,
    defaultGroupId: FALLBACK_GROUP as string | null,
};

beforeEach(() => {
    jest.clearAllMocks();
    fixture.starters = 1;
    fixture.departments = {};
    fixture.rules = [{ department: 'Engineering', groupId: ENG_GROUP }];
    fixture.defaultGroupId = FALLBACK_GROUP;

    mockDb.tenantSecuritySettings.findUnique.mockImplementation(async () => ({
        tenantId: TENANT,
        identityLeaverMode: 'DISABLED',
        identityJoinerMode: 'AUTOMATIC',
        identityLeaverDryRunSince: null,
        identityJoinerDryRunSince: null,
        identityDefaultGroupId: fixture.defaultGroupId,
        identityDefaultGroupName: fixture.defaultGroupId ? 'Everyone' : null,
    }));
    mockDb.identityDepartmentGroupRule.findMany.mockImplementation(async () => fixture.rules);
    mockDb.employee.findMany.mockImplementation(async () =>
        Array.from({ length: fixture.starters }, (_, i) => starter(i)),
    );
    mockDb.identityAccountLink.findMany.mockResolvedValue([]);
    mockDb.connectedIdentityAccount.findMany.mockResolvedValue([]);
    mockDb.integrationExecution.create.mockResolvedValue({ id: 'exec-1' });
    mockDb.integrationExecution.updateMany.mockResolvedValue({ count: 1 });

    mockProbe.mockResolvedValue({ kind: 'free', namespacesChecked: ['userPrincipalName'] });
    mockResolveProvisioner.mockResolvedValue({
        kind: 'live',
        provisioner: { provider: PROVIDER, probeIdentifier: mockProbe },
        close: jest.fn(async () => undefined),
    });
    mockResolveWriter.mockResolvedValue({
        kind: 'live',
        writer: { provider: PROVIDER, disable: jest.fn(), readState: jest.fn() },
        close: jest.fn(async () => undefined),
        readiness: { readiness: 'DEDICATED_WRITE_BIND', detail: 'fixture' },
    });
    mockCreateAccount.mockResolvedValue({ kind: 'APPLIED', externalUserId: 'ext-1' });
});

const run = () => runIdentityJoinerPass({ tenantId: TENANT, provider: PROVIDER, now: NOW });

/** The one row the pass wrote. */
function writtenRow(): { status: string; resultJson: Record<string, unknown> } {
    expect(mockDb.integrationExecution.create).toHaveBeenCalledTimes(1);
    return (mockDb.integrationExecution.create.mock.calls[0][0] as {
        data: { status: string; resultJson: Record<string, unknown> };
    }).data;
}

describe('positive control — the same fixture CREATES when nothing is refused', () => {
    it('plans and creates the one starter at AUTOMATIC', async () => {
        const r = await run();

        expect(r.refusal).toBeNull();
        expect(r.wouldCreate).toBe(1);
        expect(mockCreateAccount).toHaveBeenCalledTimes(1);
        expect(r.created).toBe(1);
    });

    it('needs no fallback when every planned starter is mapped (#5317 item 41)', async () => {
        // Clearing the fallback used to refuse every pass NO_DEFAULT_GROUP,
        // mapped or not. A planned starter in a mapped department needs no
        // fallback, so the pass plans and creates as before.
        fixture.defaultGroupId = null;

        const r = await run();

        expect(r.refusal).toBeNull();
        expect(mockCreateAccount).toHaveBeenCalledTimes(1);
        const req = mockCreateAccount.mock.calls[0][1] as { groupId: string };
        expect(req.groupId).toBe(ENG_GROUP);
        expect(r.created).toBe(1);
    });
});

describe.each([
    {
        refusal: 'BATCH_OVER_CAP',
        arrange: () => {
            fixture.starters = MAX_CREATES_PER_RUN + 1;
        },
    },
    {
        refusal: 'NO_DEPARTMENT_MAP',
        arrange: () => {
            fixture.rules = [];
        },
    },
    {
        refusal: 'NO_DEFAULT_GROUP',
        arrange: () => {
            // One starter needs the fallback (Sales is unmapped) and there is
            // none. The OTHER starter's department is mapped, so its decision
            // carries a group — the shape that would otherwise have reached a
            // create.
            fixture.starters = 2;
            fixture.departments = { 1: 'Sales' };
            fixture.defaultGroupId = null;
        },
    },
])('a plan refused $refusal at AUTOMATIC', ({ refusal, arrange }) => {
    beforeEach(arrange);

    it('is refused by the real planner, with PLANNED decisions still in it', async () => {
        const r = await run();

        expect(r.refusal).toBe(refusal);
        const decisions = writtenRow().resultJson.decisions as Array<{ outcome: string }>;
        // The precondition for the defect: a refused plan still carries the
        // starters it would have created. Without one, the test proves nothing.
        expect(decisions.some((d) => d.outcome === 'PLANNED')).toBe(true);
    });

    it('constructs no provisioner and no writer, and creates nothing', async () => {
        const r = await run();

        expect(mockResolveProvisioner).not.toHaveBeenCalled();
        expect(mockResolveWriter).not.toHaveBeenCalled();
        expect(mockProbe).not.toHaveBeenCalled();
        // `createDirectoryAccount` is where the journal's `beginWrite` sits,
        // so not reaching it is also "no journal row".
        expect(mockCreateAccount).not.toHaveBeenCalled();
        expect(r.created).toBe(0);
    });

    it('records the refusal BY NAME on a NOT_APPLICABLE row, with no execution block', async () => {
        const r = await run();

        const row = writtenRow();
        expect(row.status).toBe('NOT_APPLICABLE');
        expect(row.resultJson.refusal).toBe(refusal);
        expect(r.status).toBe('NOT_APPLICABLE');
        // Nothing ran, so nothing is written over the plan's own row.
        expect(mockDb.integrationExecution.updateMany).not.toHaveBeenCalled();
    });
});
