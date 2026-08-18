/**
 * ServiceNow change-management control (S2) — fail-closed conduct.
 *
 * The control is `change_approved_before_implementation`: of the changes that
 * actually LANDED in the period, every one carries an approval record.
 *
 * Most of what is worth pinning here is about the POPULATION, not the verdict.
 * A control over the wrong population is wrong in a way that reads as working:
 * it returns a status, the number looks plausible, and nothing errors.
 */
import { runServiceNowCheck, type ChangeRecord } from '@/app-layer/integrations/providers/servicenow/checks';
import { ServiceNowProvider } from '@/app-layer/integrations/providers/servicenow';
import type { CheckInput } from '@/app-layer/integrations/types';

const CHECK = 'change_approved_before_implementation';

const chg = (over: Partial<ChangeRecord> = {}): ChangeRecord => ({
    number: 'CHG0001',
    approval: 'approved',
    state: 'Closed Complete',
    type: 'normal',
    ...over,
});

const input = (over: Partial<CheckInput> = {}): CheckInput => ({
    automationKey: `servicenow.${CHECK}`,
    parsed: { provider: 'servicenow', checkType: CHECK, raw: `servicenow.${CHECK}` },
    tenantId: 't1',
    connectionConfig: {},
    triggeredBy: 'scheduled',
    ...over,
});

describe('the applicable population', () => {
    it('is the changes that actually landed — open ones are not production changes yet', () => {
        const r = runServiceNowCheck(CHECK, [
            chg({ number: 'C1' }),
            chg({ number: 'C2', state: 'Scheduled', approval: 'not_requested' }),
            chg({ number: 'C3', state: 'Assess', approval: 'not_requested' }),
        ]);
        // C2/C3 are proceeding normally. Counting them would make the control
        // red for correct behaviour, which is how a check becomes ignored.
        expect(r.status).toBe('PASSED');
        expect(r.details.applicable).toBe(1);
    });

    it('excludes cancelled changes — they never reached production', () => {
        const r = runServiceNowCheck(CHECK, [
            chg({ number: 'C1' }),
            chg({ number: 'C2', state: 'Canceled', approval: 'not_requested' }),
        ]);
        expect(r.status).toBe('PASSED');
        expect(r.details.applicable).toBe(1);
    });

    it('excludes pre-approved standard changes but REPORTS the count', () => {
        // Under ITIL a standard change's approval lives on the template, so
        // `not_requested` is legitimate. Counting them fails the control
        // permanently. Excluding them SILENTLY is the opposite failure: a
        // tenant that reclassifies everything as standard turns the control
        // green and nothing says so. The number has to be visible.
        const r = runServiceNowCheck(CHECK, [
            chg({ number: 'C1' }),
            chg({ number: 'S1', type: 'standard', approval: 'not_requested' }),
            chg({ number: 'S2', type: 'Standard', approval: '' }),
        ]);
        expect(r.status).toBe('PASSED');
        expect(r.details.applicable).toBe(1);
        expect(r.details.preApprovedStandard).toBe(2);
    });

    it('keeps EMERGENCY changes in — no approval at all is exactly the finding', () => {
        // Retrospective approval is normal for emergencies; none is not.
        const r = runServiceNowCheck(CHECK, [chg({ number: 'E1', type: 'emergency', approval: 'not_requested' })]);
        expect(r.status).toBe('FAILED');
    });

    it('an unrecognised TYPE requires approval — it is not assumed pre-approved', () => {
        // Fail closed. The opposite default lets an instance with a custom
        // change type opt out of the control by naming it something new.
        const r = runServiceNowCheck(CHECK, [chg({ number: 'X1', type: 'expedited', approval: 'not_requested' })]);
        expect(r.status).toBe('FAILED');
    });

    it('an unrecognised STATE is not treated as complete', () => {
        // `state` is an instance-specific integer. An unknown value counted as
        // landed would put a change that never shipped into the population.
        const r = runServiceNowCheck(CHECK, [chg({ number: 'U1', state: 'Some Custom State', approval: 'not_requested' })]);
        expect(r.status).toBe('NOT_APPLICABLE');
    });
});

