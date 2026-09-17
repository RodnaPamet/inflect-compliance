/**
 * The HRIS write-back's ADDRESSABLE HANDLE — Phase 0, read path only.
 *
 * `docs/jml-hris-write-back-design.md` names one blocking defect, and it is
 * the only thing this file is about:
 *
 *   - the BambooHR custom report asked for ten fields and `id` was not one of
 *     them (`hris/index.ts`, the `body:` of `fetchBambooRoster`);
 *   - the mapper nonetheless read it, as the MIDDLE term of
 *     `externalId: r.employeeNumber || r.id || r.workEmail`.
 *
 * WHETHER THAT TERM WAS REACHABLE IS UNRESOLVED. It would require BambooHR to
 * return `id` to a request that did not ask for it — Open Question 2 of
 * docs/jml-hris-write-back-design.md, which says to check against a real tenant
 * and is deliberately not settled by assertion. There is no BambooHR tenant to
 * check (issue #2548). So `externalId` values already on disk MAY be row ids.
 *
 * NOTHING BELOW TESTS THAT QUESTION, and it cannot: every fixture reaches the
 * mapper through a fake `fetchImpl`, so what the real API sends is out of
 * reach here. These tests pin the mapper's arithmetic — which term wins, and
 * where the row id lands — and that is all they claim.
 *
 * THE MIDDLE TERM WAS NOT MERELY DEAD, IT WAS A LATENT REWRITE, and that is
 * the claim `externalId is the employeeNumber even when a row id is present`
 * below exists to pin. Requesting `id` while leaving the fallback in place
 * would have silently repointed `externalId` at the row id for every row with
 * no `employeeNumber`, on the next sync, changing the meaning of a column
 * already on disk. So the two halves of this change are one change: request
 * the field, and move it to a column that has never held anything else.
 *
 * WHY THESE ASSERTIONS COMPARE VALUES AND NEVER PRESENCE. A test that checks
 * `hrisRecordId` EXISTS passes when it holds the work email — which is the
 * precise failure this column exists to prevent, because an update addressed
 * by work email is addressed by the value the write-back exists to create.
 * Every claim here names the value it expects and the values it refuses.
 *
 * WHAT THIS FILE DOES NOT CLAIM. Nothing here writes to an HRIS, and nothing
 * reads `hrisRecordId` in production — Phase 1 and Phase 2 are blocked (see
 * the design's Phasing section). The last describe block is the one that
 * matters most on a read-path change: the three independent drops of an
 * email-less row must be UNCHANGED, because `Employee.workEmail` is NOT NULL
 * and is the row's identity. Admitting a pre-hire here would not create a
 * pre-hire; it would break the primary key.
 */
import { readFileSync } from 'fs';
import * as path from 'path';

import { BambooHrProvider, type NormalizedEmployee } from '@/app-layer/integrations/providers/hris';
import { readWorkdayRoster, type WorkdayRosterConfig } from '@/app-layer/integrations/providers/workday/roster';
import { REPO_ROOT } from '../helpers/repo-files';
import { functionBodyOf } from '../helpers/source-blocks';

/** The exact projection the provider must ask BambooHR for. */
const EXPECTED_REPORT_FIELDS = [
    'id',
    'workEmail',
    'firstName',
    'lastName',
    'status',
    'department',
    'jobTitle',
    'supervisorEmail',
    'hireDate',
    'terminationDate',
    'employeeNumber',
];

const CONFIG = { subdomain: 'acme', apiKey: 'k-not-a-real-key' }; // pragma: allowlist secret -- fixture for an injected fetch; no BambooHR call is ever made

interface Captured {
    url: string;
    body: { fields?: unknown };
}

/**
 * Run the real provider against a faked BambooHR response and hand back both
 * the normalised roster AND the request that produced it.
 *
 * The request is captured from the `init.body` the provider actually passed to
 * fetch and re-parsed from JSON — not read off a constant — so the field-list
 * assertion is about bytes on the wire rather than about a name in the source.
 */
async function rosterFrom(rows: Array<Record<string, string>>): Promise<{
    employees: NormalizedEmployee[];
    complete: boolean;
    sent: Captured;
}> {
    let sent: Captured | null = null;
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
        sent = { url, body: JSON.parse(String(init?.body ?? '{}')) as { fields?: unknown } };
        return { ok: true, status: 200, json: async () => ({ employees: rows }) } as unknown as Response;
    });
    const provider = new BambooHrProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await provider.listEmployees(CONFIG);
    if (sent === null) throw new Error('the provider issued no request — the fake was never reached');
    return { employees: result.employees, complete: result.complete, sent };
}

/** A BambooHR custom-report row. Every field is optional, as the wire is. */
const row = (over: Record<string, string> = {}): Record<string, string> => ({
    workEmail: 'ada@acme.test',
    firstName: 'Ada',
    lastName: 'Lovelace',
    status: 'Active',
    ...over,
});

