/**
 * Workday roster read — pagination, completeness, and status derivation.
 *
 * Two things here carry real consequence, and neither shows up in a
 * happy-path read:
 *
 * COMPLETENESS drives the departure reconcile. `complete: true` is a claim
 * that the whole roster was seen, and the HRIS usecase acts on it by marking
 * anyone unseen as TERMINATED. Getting it wrong in the optimistic direction
 * terminates real employees.
 *
 * ONBOARDING / OFFBOARDING is the H2 lesson from BambooHR restated. Workday
 * reports a scheduled-to-leave worker as active until their last day, and a
 * signed-but-not-started hire as inactive. Collapsing both into
 * ACTIVE/TERMINATED makes `offboarded_access_removed` vacuous for exactly the
 * population it exists to catch — the person still holding access through
 * their notice period.
 */
import {
    readWorkdayRoster,
    mapWorkdayStatus,
    WORKDAY_PAGE_SIZE,
    WORKDAY_MAX_PER_RUN,
    type WorkdayRosterConfig,
} from '@/app-layer/integrations/providers/workday/roster';

const cfg: WorkdayRosterConfig = {
    host: 'wd2-impl-services1.workday.com',
    tenant: 'acme',
    reportPath: '/ccx/service/customreport2/acme/ISU/Roster',
};

const row = (i: number, over: Record<string, unknown> = {}) => ({
    employeeId: `E${i}`,
    legalName: `Person ${i}`,
    primaryWorkEmail: `p${i}@acme.test`,
    workerStatus: 'Active',
    ...over,
});

/** A fetch that serves `total` rows in WORKDAY_PAGE_SIZE-sized pages. */
function pagedFetch(total: number) {
    return jest.fn(async (url: string, _init?: RequestInit) => {
        const offset = Number(new URL(url).searchParams.get('Offset') ?? '0');
        const slice = Array.from(
            { length: Math.max(0, Math.min(WORKDAY_PAGE_SIZE, total - offset)) },
            (_, k) => row(offset + k),
        );
        return { ok: true, status: 200, json: async () => ({ Report_Entry: slice }) } as unknown as Response;
    });
}

describe('status derivation', () => {
    const now = new Date('2026-06-01T00:00:00Z');

    it('a worker leaving next month is OFFBOARDING, not ACTIVE', () => {
        // The case offboarded_access_removed exists for. Calling this ACTIVE
        // hides someone who still has access and is on their way out.
        expect(mapWorkdayStatus({ workerStatus: 'Active', terminationDate: '2026-07-01' }, now)).toBe('OFFBOARDING');
    });

    it('a hire starting next month is ONBOARDING, not ACTIVE or TERMINATED', () => {
        expect(mapWorkdayStatus({ workerStatus: 'Inactive', hireDate: '2026-07-01' }, now)).toBe('ONBOARDING');
    });

    it('a past termination date is TERMINATED even if the status string says active', () => {
        // Dates beat the status string, which administrators can customise
        // per tenant and therefore cannot be relied on alone.
        expect(mapWorkdayStatus({ workerStatus: 'Active', terminationDate: '2026-01-01' }, now)).toBe('TERMINATED');
    });

    it('recognises leave and explicit termination from the status string', () => {
        expect(mapWorkdayStatus({ workerStatus: 'On Leave' }, now)).toBe('LEAVE');
        expect(mapWorkdayStatus({ workerStatus: 'Terminated' }, now)).toBe('TERMINATED');
    });

    it('treats activeStatus=false with no dates as TERMINATED, not ACTIVE', () => {
        // Honest read of an inactive worker whose reason the report omitted.
        // ACTIVE would hide lingering access.
        expect(mapWorkdayStatus({ activeStatus: false }, now)).toBe('TERMINATED');
        expect(mapWorkdayStatus({ activeStatus: 'false' }, now)).toBe('TERMINATED');
    });

    it('defaults to ACTIVE for an ordinary current worker', () => {
        expect(mapWorkdayStatus({ workerStatus: 'Active', hireDate: '2020-01-01' }, now)).toBe('ACTIVE');
    });
});

