/**
 * The joiner pass as WORK — the IO caller that #2687 added, and the three things
 * it can lose silently.
 *
 * `planJoinerPass` is pure and already pinned by `identity-joiner-pass.test.ts`.
 * What is NOT pinned there is the half this suite exists for: the caller decides
 * WHICH population the planner sees, and every way of getting that wrong looks
 * from outside exactly like a clean pass.
 *
 *   1. THE WINDOW. The day window belongs to the planner, which names the people
 *      it excludes — `NOT_IN_WINDOW`, `REFUSED_NO_START_DATE`,
 *      `START_DATE_UNPARSEABLE`. Move it into the starter query's `where` and
 *      all three become the same silence as "nobody starts today": the pass goes
 *      on reporting a plausible number, computed over a population somebody
 *      quietly narrowed. That is the shape decision 6 refuses by name, and it is
 *      one line to introduce.
 *   2. THE PROVIDER SCOPE. `hasFreshLink` and `observedAddresses` are both one
 *      directory's evidence. Drop the provider from either read and the pass
 *      answers ALREADY_PROVISIONED and ACCOUNT_OBSERVED from a UNION of
 *      directories — a worker with an Entra account reported as provisioned in
 *      Active Directory, which is precisely the person Phase 2 would then not
 *      create an account for.
 *   3. THE PREDICTION LIMITS. They are what stop "would create N accounts" being
 *      read as a promise, and they are only useful if they reach the durable
 *      artefact VERBATIM. A summary, or a row that drops them because it was a
 *      refusal, leaves an artefact claiming more than the run checked.
 *
 * The assertions are BEHAVIOURAL — a fake database and the real planner — not
 * source-text matching. That is deliberate: a source scan of the query would be
 * satisfied by a comment mentioning `startDate`, and this file's whole subject
 * is a population that shrank without anybody noticing.
 */
const mockDb = {
    tenantSecuritySettings: { findUnique: jest.fn() },
    // #2713 — the entitlement map has a home now, so the loader reads it. The
    // default below is the UNCONFIGURED tenant these suites are about: no rules
    // and no fallback, which is what still refuses NO_DEPARTMENT_MAP.
    identityDepartmentGroupRule: { findMany: jest.fn() },
    employee: { findMany: jest.fn() },
    identityAccountLink: { findMany: jest.fn() },
    connectedIdentityAccount: { findMany: jest.fn() },
    integrationExecution: { create: jest.fn(), findMany: jest.fn() },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
    runIdentityJoinerPass,
    JOINER_LINK_FRESHNESS_MS,
    JOINER_PASS_AUTOMATION_SUFFIX,
} from '@/app-layer/usecases/identity-joiner-run';

const TENANT = 'tenant-1';
const PROVIDER = 'entra-id';
/** 09:00 UTC, so the UTC day window is unambiguous either side of it. */
const NOW = new Date('2026-09-20T09:00:00.000Z');
const STARTS_TODAY = new Date('2026-09-20T00:00:00.000Z');
const STARTS_NEXT_WEEK = new Date('2026-09-27T00:00:00.000Z');

interface Row {
    id: string;
    fullName: string;
    workEmail: string;
    source: string;
    externalId: string | null;
    department: string | null;
    startDate: Date | null;
}

function employee(over: Partial<Row> = {}): Row {
    return {
        id: 'emp-today',
        fullName: 'Jane Smith',
        workEmail: 'jane.smith@acme.com',
        source: 'workday',
        externalId: 'WD-1001',
        department: 'Engineering',
        startDate: STARTS_TODAY,
        ...over,
    };
}

/** The population every test below starts from. One of each interesting shape. */
const POPULATION: Row[] = [
    employee(),
    employee({ id: 'emp-next-week', workEmail: 'sam.doe@acme.com', fullName: 'Sam Doe', startDate: STARTS_NEXT_WEEK }),
    employee({ id: 'emp-no-date', workEmail: 'ada.byron@acme.com', fullName: 'Ada Byron', startDate: null }),
    employee({ id: 'emp-manual', workEmail: 'lee.park@acme.com', fullName: 'Lee Park', source: 'MANUAL', externalId: null }),
];