describe('the report asks BambooHR for its own row id', () => {
    it('sends a field list containing id, and keeps every field it already asked for', async () => {
        const { sent } = await rosterFrom([row({ id: '4021' })]);

        // The whole projection, in order, by VALUE. An `toContain('id')` would
        // also pass if this change had dropped `terminationDate` on the way —
        // and that field is what keeps a mid-notice-period employee out of the
        // leaver pass, so losing it is not a cosmetic regression.
        expect(sent.body.fields).toStrictEqual(EXPECTED_REPORT_FIELDS);
        expect(sent.url).toBe('https://api.bamboohr.com/api/gateway.php/acme/v1/reports/custom?format=JSON');
    });
});

describe('a row id becomes the addressable handle, and nothing else ever does', () => {
    it('persists the row id as hrisRecordId when BambooHR supplies one', async () => {
        const { employees } = await rosterFrom([
            row({ id: '4021', employeeNumber: 'EMP-7', workEmail: 'ada@acme.test' }),
        ]);

        // Pin the population before reading it: over an empty array every
        // claim below is vacuously true. See the control at the end.
        expect(employees).toHaveLength(1);
        const e = employees[0];

        // The VALUE, not its presence. All three candidate strings are
        // distinct in this fixture precisely so a wrong one cannot pass.
        expect(e.hrisRecordId).toBe('4021');
        expect(e.hrisRecordId).not.toBe('EMP-7');
        expect(e.hrisRecordId).not.toBe('ada@acme.test');
    });

    it('leaves hrisRecordId null rather than letting an email pretend to be a handle', async () => {
        const { employees } = await rosterFrom([
            row({ employeeNumber: 'EMP-7', workEmail: 'grace@acme.test' }),
        ]);

        expect(employees).toHaveLength(1);
        const e = employees[0];

        // Null is the honest answer and the one a Phase-2 caller refuses on.
        // A fallback to either of the other two values would be an address
        // that resolves to the wrong record, or to no record at all.
        expect(e.hrisRecordId).toBeNull();
        expect(e.hrisRecordId).not.toBe('grace@acme.test');
        expect(e.hrisRecordId).not.toBe('EMP-7');
    });

    it('leaves hrisRecordId null when the row carries an empty id string', async () => {
        // BambooHR returns '' for a requested field it has no value for, which
        // is a different shape from an absent key and must land in the same
        // place. `'' || null` gives null; `??` would have given ''.
        const { employees } = await rosterFrom([row({ id: '', employeeNumber: 'EMP-9' })]);

        expect(employees).toHaveLength(1);
        expect(employees[0].hrisRecordId).toBeNull();
        expect(employees[0].hrisRecordId).not.toBe('');
    });
});

describe('externalId keeps the meaning it already had on disk', () => {
    it('is the employeeNumber even when a row id is present', async () => {
        // THE LATENT-REWRITE ASSERTION. With the old three-term fallback and
        // `id` now requested, this row's externalId would still be 'EMP-7' —
        // the first term wins — so this case alone does not discriminate.
        const { employees } = await rosterFrom([row({ id: '4021', employeeNumber: 'EMP-7' })]);

        expect(employees).toHaveLength(1);
        expect(employees[0].externalId).toBe('EMP-7');
    });

    it('falls back to the work email, NOT to the row id, when there is no employeeNumber', async () => {
        // This is the case that discriminates, and it is the reason the middle
        // term had to be DELETED rather than left as harmless dead code. Under
        // `r.employeeNumber || r.id || r.workEmail` with `id` requested, this
        // row's externalId becomes '4021' — a value no earlier sync could ever
        // have written — and every such row is rewritten on the next pass.
        const { employees } = await rosterFrom([
            row({ id: '4021', workEmail: 'ada@acme.test' }),
        ]);

        expect(employees).toHaveLength(1);
        expect(employees[0].externalId).toBe('ada@acme.test');
        expect(employees[0].externalId).not.toBe('4021');
        // And the id is not lost — it moved to the column that means it.
        expect(employees[0].hrisRecordId).toBe('4021');
    });
});

describe('the handle is persisted on the Employee row by the existing seam', () => {
    // A source claim, deliberately bounded to ONE declaration rather than the
    // file, and asserted as a COUNT of an exact literal rather than a pattern.
    // The behavioural half needs a database; what is checkable here is that
    // both arms of the upsert name the column, and that neither reaches for a
    // fallback value the way the mapper used to.
    const usecase = readFileSync(path.join(REPO_ROOT, 'src/app-layer/usecases/hris-sync.ts'), 'utf8');
    const runHrisSync = functionBodyOf(usecase, 'runHrisSync');

    it('writes hrisRecordId in both arms of the upsert', () => {
        const occurrences = runHrisSync.split('hrisRecordId: e.hrisRecordId ?? null').length - 1;
        // Two: `create` and `update`. One arm only would leave the handle
        // permanently null for every employee that already existed.
        expect(occurrences).toBe(2);
    });

    it('never substitutes another column for a missing handle', () => {
        // The mapper's old sin, restated at the persistence layer. `?? null`
        // is the only permitted coalesce; an `||` chain here would be the same
        // defect one file further down.
        expect(runHrisSync.includes('hrisRecordId: e.hrisRecordId || ')).toBe(false);
        expect(runHrisSync.includes('hrisRecordId: e.externalId')).toBe(false);
        expect(runHrisSync.includes('hrisRecordId: e.workEmail')).toBe(false);
    });
});

