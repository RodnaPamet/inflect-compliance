/**
 * Coverage wave E — `src/app-layer/integrations/providers/hris/index.ts`.
 *
 * The BambooHR reference HRIS provider. Two branch-dense surfaces:
 *   • the status mapping (H2) — ONBOARDING / OFFBOARDING are derived from
 *     hire/termination dates, not just the vendor's status string. Getting
 *     this wrong silently vacates `onboarding_complete_within_sla` and hides
 *     a mid-offboarding employee's lingering access, so every rung is pinned.
 *   • the roster fetch — per-field fallback chains, the MAX_EMPLOYEES cap,
 *     and the H3 `complete` flag that gates the departed-employee reconcile.
 *
 * `fetchImpl` is injected rather than stubbing global fetch, matching the
 * provider's own dependency seam.
 */
import {
    BambooHrProvider,
    isHrisSyncProvider,
    type NormalizedEmployee,
} from '@/app-layer/integrations/providers/hris';

const DAY = 86_400_000;
const future = () => new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10);
const past = () => new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);

/** Build a fetch stub returning one BambooHR custom-report page. */
const rosterFetch = (employees: unknown[], ok = true, status = 200) =>
    jest.fn().mockResolvedValue({
        ok,
        status,
        json: async () => ({ employees }),
    });

const baseRow = (over: Record<string, unknown> = {}) => ({
    employeeNumber: 'E-1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    workEmail: 'ada@acme.test',
    status: 'Active',
    ...over,
});

async function rosterOf(rows: unknown[]): Promise<NormalizedEmployee[]> {
    const provider = new BambooHrProvider({ fetchImpl: rosterFetch(rows) as never });
    const { employees } = await provider.listEmployees({
        subdomain: 'acme',
        apiKey: 'k',
    });
    return employees;
}

describe('isHrisSyncProvider', () => {
    it('accepts an object exposing listEmployees', () => {
        expect(isHrisSyncProvider(new BambooHrProvider())).toBe(true);
        expect(isHrisSyncProvider({ listEmployees: () => {} })).toBe(true);
    });

    it('rejects non-objects and objects without the method', () => {
        expect(isHrisSyncProvider(null)).toBe(false);
        expect(isHrisSyncProvider(undefined)).toBe(false);
        expect(isHrisSyncProvider('nope')).toBe(false);
        expect(isHrisSyncProvider({})).toBe(false);
        expect(isHrisSyncProvider({ listEmployees: 'not a function' })).toBe(false);
    });
});

describe('BambooHrProvider — descriptor', () => {
    it('declares no scheduled checks and non-live validation', () => {
        const p = new BambooHrProvider();
        expect(p.id).toBe('bamboohr');
        expect(p.supportedChecks).toEqual([]);
        expect(p.liveValidation).toBe(false);
        expect(p.configSchema.configFields[0].key).toBe('subdomain');
        expect(p.configSchema.secretFields[0].key).toBe('apiKey');
    });

    it('runCheck reports that it runs no checks, and maps no evidence', async () => {
        const p = new BambooHrProvider();
        const res = await p.runCheck();
        expect(res.status).toBe('ERROR');
        expect(res.errorMessage).toBe('no checks');
        expect(p.mapResultToEvidence({} as never, res)).toBeNull();
    });
});

describe('BambooHrProvider.validateConnection', () => {
    const p = new BambooHrProvider();

    it('requires a subdomain', async () => {
        const res = await p.validateConnection({}, { apiKey: 'k' });
        expect(res).toEqual({
            valid: false,
            error: 'A BambooHR subdomain is required.',
        });
    });

    it('requires an api key', async () => {
        const res = await p.validateConnection({ subdomain: 'acme' }, {});
        expect(res).toEqual({
            valid: false,
            error: 'A BambooHR API key is required.',
        });
    });

    it('accepts both present', async () => {
        expect(
            await p.validateConnection({ subdomain: 'acme' }, { apiKey: 'k' }),
        ).toEqual({ valid: true });
    });
});

describe('BambooHrProvider.listEmployees — injected override', () => {
    it('uses the injected lister and always reports complete', async () => {
        const listEmployees = jest.fn().mockResolvedValue([
            { externalId: 'x', fullName: 'X', workEmail: 'x@acme.test', status: 'ACTIVE' },
        ]);
        const provider = new BambooHrProvider({ listEmployees });

        const res = await provider.listEmployees({ subdomain: 'acme' });

        expect(listEmployees).toHaveBeenCalledWith({ subdomain: 'acme' });
        expect(res.complete).toBe(true);
        expect(res.employees).toHaveLength(1);
    });
});