describe('the verdict', () => {
    it('FAILS when an implemented change has no approval record', () => {
        const r = runServiceNowCheck(CHECK, [
            chg({ number: 'C1' }),
            chg({ number: 'C2', approval: 'not_requested' }),
        ]);
        expect(r.status).toBe('FAILED');
        expect(r.details.failed).toBe(1);
        expect(JSON.stringify(r.details.examples)).toContain('C2');
    });

    it('FAILS on a rejected approval as well as a missing one', () => {
        const r = runServiceNowCheck(CHECK, [chg({ number: 'C1', approval: 'rejected' })]);
        expect(r.status).toBe('FAILED');
    });

    it('names WHICH change failed, not just how many', () => {
        // A count on its own is unactionable: "1 of 3 unapproved" sends someone
        // to read the whole window by hand. The number that matters is on
        // `failed`; the identity is what makes it a finding.
        //
        // (This is NOT the "count comparison vs per-change relationship" trap —
        // `approval` is a field ON the change, so one record cannot carry two
        // approvals and a count can't tie while the mapping is wrong. That trap
        // is real for the sysapproval_approver table, which this does not read.
        // Written down because a mutation test proved the two forms equivalent
        // here, and a comment claiming otherwise would be false reassurance.)
        const r = runServiceNowCheck(CHECK, [
            chg({ number: 'C1', approval: 'approved' }),
            chg({ number: 'C2', approval: 'not_requested' }),
            chg({ number: 'C3', approval: 'approved' }),
        ]);
        expect(r.status).toBe('FAILED');
        expect(r.details.failed).toBe(1);
        expect(r.details.examples).toEqual([{ number: 'C2', approval: 'PENDING' }]);
    });

    it('bounds the examples so a bad window does not dump thousands of rows', () => {
        const many = Array.from({ length: 60 }, (_, i) => chg({ number: `C${i}`, approval: 'not_requested' }));
        const r = runServiceNowCheck(CHECK, many);
        expect(r.details.failed).toBe(60);
        expect((r.details.examples as unknown[]).length).toBe(20);
    });
});

describe('fail-closed', () => {
    it('NOT_APPLICABLE on an empty window — never PASSED', () => {
        // An empty window and a clean window are different claims, and only
        // one of them is evidence.
        const r = runServiceNowCheck(CHECK, []);
        expect(r.status).toBe('NOT_APPLICABLE');
        expect(r.status).not.toBe('PASSED');
    });

    it('NOT_APPLICABLE when every implemented change was pre-approved', () => {
        const r = runServiceNowCheck(CHECK, [chg({ type: 'standard', approval: 'not_requested' })]);
        expect(r.status).toBe('NOT_APPLICABLE');
        expect(r.summary).toMatch(/pre-approved/);
    });

    it('an unknown check ERRORs rather than passing', () => {
        expect(runServiceNowCheck('something_else', [chg()]).status).toBe('ERROR');
    });

    it('runCheck ERRORs when the instance cannot be read', async () => {
        // A collector that could not read is not a control that found nothing
        // wrong. They must never render the same.
        const p = new ServiceNowProvider({
            readChanges: async () => { throw new Error('HTTP 401'); },
        });
        const r = await p.runCheck(input());
        expect(r.status).toBe('ERROR');
        expect(r.errorMessage).toContain('401');
    });

    it('runCheck scores a real population', async () => {
        const p = new ServiceNowProvider({ readChanges: async () => [chg({ approval: 'not_requested' })] });
        expect((await p.runCheck(input())).status).toBe('FAILED');
    });
});