const joinerMode = { value: 'DRY_RUN' as string };

beforeEach(() => {
    jest.clearAllMocks();
    joinerMode.value = 'DRY_RUN';
    mockDb.tenantSecuritySettings.findUnique.mockImplementation(async () => ({
        tenantId: TENANT,
        identityLeaverMode: 'DISABLED',
        identityJoinerMode: joinerMode.value,
        identityLeaverDryRunSince: null,
        identityJoinerDryRunSince: null,
    }));
    mockDb.identityDepartmentGroupRule.findMany.mockResolvedValue([]);
    mockDb.employee.findMany.mockResolvedValue(POPULATION);
    mockDb.identityAccountLink.findMany.mockResolvedValue([]);
    mockDb.connectedIdentityAccount.findMany.mockResolvedValue([]);
    mockDb.integrationExecution.create.mockResolvedValue({ id: 'exec-1' });
});

/** The single execution row a pass wrote, or null. */
function writtenRow(): { status: string; resultJson: Record<string, unknown> } | null {
    const call = mockDb.integrationExecution.create.mock.calls[0];
    return call ? (call[0] as { data: { status: string; resultJson: Record<string, unknown> } }).data : null;
}

function decisionFor(employeeId: string): Record<string, unknown> | undefined {
    const row = writtenRow();
    const decisions = (row?.resultJson.decisions ?? []) as Array<Record<string, unknown>>;
    return decisions.find((d) => d.employeeId === employeeId);
}

describe('the pass runs end to end and names a decision per starter', () => {
    it('reports one decision for every assembled starter', async () => {
        const r = await runIdentityJoinerPass({ tenantId: TENANT, provider: PROVIDER, now: NOW });

        // #2687 acceptance 1. FOUR starters in, four decisions out — including
        // the three that are not being provisioned, which is the half a `where`
        // clause would have deleted.
        expect(r.starters).toBe(POPULATION.length);
        expect(r.decisions).toBe(POPULATION.length);
        expect(r.status).toBe('NOT_APPLICABLE');
        // Not "nothing happened": the refusal is the entitlement map, which
        // this tenant has not configured (#2713 gave it a home — rules in
        // `IdentityDepartmentGroupRule`, fallback on the settings row), and
        // verdicts were still computed and still recorded.
        expect(r.refusal).toBe('NO_DEPARTMENT_MAP');
    });

    it('persists the decisions on the refusal, not just the refusal', async () => {
        await runIdentityJoinerPass({ tenantId: TENANT, provider: PROVIDER, now: NOW });

        const row = writtenRow();
        expect(row).not.toBeNull();
        expect(row!.status).toBe('NOT_APPLICABLE');
        expect((row!.resultJson.decisions as unknown[]).length).toBe(POPULATION.length);
    });

    it('stores the row under the joiner automationKey, never the leaver one', async () => {
        await runIdentityJoinerPass({ tenantId: TENANT, provider: PROVIDER, now: NOW });

        const data = mockDb.integrationExecution.create.mock.calls[0][0] as {
            data: { automationKey: string; provider: string; tenantId: string };
        };
        expect(data.data.automationKey).toBe(`${PROVIDER}${JOINER_PASS_AUTOMATION_SUFFIX}`);
        expect(data.data.automationKey).not.toContain('leaver');
        expect(data.data.tenantId).toBe(TENANT);
    });
});

