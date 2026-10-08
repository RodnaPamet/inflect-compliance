/**
 * Step 0c - structured name parts and a REAL employee number.
 *
 * === THE TWO THINGS THIS STEP CAN GET WRONG ===
 *
 * 1. `employeeNumber` FALLING BACK. A real employee number is among the very
 *    few signals permitted to produce a LINKED without a human confirming it.
 *    `externalId` sits one line above it in every mapper and DOES fall back to
 *    the work email, and copying that pattern would let an email silently
 *    acquire the authority of a payroll identifier - a legacy table full of
 *    emails would then auto-link at LINK strength on something that is only an
 *    address. So every provider gets a test that a missing number yields NULL
 *    and specifically not the email, with the email present in the fixture so
 *    the assertion can tell the two outcomes apart.
 *
 * 2. `fullName` MOVING. The joiner pass builds mailbox addresses and display
 *    names from it, so a changed derivation changes what gets created in a
 *    customer's directory. Each provider's derivation is pinned against fixed
 *    fixtures whose candidate fields all DIFFER, because a fixture where
 *    `preferredName` and `legalName` agree cannot detect a reordered `||`.
 */
import { BambooHrProvider } from '@/app-layer/integrations/providers/hris';
import { readWorkdayRoster, type WorkdayRosterConfig } from '@/app-layer/integrations/providers/workday/roster';
import { readOrangeHrmRoster } from '@/app-layer/integrations/providers/orangehrm/roster';

// --- BambooHR ---

function bambooFetch(employees: unknown[]) {
    return jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ employees }),
    }));
}

async function bamboo(over: Record<string, unknown> = {}) {
    const rows = [{
        employeeNumber: 'EMP-7',
        firstName: 'Ada',
        lastName: 'Lovelace',
        workEmail: 'ada@acme.test',
        status: 'Active',
        ...over,
    }];
    const p = new BambooHrProvider({ fetchImpl: bambooFetch(rows) as never });
    const { employees } = await p.listEmployees({ subdomain: 'acme', apiKey: 'k' });
    return employees[0];
}

describe('Step 0c - BambooHR', () => {
    it('maps the name parts it already fetches', async () => {
        const e = await bamboo();
        expect(e.givenName).toBe('Ada');
        expect(e.familyName).toBe('Lovelace');
        // No middle name in BambooHR's custom report - null, not invented.
        expect(e.middleName).toBeNull();
    });

    it('maps a real employee number', async () => {
        expect((await bamboo()).employeeNumber).toBe('EMP-7');
    });

    it('employeeNumber is NULL when absent - never the work email', async () => {
        const e = await bamboo({ employeeNumber: '' });
        expect(e.employeeNumber).toBeNull();
        expect(e.employeeNumber).not.toBe('ada@acme.test');
        // And the contrast that makes the point: `externalId` DOES fall back,
        // because it is provenance and nothing matches on it.
        expect(e.externalId).toBe('ada@acme.test');
    });

    it('REGRESSION - fullName is still `[first, last].join(" ") || workEmail`', async () => {
        expect((await bamboo()).fullName).toBe('Ada Lovelace');
        expect((await bamboo({ lastName: '' })).fullName).toBe('Ada');
        expect((await bamboo({ firstName: '', lastName: '' })).fullName).toBe('ada@acme.test');
    });

    it('keeps the parts even when fullName fell back to the email', async () => {
        // Independent: a nameless row still carries its employee number.
        const e = await bamboo({ firstName: '', lastName: '' });
        expect(e.fullName).toBe('ada@acme.test');
        expect(e.employeeNumber).toBe('EMP-7');
        expect(e.givenName).toBeNull();
    });
});

// --- Workday ---

const WD_CFG: WorkdayRosterConfig = {
    host: 'wd2-impl-services1.workday.com',
    tenant: 'acme',
    reportPath: '/ccx/service/customreport2/acme/ISU/Roster',
};

function workdayFetch(rows: Array<Record<string, unknown>>) {
    return jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ Report_Entry: rows }),
    }));
}

async function workday(over: Record<string, unknown> = {}) {
    const rows = [{
        employeeId: 'WD-9',
        workerId: 'SURROGATE-9',
        legalName: 'Grace Brewster Hopper',
        preferredName: 'Grace Hopper',
        primaryWorkEmail: 'grace@acme.test',
        workerStatus: 'Active',
        ...over,
    }];
    const out = await readWorkdayRoster(WD_CFG, 'tok', null, {
        fetchImpl: workdayFetch(rows) as unknown as typeof fetch,
    });
    return out.employees[0];
}