describe('BambooHrProvider — roster fetch', () => {
    it('POSTs the custom-report endpoint with Basic auth', async () => {
        const fetchImpl = rosterFetch([baseRow()]);
        await new BambooHrProvider({ fetchImpl: fetchImpl as never }).listEmployees({
            subdomain: 'acme',
            apiKey: 'secret',
        });

        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe(
            'https://api.bamboohr.com/api/gateway.php/acme/v1/reports/custom?format=JSON',
        );
        expect(init.method).toBe('POST');
        // BambooHR uses the API key as the username with any password.
        expect(init.headers.Authorization).toBe(
            `Basic ${Buffer.from('secret:x').toString('base64')}`,
        );
        expect(JSON.parse(init.body).fields).toContain('workEmail');
    });

    it('throws with the status code on a non-ok response', async () => {
        const provider = new BambooHrProvider({
            fetchImpl: rosterFetch([], false, 401) as never,
        });
        await expect(
            provider.listEmployees({ subdomain: 'acme', apiKey: 'k' }),
        ).rejects.toThrow('BambooHR roster fetch failed (HTTP 401)');
    });

    it('tolerates a response with no employees key', async () => {
        const fetchImpl = jest
            .fn()
            .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        const res = await new BambooHrProvider({
            fetchImpl: fetchImpl as never,
        }).listEmployees({ subdomain: 'acme', apiKey: 'k' });
        expect(res).toEqual({ employees: [], complete: true });
    });

    it('maps a full row', async () => {
        const [e] = await rosterOf([
            baseRow({
                department: 'Eng',
                jobTitle: 'Engineer',
                supervisorEmail: 'boss@acme.test',
                hireDate: '2020-01-01',
            }),
        ]);
        expect(e).toMatchObject({
            externalId: 'E-1',
            fullName: 'Ada Lovelace',
            workEmail: 'ada@acme.test',
            status: 'ACTIVE',
            department: 'Eng',
            jobTitle: 'Engineer',
            managerEmail: 'boss@acme.test',
        });
        expect(e.startDate).toEqual(new Date('2020-01-01'));
        expect(e.endDate).toBeNull();
    });

    it('falls back through the externalId chain', async () => {
        expect(
            (await rosterOf([baseRow({ employeeNumber: '', id: 'ID-9' })]))[0].externalId,
        ).toBe('ID-9');
        expect(
            (await rosterOf([baseRow({ employeeNumber: '', id: '' })]))[0].externalId,
        ).toBe('ada@acme.test');
    });

    it('falls back to the email when there is no name', async () => {
        const [e] = await rosterOf([baseRow({ firstName: '', lastName: '' })]);
        expect(e.fullName).toBe('ada@acme.test');
    });

    it('joins only the name parts that are present', async () => {
        expect((await rosterOf([baseRow({ lastName: '' })]))[0].fullName).toBe('Ada');
        expect((await rosterOf([baseRow({ firstName: '' })]))[0].fullName).toBe(
            'Lovelace',
        );
    });

    it('nulls the optional fields when absent', async () => {
        const [e] = await rosterOf([baseRow()]);
        expect(e.department).toBeNull();
        expect(e.jobTitle).toBeNull();
        expect(e.managerEmail).toBeNull();
        expect(e.startDate).toBeNull();
    });

    it('drops rows with no work email', async () => {
        const rows = await rosterOf([
            baseRow(),
            baseRow({ workEmail: '', employeeNumber: 'E-2' }),
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0].externalId).toBe('E-1');
    });

    it('reports complete=true under the cap', async () => {
        const provider = new BambooHrProvider({
            fetchImpl: rosterFetch([baseRow()]) as never,
        });
        expect(
            (await provider.listEmployees({ subdomain: 'a', apiKey: 'k' })).complete,
        ).toBe(true);
    });

    it('truncates at the cap and reports complete=false (H3)', async () => {
        const rows = Array.from({ length: 10_001 }, (_, i) =>
            baseRow({ employeeNumber: `E-${i}`, workEmail: `u${i}@acme.test` }),
        );
        const provider = new BambooHrProvider({
            fetchImpl: rosterFetch(rows) as never,
        });

        const res = await provider.listEmployees({ subdomain: 'a', apiKey: 'k' });

        expect(res.employees).toHaveLength(10_000);
        // complete=false is what stops the departed-employee reconcile from
        // marking everyone past the cap as TERMINATED.
        expect(res.complete).toBe(false);
    });

    it('handles a missing subdomain / apiKey without throwing on string coercion', async () => {
        const fetchImpl = rosterFetch([]);
        await new BambooHrProvider({ fetchImpl: fetchImpl as never }).listEmployees({});
        expect(fetchImpl.mock.calls[0][0]).toContain('/gateway.php//v1/');
    });
});