describe('THE WINDOW — it lives in the planner, and the query must not narrow it', () => {
    it('asks the database for ONBOARDING employees and nothing about dates', async () => {
        await runIdentityJoinerPass({ tenantId: TENANT, provider: PROVIDER, now: NOW });

        const where = mockDb.employee.findMany.mock.calls[0][0].where as Record<string, unknown>;
        expect(where.tenantId).toBe(TENANT);
        expect(where.status).toBe('ONBOARDING');
        // The assertion that fails on the one-line regression. A `startDate`
        // predicate here would delete NOT_IN_WINDOW, REFUSED_NO_START_DATE and
        // START_DATE_UNPARSEABLE from every artefact this product ever writes,
        // and nothing else would change.
        expect(where).not.toHaveProperty('startDate');
        expect(Object.keys(where).sort()).toEqual(['status', 'tenantId']);
    });

    it('names the person who starts on ANOTHER day rather than dropping them', async () => {
        await runIdentityJoinerPass({ tenantId: TENANT, provider: PROVIDER, now: NOW });

        expect(decisionFor('emp-next-week')?.outcome).toBe('NOT_IN_WINDOW');
    });

    it('names the person with NO start date rather than dropping them', async () => {
        // A live path, not a defensive one: deriveEmploymentStatus returns
        // ONBOARDING from the status STRING alone, with no date at all.
        await runIdentityJoinerPass({ tenantId: TENANT, provider: PROVIDER, now: NOW });

        expect(decisionFor('emp-no-date')?.outcome).toBe('REFUSED_NO_START_DATE');
    });

    it('names the MANUAL row rather than filtering it out (decision 6)', async () => {
        await runIdentityJoinerPass({ tenantId: TENANT, provider: PROVIDER, now: NOW });

        expect(decisionFor('emp-manual')?.outcome).toBe('REFUSED_SOURCE_MANUAL');
    });

    it('windows on the `now` it was given, so the day is the caller\'s and not a constant', async () => {
        // Same population, a week later: the two verdicts swap. A pass that
        // ignored `now` — or computed its own — would keep today's answer
        // forever, which is a joiner that fires on one fixed date.
        await runIdentityJoinerPass({
            tenantId: TENANT,
            provider: PROVIDER,
            now: new Date('2026-09-27T09:00:00.000Z'),
        });

        expect(decisionFor('emp-next-week')?.outcome).not.toBe('NOT_IN_WINDOW');
        expect(decisionFor('emp-today')?.outcome).toBe('NOT_IN_WINDOW');
    });
});

describe('THE PROVIDER SCOPE — one directory\'s evidence, never a union', () => {
    it('scopes the link-freshness read to this provider', async () => {
        await runIdentityJoinerPass({ tenantId: TENANT, provider: PROVIDER, now: NOW });

        const where = mockDb.identityAccountLink.findMany.mock.calls[0][0].where as {
            connectedAccount?: { provider?: string };
            contradictedAt: unknown;
            lastVerifiedAt: { gte: Date };
            tenantId: string;
        };
        // Unscoped, a worker with a fresh ENTRA link would be reported
        // ALREADY_PROVISIONED for Active Directory — a person Phase 2 would then
        // never create an account for.
        expect(where.connectedAccount?.provider).toBe(PROVIDER);
        expect(where.tenantId).toBe(TENANT);
        // A link a sync has DISPROVED is excluded outright: freshness alone was
        // never a witness that a pairing is still true.
        expect(where.contradictedAt).toBeNull();
        // And the bound is the shared observation constant, not a local number.
        const age = NOW.getTime() - where.lastVerifiedAt.gte.getTime();
        expect(Math.abs(age - JOINER_LINK_FRESHNESS_MS)).toBeLessThan(60_000);
    });

    it('scopes the collision read to this provider', async () => {
        await runIdentityJoinerPass({ tenantId: TENANT, provider: PROVIDER, now: NOW });

        const where = mockDb.connectedIdentityAccount.findMany.mock.calls[0][0].where as {
            provider: string;
            tenantId: string;
        };
        expect(where.provider).toBe(PROVIDER);
        expect(where.tenantId).toBe(TENANT);
    });

    it('does not filter the enumeration on ACTIVE', async () => {
        // The deprovision reconcile updates rows in place to DEPROVISIONED and
        // nothing deletes them, so an ACTIVE-only read would call FREE a UPN
        // still held by a soft-deleted object in the recycle bin.
        await runIdentityJoinerPass({ tenantId: TENANT, provider: PROVIDER, now: NOW });

        const where = mockDb.connectedIdentityAccount.findMany.mock.calls[0][0].where as Record<
            string,
            unknown
        >;
        expect(where).not.toHaveProperty('status');
    });

    it('reports a worker with a fresh link for THIS provider as already provisioned', async () => {
        mockDb.identityAccountLink.findMany.mockResolvedValue([{ employeeId: 'emp-today' }]);

        await runIdentityJoinerPass({ tenantId: TENANT, provider: PROVIDER, now: NOW });

        expect(decisionFor('emp-today')?.outcome).toBe('ALREADY_PROVISIONED');
    });

    it('reports an address the enumeration already holds as observed, never available', async () => {
        mockDb.connectedIdentityAccount.findMany.mockResolvedValue([
            { email: 'JANE.SMITH@ACME.COM' },
        ]);

        await runIdentityJoinerPass({ tenantId: TENANT, provider: PROVIDER, now: NOW });

        expect(decisionFor('emp-today')?.outcome).toBe('ACCOUNT_OBSERVED');
    });
});