describe('a partial window is an error, not a score', () => {
    it('refuses to score when the read stopped at its cap', async () => {
        // "All 2,000 changes were approved" over the first 2,000 of 5,000 is a
        // false pass — and DESC ordering means the unseen 3,000 are the OLDER
        // ones, so the miss is systematic rather than random.
        const jsonRes = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
        const rows = Array.from({ length: 200 }, (_, i) => ({
            sys_id: `s${i}`, number: `C${i}`, approval: 'approved', state: 'Closed Complete', type: 'normal',
            sys_updated_on: '2026-08-01 10:00:00',
        }));
        // Every page comes back full, so the read hits its cap still saying
        // there is more.
        const fetchImpl = jest.fn(async () => jsonRes({ result: rows })) as unknown as typeof fetch;
        const p = new ServiceNowProvider({ fetchImpl });
        const r = await p.runCheck(input({
            connectionConfig: {
                instance: 'acme.service-now.com', table: 'change_request',
                username: 'u', password: 'p', windowDays: 3650,
            },
        }));
        expect(r.status).toBe('ERROR');
        expect(r.errorMessage).toMatch(/narrow the look-back window/);
    });
});

describe('evidence', () => {
    it('is produced for PASSED and FAILED only', () => {
        const p = new ServiceNowProvider();
        const base = { summary: 's', details: {} };
        expect(p.mapResultToEvidence(input(), { ...base, status: 'PASSED' })).not.toBeNull();
        expect(p.mapResultToEvidence(input(), { ...base, status: 'FAILED' })).not.toBeNull();
        // ERROR has nothing to attest; NOT_APPLICABLE would file "the period
        // was empty" as though it demonstrated the control.
        expect(p.mapResultToEvidence(input(), { ...base, status: 'ERROR' })).toBeNull();
        expect(p.mapResultToEvidence(input(), { ...base, status: 'NOT_APPLICABLE' })).toBeNull();
    });
});

describe('the Table API value shapes reach the check', () => {
    it('unwraps display_value rows so the population is not silently empty', async () => {
        // With display_value=all every field is {value, display_value}. A raw
        // read compares "[object Object]" against the state strings, never
        // matches, and the control reports NOT_APPLICABLE forever while looking
        // like it ran.
        const jsonRes = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
        const fetchImpl = jest.fn(async () => jsonRes({
            result: [{
                sys_id: { value: 's1' },
                number: { value: 'CHG9', display_value: 'CHG9' },
                approval: { value: 'not_requested', display_value: 'Not Requested' },
                state: { value: '3', display_value: 'Closed Complete' },
                type: { value: 'normal', display_value: 'Normal' },
                sys_updated_on: { value: '2026-08-01 10:00:00' },
            }],
        })) as unknown as typeof fetch;
        const r = await new ServiceNowProvider({ fetchImpl }).runCheck(input({
            connectionConfig: { instance: 'acme.service-now.com', table: 'change_request', username: 'u', password: 'p' },
        }));
        expect(r.status).toBe('FAILED');
        expect(r.details.applicable).toBe(1);
    });
});

describe('validateConnection', () => {
    it('refuses an off-domain instance without sending the password', async () => {
        const fetchImpl = jest.fn() as unknown as typeof fetch;
        const r = await new ServiceNowProvider({ fetchImpl }).validateConnection(
            { instance: 'evil.example.com', table: 'change_request', username: 'u' },
            { password: 'p' },
        );
        expect(r.valid).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('names every missing field at once', async () => {
        const r = await new ServiceNowProvider().validateConnection({ instance: 'acme.service-now.com' }, {});
        expect(r.valid).toBe(false);
        for (const f of ['table', 'username', 'password']) expect(r.error).toContain(f);
    });

    it('liveValidation is true and the probe is real', async () => {
        const p = new ServiceNowProvider({
            fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ result: [] }) })) as unknown as typeof fetch,
        });
        expect(p.liveValidation).toBe(true);
        expect((await p.validateConnection(
            { instance: 'acme.service-now.com', table: 'change_request', username: 'u' },
            { password: 'p' },
        )).valid).toBe(true);
    });
});