describe('BambooHrProvider — status mapping (H2)', () => {
    const statusOf = async (row: Record<string, unknown>) =>
        (await rosterOf([baseRow(row)]))[0].status;

    it('maps terminated from either status field spelling', async () => {
        expect(await statusOf({ status: 'Terminated' })).toBe('TERMINATED');
        expect(await statusOf({ status: '', employmentStatus: 'terminate' })).toBe(
            'TERMINATED',
        );
    });

    it('maps leave', async () => {
        expect(await statusOf({ status: 'On Leave' })).toBe('LEAVE');
    });

    it('termination outranks leave', async () => {
        expect(await statusOf({ status: 'Terminated - Leave' })).toBe('TERMINATED');
    });

    it('derives OFFBOARDING from a future termination date', async () => {
        expect(
            await statusOf({ status: 'Active', terminationDate: future() }),
        ).toBe('OFFBOARDING');
    });

    it('a past termination date is TERMINATED — not OFFBOARDING, and not the "Active" the string claims', async () => {
        // Changed expectation, deliberately: this used to assert ACTIVE, back
        // when the status string outranked the dates here. Believing "Active"
        // over a last day that has already passed is what leaves a departed
        // worker's directory access enabled indefinitely — the exact hole
        // `offboarded_access_removed` exists to find. The test's own name has
        // always been "not OFFBOARDING", which TERMINATED satisfies.
        expect(await statusOf({ status: 'Active', terminationDate: past() })).toBe(
            'TERMINATED',
        );
        // The pair: with no date the string still decides, so the assertion
        // above is about precedence rather than about a dead branch.
        expect(await statusOf({ status: 'Active' })).toBe('ACTIVE');
    });

    it('a "Terminated" string with a FUTURE last day is OFFBOARDING — dates win', async () => {
        // The #2012 regression class, which this mapper carried independently.
        // BambooHR statuses are administrator-named, so "Terminated - Notice" is
        // an ordinary value for someone still employed and still working. The
        // JML leaver pass acts on TERMINATED, so answering the string here is
        // what disables a person mid-notice-period.
        expect(
            await statusOf({ status: 'Terminated - Notice', terminationDate: future() }),
        ).toBe('OFFBOARDING');
        expect(await statusOf({ status: 'Terminated - Notice' })).toBe('TERMINATED');
    });

    it('a worker on leave with a termination date resolves from the DATE', async () => {
        // Deliberate consequence of the ordering, asserted so it is a decision
        // and not an accident. Both answers mean "do not disable yet".
        expect(
            await statusOf({ status: 'On Leave', terminationDate: future() }),
        ).toBe('OFFBOARDING');
        expect(await statusOf({ status: 'On Leave' })).toBe('LEAVE');
    });

    it('derives ONBOARDING from a future hire date', async () => {
        expect(await statusOf({ status: 'Active', hireDate: future() })).toBe(
            'ONBOARDING',
        );
    });

    it('a future termination outranks a future hire', async () => {
        expect(
            await statusOf({
                status: 'Active',
                hireDate: future(),
                terminationDate: future(),
            }),
        ).toBe('OFFBOARDING');
    });

    it.each(['Pre-Hire', 'prehire', 'Onboarding'])(
        'maps the %s status string to ONBOARDING',
        async (status) => {
            expect(await statusOf({ status })).toBe('ONBOARDING');
        },
    );

    it('defaults to ACTIVE for an unrecognised or empty status', async () => {
        expect(await statusOf({ status: 'Full-Time' })).toBe('ACTIVE');
        expect(await statusOf({ status: '', employmentStatus: '' })).toBe('ACTIVE');
        expect(await statusOf({ status: undefined })).toBe('ACTIVE');
    });
});