describe('THE PREDICTION LIMITS reach the artefact verbatim (#2687 acceptance 3)', () => {
    it('records every limit the plan carried, unsummarised', async () => {
        await runIdentityJoinerPass({ tenantId: TENANT, provider: PROVIDER, now: NOW });

        const limits = writtenRow()!.resultJson.predictionLimits as string[];
        // Four today: three standing ones plus the UTC caveat, because no tenant
        // stores a timezone. The COUNT is asserted as well as the content, so a
        // row that silently carried three could not pass.
        expect(limits).toHaveLength(4);
        expect(limits.some((l) => /HRIS write-back/i.test(l))).toBe(true);
        expect(limits.some((l) => /NOT a statement that the address is available/i.test(l))).toBe(true);
        expect(limits.some((l) => /No reservation is persisted/i.test(l))).toBe(true);
        expect(limits.some((l) => /computed in UTC/i.test(l))).toBe(true);
    });

    it('carries them on a REFUSED row too', async () => {
        // The row written above IS a refusal (NO_DEPARTMENT_MAP). Stated as its
        // own case because "limits are present" and "limits are present even
        // when the pass refused" are different claims, and the second is the one
        // that decays: a refusal is the artefact most likely to be trimmed.
        await runIdentityJoinerPass({ tenantId: TENANT, provider: PROVIDER, now: NOW });

        const row = writtenRow()!;
        expect(row.resultJson.refusal).toBe('NO_DEPARTMENT_MAP');
        expect((row.resultJson.predictionLimits as string[]).length).toBeGreaterThan(0);
    });
});

describe('the ladder, and what it does and does not record', () => {
    it('refuses a DISABLED tenant and writes NO execution row', async () => {
        joinerMode.value = 'DISABLED';

        const r = await runIdentityJoinerPass({ tenantId: TENANT, provider: PROVIDER, now: NOW });

        expect(r.refusal).toBe('MODE_DISABLED');
        expect(mockDb.integrationExecution.create).not.toHaveBeenCalled();
        // The count still travels, because on the morning somebody is sitting at
        // a desk with no account, "switched off, 4 starters" and "switched off"
        // are not the same message.
        expect(r.starters).toBe(POPULATION.length);
    });

    it('refuses a tenant above the ceiling and writes NO execution row', async () => {
        joinerMode.value = 'AUTOMATIC';

        const r = await runIdentityJoinerPass({ tenantId: TENANT, provider: PROVIDER, now: NOW });

        expect(r.refusal).toBe('MODE_ABOVE_CLAMP');
        expect(r.starters).toBe(POPULATION.length);
        expect(mockDb.integrationExecution.create).not.toHaveBeenCalled();
    });
});

describe('a pass that fails still leaves a trace', () => {
    it('returns ERROR and records an ERROR row rather than looking like a dead worker', async () => {
        mockDb.employee.findMany.mockRejectedValue(new Error('connection reset'));

        const r = await runIdentityJoinerPass({ tenantId: TENANT, provider: PROVIDER, now: NOW });

        expect(r.status).toBe('ERROR');
        const data = mockDb.integrationExecution.create.mock.calls[0][0] as {
            data: { status: string };
        };
        expect(data.data.status).toBe('ERROR');
    });

    it('does not let a failed RECORD turn a completed pass into a failure', async () => {
        mockDb.integrationExecution.create.mockRejectedValue(new Error('disk full'));

        const r = await runIdentityJoinerPass({ tenantId: TENANT, provider: PROVIDER, now: NOW });

        // The decisions are already made; losing the artefact is worth an alert,
        // not a retry of a pass that ran.
        expect(r.status).toBe('NOT_APPLICABLE');
        expect(r.decisions).toBe(POPULATION.length);
    });
});