describe('the three drops of an email-less row are unchanged by this diff', () => {
    // A pre-hire has no work email, and `Employee.workEmail` is NOT NULL with
    // @@unique([tenantId, workEmail]) — the email IS the row's identity. Three
    // independent layers drop such a row today. This is a READ-PATH change and
    // must not have loosened any of them.

    it('drop 1 — the BambooHR provider still filters the row out entirely', async () => {
        const { employees } = await rosterFrom([
            row({ id: '4021', workEmail: '', employeeNumber: 'EMP-PREHIRE' }),
            row({ id: '4022', workEmail: 'ada@acme.test' }),
        ]);

        // By value: exactly the one addressable row survives, and it is the
        // one WITH an email. A length assertion alone would pass if the two
        // rows had swapped.
        expect(employees).toHaveLength(1);
        expect(employees[0].workEmail).toBe('ada@acme.test');
        expect(employees[0].hrisRecordId).toBe('4022');
        expect(employees.map((e) => e.hrisRecordId)).not.toContain('4021');
    });

    it('drop 2 — the Workday normaliser still returns null for an email-less worker', async () => {
        const cfg: WorkdayRosterConfig = {
            host: 'wd2-impl-services1.workday.com',
            tenant: 'acme',
            reportPath: '/ccx/service/customreport2/acme/ISU/Roster',
        };
        const fetchImpl = jest.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                Report_Entry: [
                    { employeeId: 'W-1', legalName: 'Pre Hire', workerStatus: 'Active' },
                    { employeeId: 'W-2', legalName: 'Grace', primaryWorkEmail: 'grace@acme.test', workerStatus: 'Active' },
                ],
            }),
        }));
        const out = await readWorkdayRoster(cfg, 'tok', null, { fetchImpl: fetchImpl as unknown as typeof fetch });

        expect(out.employees).toHaveLength(1);
        expect(out.employees[0].workEmail).toBe('grace@acme.test');
    });

    it('drop 3 — the hris-sync usecase still skips an email-less row BEFORE the upsert', () => {
        const usecase = readFileSync(path.join(REPO_ROOT, 'src/app-layer/usecases/hris-sync.ts'), 'utf8');
        const runHrisSync = functionBodyOf(usecase, 'runHrisSync');
        const guardAt = runHrisSync.indexOf('if (!e.workEmail) continue;');
        const upsertAt = runHrisSync.indexOf('db.employee.upsert(');

        // Both present, and the guard STRICTLY BEFORE the write. Asserting
        // only that the guard exists would pass if it had been moved below the
        // upsert, where it protects nothing.
        expect(guardAt).toBeGreaterThan(-1);
        expect(upsertAt).toBeGreaterThan(-1);
        expect(guardAt).toBeLessThan(upsertAt);
    });
});

describe('Workday is knowingly left without a handle', () => {
    it('produces no hrisRecordId, because what its externalId holds is per-tenant', async () => {
        const cfg: WorkdayRosterConfig = {
            host: 'wd2-impl-services1.workday.com',
            tenant: 'acme',
            reportPath: '/ccx/service/customreport2/acme/ISU/Roster',
        };
        const fetchImpl = jest.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                Report_Entry: [
                    { employeeId: 'W-2', legalName: 'Grace', primaryWorkEmail: 'grace@acme.test', workerStatus: 'Active' },
                ],
            }),
        }));
        const out = await readWorkdayRoster(cfg, 'tok', null, { fetchImpl: fetchImpl as unknown as typeof fetch });

        expect(out.employees).toHaveLength(1);
        // Absent, not guessed. `roster.ts` draws externalId from a report
        // template the CUSTOMER authors, so whether any column holds a Worker
        // WID is unknowable from here — the design says so, and silence is the
        // honest answer. It still carries its externalId as before.
        expect(out.employees[0].hrisRecordId ?? null).toBeNull();
        expect(out.employees[0].externalId).toBe('W-2');
    });
});

describe('EMPTY-SELECTION CONTROL', () => {
    it('an empty roster satisfies every per-row claim above vacuously', async () => {
        const { employees, complete, sent } = await rosterFrom([]);

        // The request still goes out — an empty population is not a dead fake.
        expect(sent.body.fields).toStrictEqual(EXPECTED_REPORT_FIELDS);
        expect(employees).toHaveLength(0);
        expect(complete).toBe(true);

        // THE COLLAPSE, demonstrated rather than described. This is the exact
        // predicate the handle tests rely on, and over nothing it is TRUE —
        // so a census that forgot to pin its length would report a perfect
        // pass against a provider that returned no rows at all. That is why
        // every `it` above asserts an exact `toHaveLength` before reading a
        // row, and why this control is part of the suite rather than a note.
        expect(employees.every((e) => e.hrisRecordId !== null && e.hrisRecordId !== e.workEmail)).toBe(true);
        expect(employees.every((e) => e.externalId === 'anything at all')).toBe(true);
    });
});