describe('Step 0c - Workday', () => {
    it('keeps legalName and preferredName separately', async () => {
        const e = await workday();
        expect(e.legalName).toBe('Grace Brewster Hopper');
        expect(e.preferredName).toBe('Grace Hopper');
    });

    it('leaves given/family null rather than splitting a name on whitespace', async () => {
        // A split would invent exactly the guess these columns exist to remove,
        // and "Grace Brewster Hopper" is the case where the guess is wrong.
        const e = await workday();
        expect(e.givenName ?? null).toBeNull();
        expect(e.familyName ?? null).toBeNull();
        expect(e.middleName ?? null).toBeNull();
    });

    it('employeeNumber comes from employeeId ONLY - not workerId, not the email', async () => {
        expect((await workday()).employeeNumber).toBe('WD-9');
        const e = await workday({ employeeId: '' });
        expect(e.employeeNumber).toBeNull();
        // `workerId` is an internal surrogate, not a number HR issues to a
        // person. `externalId` is allowed to reach for it; this is not.
        expect(e.employeeNumber).not.toBe('SURROGATE-9');
        expect(e.employeeNumber).not.toBe('grace@acme.test');
        expect(e.externalId).toBe('SURROGATE-9');
    });

    it('REGRESSION - fullName is still `preferredName || legalName || workEmail`', async () => {
        // All three fixtures differ, which is what makes this able to detect a
        // reordering rather than agreeing with itself.
        expect((await workday()).fullName).toBe('Grace Hopper');
        expect((await workday({ preferredName: '' })).fullName).toBe('Grace Brewster Hopper');
        expect((await workday({ preferredName: '', legalName: '' })).fullName).toBe('grace@acme.test');
    });

    it('does NOT populate hrisRecordId', async () => {
        // It carries write-back meaning (docs/jml-hris-write-back-design.md).
        // Step 0c says to stop and ask rather than populate it.
        const e = await workday();
        expect(e.hrisRecordId ?? null).toBeNull();
    });
});

// --- OrangeHRM ---

const OH_HOST = 'acme.orangehrmlive.com';

function orangeFetch(rows: Array<Record<string, unknown>>, email: string | null) {
    return jest.fn(async (url: unknown) => {
        const u = String(url);
        const contact = /\/pim\/employee\/(\d+)\/contact-details/.exec(u);
        const body = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) });
        if (contact) return body({ workEmail: email });
        if (/\/job-details/.test(u)) {
            return body({ joinedDate: null, employeeTerminationRecord: { id: null, date: null } });
        }
        const offset = Number(new URL(u).searchParams.get('offset') ?? '0');
        return body(offset === 0 ? rows : []);
    });
}

async function orange(over: Record<string, unknown> = {}, email: string | null = 'ivan@acme.test') {
    const rows = [{
        empNumber: 7,
        employeeId: 'BADGE-7',
        firstName: 'Ivan',
        middleName: 'Petrov',
        lastName: 'Ivanov',
        jobTitle: { title: null },
        subunit: { name: null },
        empStatus: { name: null },
        supervisors: [],
        terminationId: null,
        ...over,
    }];
    const out = await readOrangeHrmRoster({ host: OH_HOST }, 'bearer', null, {
        fetchImpl: orangeFetch(rows, email) as unknown as typeof fetch,
    });
    return out.employees[0];
}

describe('Step 0c - OrangeHRM', () => {
    it('maps all three name parts, which its list rows already carry', async () => {
        const e = await orange();
        expect(e.givenName).toBe('Ivan');
        expect(e.middleName).toBe('Petrov');
        expect(e.familyName).toBe('Ivanov');
    });

    it('employeeNumber is the badge number, NOT the internal empNumber', async () => {
        const e = await orange();
        // `employeeId` is what an HR administrator types; `empNumber` is the
        // row id an update is addressed by, and it belongs in hrisRecordId.
        expect(e.employeeNumber).toBe('BADGE-7');
        expect(e.employeeNumber).not.toBe('7');
        expect(e.hrisRecordId).toBe('7');
    });

    it('employeeNumber is NULL when the badge is blank - never the work email', async () => {
        const e = await orange({ employeeId: '' });
        expect(e.employeeNumber).toBeNull();
        expect(e.employeeNumber).not.toBe('ivan@acme.test');
        // `externalId` keeps its fallback, as provenance.
        expect(e.externalId).toBe('ivan@acme.test');
    });

    it('REGRESSION - fullName is still first + middle + last, falling back to the email', async () => {
        expect((await orange()).fullName).toBe('Ivan Petrov Ivanov');
        expect((await orange({ middleName: '' })).fullName).toBe('Ivan Ivanov');
        expect((await orange({ firstName: '', middleName: '', lastName: '' })).fullName)
            .toBe('ivan@acme.test');
    });

    it('trims the parts, so a padded attribute is not a distinct value', async () => {
        const e = await orange({ firstName: '  Ivan  ', middleName: '   ', lastName: 'Ivanov' });
        expect(e.givenName).toBe('Ivan');
        // Whitespace-only becomes null, not an empty string.
        expect(e.middleName).toBeNull();
        expect(e.familyName).toBe('Ivanov');
    });
});