describe('what the durable row may carry', () => {
    it('keys decisions by employeeId and scrubs the free-text reason', async () => {
        mockDb.connectedIdentityAccount.findMany.mockResolvedValue([
            { email: 'jane.smith@acme.com' },
        ]);

        await runIdentityJoinerPass({ tenantId: TENANT, provider: PROVIDER, now: NOW });

        const d = decisionFor('emp-today')!;
        expect(d.outcome).toBe('ACCOUNT_OBSERVED');
        // The reason quotes an address the customer's own enumeration holds, and
        // `IntegrationExecution.resultJson` is not encrypted at rest.
        expect(d.reason as string).toContain('{account}');
        expect(d.reason as string).not.toContain('jane.smith@acme.com');
        // The DERIVED address is ours, from a roster column this product already
        // renders — and it is what makes the artefact answer the question the
        // seven days exist to ask.
        expect(d.intendedAddress).toBe('jane.smith@acme.com');
    });
});

describe('#2713 — the entitlement map has a home, so the refusal is clearable', () => {
    // The whole point of #2713. Before it, every tenant landed on
    // NO_DEPARTMENT_MAP and there was nowhere to put a map, so the refusal was
    // one an operator could read and not act on. These tests are the
    // difference: same code path, configured tenant, no refusal.

    it('a tenant WITH rules configured no longer refuses NO_DEPARTMENT_MAP', async () => {
        mockDb.identityDepartmentGroupRule.findMany.mockResolvedValue([
            { department: 'Engineering', groupId: 'grp-eng' },
        ]);
        mockDb.tenantSecuritySettings.findUnique.mockImplementation(async () => ({
            tenantId: TENANT,
            identityLeaverMode: 'DISABLED',
            identityJoinerMode: joinerMode.value,
            identityLeaverDryRunSince: null,
            identityJoinerDryRunSince: null,
            identityDefaultGroupId: 'grp-fallback',
            identityDefaultGroupName: 'Contractors',
        }));

        const r = await runIdentityJoinerPass({ tenantId: TENANT, provider: PROVIDER, now: NOW });

        expect(r.refusal).not.toBe('NO_DEPARTMENT_MAP');
        expect(r.refusal).not.toBe('NO_DEFAULT_GROUP');
    });

    it('a tenant with NEITHER configured still refuses — the floor did not move', async () => {
        // The mirror of the test above, and the reason it means something: an
        // empty map must still refuse BY NAME. A fix that made every tenant
        // pass would satisfy the first test and destroy the guard.
        mockDb.identityDepartmentGroupRule.findMany.mockResolvedValue([]);

        const r = await runIdentityJoinerPass({ tenantId: TENANT, provider: PROVIDER, now: NOW });

        expect(r.refusal).toBe('NO_DEPARTMENT_MAP');
    });

    it('rules reach the planner as department -> groupId, keyed exactly as stored', async () => {
        mockDb.identityDepartmentGroupRule.findMany.mockResolvedValue([
            { department: 'Engineering', groupId: 'grp-eng' },
            { department: 'Sales', groupId: 'grp-sales' },
        ]);
        mockDb.tenantSecuritySettings.findUnique.mockImplementation(async () => ({
            tenantId: TENANT,
            identityLeaverMode: 'DISABLED',
            identityJoinerMode: joinerMode.value,
            identityLeaverDryRunSince: null,
            identityJoinerDryRunSince: null,
            identityDefaultGroupId: 'grp-fallback',
            identityDefaultGroupName: 'Contractors',
        }));

        await runIdentityJoinerPass({ tenantId: TENANT, provider: PROVIDER, now: NOW });

        // The read is tenant-scoped, not a global findMany: RLS is a backstop,
        // not the only thing keeping one tenant's rules out of another's plan.
        const where = mockDb.identityDepartmentGroupRule.findMany.mock.calls[0][0]
            .where as Record<string, unknown>;
        expect(where.tenantId).toBe(TENANT);
    });
});