describe('pagination and completeness', () => {
    it('walks every page and reports complete when the report ends', async () => {
        const f = pagedFetch(1_200);
        const out = await readWorkdayRoster(cfg, 'tok', null, { fetchImpl: f as unknown as typeof fetch });
        expect(out.employees).toHaveLength(1_200);
        expect(out.complete).toBe(true);
        expect(out.resumeToken).toBeNull();
        // 500 + 500 + 200 -> the short page ends it.
        expect(f).toHaveBeenCalledTimes(3);
    });

    it('a report that ends exactly on a page boundary still terminates', async () => {
        // The off-by-one that would loop forever, or stop one page early.
        const f = pagedFetch(WORKDAY_PAGE_SIZE);
        const out = await readWorkdayRoster(cfg, 'tok', null, { fetchImpl: f as unknown as typeof fetch });
        expect(out.employees).toHaveLength(WORKDAY_PAGE_SIZE);
        expect(out.complete).toBe(true);
        // One full page, then one empty page to learn it was the last.
        expect(f).toHaveBeenCalledTimes(2);
    });

    it('an empty report is COMPLETE, not truncated', async () => {
        // complete:false here would block the reconcile forever on a tenant
        // whose report is legitimately empty.
        const out = await readWorkdayRoster(cfg, 'tok', null, {
            fetchImpl: pagedFetch(0) as unknown as typeof fetch,
        });
        expect(out).toEqual({ employees: [], complete: true, resumeToken: null });
    });

    it('stops at the per-run cap and hands back a resume cursor', async () => {
        const out = await readWorkdayRoster(cfg, 'tok', null, {
            fetchImpl: pagedFetch(WORKDAY_MAX_PER_RUN * 2) as unknown as typeof fetch,
        });
        expect(out.employees).toHaveLength(WORKDAY_MAX_PER_RUN);
        expect(out.complete).toBe(false);
        expect(out.resumeToken).toBe(String(WORKDAY_MAX_PER_RUN));
    });

    it('resumes from the given cursor rather than restarting', async () => {
        const f = pagedFetch(WORKDAY_MAX_PER_RUN * 2);
        const out = await readWorkdayRoster(cfg, 'tok', String(WORKDAY_MAX_PER_RUN), {
            fetchImpl: f as unknown as typeof fetch,
        });
        expect(new URL(f.mock.calls[0][0] as string).searchParams.get('Offset'))
            .toBe(String(WORKDAY_MAX_PER_RUN));
        expect(out.employees[0].externalId).toBe(`E${WORKDAY_MAX_PER_RUN}`);
    });

    it('REFUSES a malformed cursor instead of silently restarting', async () => {
        // Restarting from zero would re-upsert everything AND make a pass that
        // never completes look like one making steady progress.
        await expect(
            readWorkdayRoster(cfg, 'tok', 'not-a-number', { fetchImpl: pagedFetch(10) as unknown as typeof fetch }),
        ).rejects.toThrow(/resume cursor/i);
        await expect(
            readWorkdayRoster(cfg, 'tok', '-5', { fetchImpl: pagedFetch(10) as unknown as typeof fetch }),
        ).rejects.toThrow(/resume cursor/i);
    });
});

describe('rows that cannot be reconciled', () => {
    it('drops a row with no work email WITHOUT ending the pass early', async () => {
        // The subtle one: completeness is decided on the RAW page length, not
        // the normalised count. Counting normalised rows would read a page
        // half-full of email-less rows as the end of the report and truncate
        // the pass silently — reporting complete:true over a partial roster,
        // which then drives the departure reconcile.
        const f = jest.fn(async (url: string) => {
            const offset = Number(new URL(url).searchParams.get('Offset') ?? '0');
            if (offset === 0) {
                const rows = Array.from({ length: WORKDAY_PAGE_SIZE }, (_, k) =>
                    k % 2 === 0 ? row(k) : row(k, { primaryWorkEmail: '' }),
                );
                return { ok: true, status: 200, json: async () => ({ Report_Entry: rows }) } as unknown as Response;
            }
            return { ok: true, status: 200, json: async () => ({ Report_Entry: [row(9_001)] }) } as unknown as Response;
        });
        const out = await readWorkdayRoster(cfg, 'tok', null, { fetchImpl: f as unknown as typeof fetch });
        expect(out.complete).toBe(true);
        expect(out.employees).toHaveLength(WORKDAY_PAGE_SIZE / 2 + 1);
        expect(out.employees.every((e) => e.workEmail)).toBe(true);
        expect(f).toHaveBeenCalledTimes(2);
    });

    it('prefers the preferred name and carries manager email through', async () => {
        const f = jest.fn(async () => ({
            ok: true, status: 200,
            json: async () => ({ Report_Entry: [row(1, {
                legalName: 'Jonathan Smith', preferredName: 'Jon Smith',
                managerEmail: 'boss@acme.test', organization: 'Security', businessTitle: 'Analyst',
            })] }),
        }) as unknown as Response);
        const out = await readWorkdayRoster(cfg, 'tok', null, { fetchImpl: f as unknown as typeof fetch });
        expect(out.employees[0]).toMatchObject({
            fullName: 'Jon Smith', managerEmail: 'boss@acme.test',
            department: 'Security', jobTitle: 'Analyst',
        });
    });
});

describe('request shape', () => {
    it('sends the bearer token and asks the report for json', async () => {
        const f = pagedFetch(1);
        await readWorkdayRoster(cfg, 'the-token', null, { fetchImpl: f as unknown as typeof fetch });
        const [url, init] = f.mock.calls[0] as [string, RequestInit];
        expect(init.headers).toMatchObject({ Authorization: 'Bearer the-token' });
        expect(new URL(url as string).searchParams.get('format')).toBe('json');
        expect(new URL(url as string).pathname).toBe(cfg.reportPath);
    });

    it('refuses an empty host or report path rather than building a nonsense URL', async () => {
        await expect(readWorkdayRoster({ ...cfg, host: '' }, 't')).rejects.toThrow(/host is required/i);
        await expect(readWorkdayRoster({ ...cfg, reportPath: '' }, 't')).rejects.toThrow(/report path/i);
    });

    it('surfaces a non-ok report fetch', async () => {
        const f = jest.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }) as unknown as Response);
        await expect(
            readWorkdayRoster(cfg, 'tok', null, { fetchImpl: f as unknown as typeof fetch }),
        ).rejects.toThrow(/403/);
    });
});
