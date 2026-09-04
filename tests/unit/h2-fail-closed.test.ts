/**
 * H2 — fail-closed check semantics.
 *
 * A compliance product must NEVER manufacture a passing signal it hasn't
 * earned. This suite proves the load-bearing invariant across every check
 * family: on a broken collector, empty output, zero applicable items, or an
 * unavailable signal, the check returns ERROR/NOT_APPLICABLE — never PASSED.
 */
import { runPowerpipeBenchmark } from '@/app-layer/integrations/cloud-posture/powerpipe-core';
import { runIdentityCheck } from '@/app-layer/integrations/providers/identity/types';
import type { NormalizedIdentityAccount } from '@/app-layer/integrations/providers/identity/types';
import { runDeviceCheck } from '@/app-layer/integrations/providers/device/checks';
import { runPersonnelCheck } from '@/app-layer/integrations/providers/personnel/checks';
import { runTrainingCheck } from '@/app-layer/integrations/providers/training/checks';
import {
    powerpipeBenchmarkJson,
    powerpipeControl,
    powerpipeErroredControl,
    groupShapedControlSummary,
} from '../helpers/powerpipe-benchmark-fixture';

const NOW = new Date('2026-07-07T00:00:00Z');
/**
 * `code` is the collector's exit status. It is OPTIONAL because omitting it is
 * itself a case worth covering: a failure with no exit status is what a signal
 * death and a spawn failure both look like, and that must keep refusing.
 */
const fakeExec = (stdout: string, ok = true, missing = false, code?: number, signal?: string) =>
    async () => ({ ok, stdout, stderr: ok ? '' : 'boom', missing, code, signal });

function acct(over: Partial<NormalizedIdentityAccount> = {}): NormalizedIdentityAccount {
    return { externalUserId: 'u1', email: 'a@x.com', status: 'ACTIVE', isAdmin: false, mfaEnrolled: true, ssoEnrolled: true, onPremisesSyncEnabled: null, groups: [], lastActiveAt: NOW, ...over };
}

describe('H2 — collectors fail closed', () => {
    /**
     * Each of these feeds VALID, all-ok benchmark JSON. That is the point: the
     * refusal has to come from how the run ENDED, so a leak past the gate shows
     * up as PASSED rather than as some other error string.
     */
    const ALL_OK = powerpipeBenchmarkJson('b', { controls: [powerpipeControl('c1', 'ok')] });

    it('a collector run that did not complete → ERROR, never PASSED', async () => {
        // A signal death: the 15-minute `timeout` sends SIGTERM, and Node
        // reports `{code: null, signal: 'SIGTERM'}`. Whatever stdout survived
        // is not a benchmark result.
        const r = await runPowerpipeBenchmark({ benchmarkId: 'b', env: process.env, secretValues: [], exec: fakeExec(ALL_OK, false, false, undefined, 'SIGTERM') });
        expect(r.status).toBe('ERROR');
    });

    it('an exit code outside powerpipe\'s documented {0,1,2} → ERROR, never PASSED', async () => {
        const r = await runPowerpipeBenchmark({ benchmarkId: 'b', env: process.env, secretValues: [], exec: fakeExec(ALL_OK, false, false, 137) });
        expect(r.status).toBe('ERROR');
    });

    it('a failure carrying no exit status at all → ERROR, never PASSED', async () => {
        const r = await runPowerpipeBenchmark({ benchmarkId: 'b', env: process.env, secretValues: [], exec: fakeExec(ALL_OK, false) });
        expect(r.status).toBe('ERROR');
    });

    it('exit 2 (the collector counted a control error) → ERROR, never PASSED', async () => {
        // Exit 2 is a COMPLETED run, so its JSON is parsed rather than
        // discarded — but the collector says a control broke and our parse of
        // this payload says none did. We do not certify an account over that
        // disagreement. (See powerpipe-core.test.ts for the FAILED and ERROR
        // arms of the same exit code, which are untouched.)
        const r = await runPowerpipeBenchmark({ benchmarkId: 'b', env: process.env, secretValues: [], exec: fakeExec(ALL_OK, false, false, 2) });
        expect(r.status).toBe('ERROR');
    });

    it('exit 2 with output we cannot parse → ERROR, never PASSED', async () => {
        const r = await runPowerpipeBenchmark({ benchmarkId: 'b', env: process.env, secretValues: [], exec: fakeExec('not json at all', false, false, 2) });
        expect(r.status).toBe('ERROR');
    });

    it('zero parsed controls (empty output) → ERROR, never PASSED', async () => {
        const r = await runPowerpipeBenchmark({ benchmarkId: 'b', env: process.env, secretValues: [], exec: fakeExec('{}', true) });
        expect(r.status).toBe('ERROR');
    });

    it('exit 1 with nothing parseable is still ERROR — parsing it is not a way in', async () => {
        const r = await runPowerpipeBenchmark({ benchmarkId: 'b', env: process.env, secretValues: [], exec: fakeExec('', false, false, 1) });
        expect(r.status).toBe('ERROR');
    });

    it('CLI missing → ERROR', async () => {
        const r = await runPowerpipeBenchmark({ benchmarkId: 'b', env: process.env, secretValues: [], exec: fakeExec('', false, true) });
        expect(r.status).toBe('ERROR');
    });
});

/**
 * The counterweight, and it belongs in THIS file. Fail-closed is a claim about
 * what a collector does with a run it could not read; it is not a licence to
 * refuse every run that found something. Powerpipe exits 1 for "one or more
 * alarms", so before #2284 the two were conflated and every real benchmark was
 * discarded — the fail-closed posture had quietly become fail-shut, and no test
 * here could tell.
 */
describe('H2 — a run that DID complete is scored, not refused', () => {
    it('exit 1 with alarming controls → FAILED, with the real counts', async () => {
        const alarming = powerpipeBenchmarkJson('b', {
            controls: [powerpipeControl('c1', 'ok'), powerpipeControl('c2', 'alarm')],
        });
        const r = await runPowerpipeBenchmark({ benchmarkId: 'b', env: process.env, secretValues: [], exec: fakeExec(alarming, false, false, 1) });
        expect(r.status).toBe('FAILED');
        expect(r.summaryObj?.counts.alarm).toBe(1);
    });

    it('exit 1 with an ALL-OK payload still PASSES — the code gates nothing on its own', async () => {
        // Powerpipe would not normally return 1 for a benchmark with no alarms,
        // but the verdict must come from the controls, not from the exit code.
        const r = await runPowerpipeBenchmark({ benchmarkId: 'b', env: process.env, secretValues: [], exec: fakeExec(powerpipeBenchmarkJson('b', { controls: [powerpipeControl('c1', 'ok')] }), false, false, 1) });
        expect(r.status).toBe('PASSED');
    });
});

/**
 * The collector exited ZERO and wrote well-formed JSON — every refusal above is
 * bypassed and the verdict is decided purely by reading the controls. That is
 * the only path on which a misparse can manufacture a pass, and it is the path
 * #2301 was open on.
 */
describe('H2 — a run that produced no usable observation is never PASSED', () => {
    const runOn = (stdout: string) =>
        runPowerpipeBenchmark({ benchmarkId: 'b', env: process.env, secretValues: [], exec: fakeExec(stdout, true) });

    it('every control errored on a dead credential → ERROR, never PASSED', async () => {
        // The measured shape: a benchmark run whose every control failed with
        // InvalidClientTokenId. Each control carries error counters and null
        // rows. Reading those as `skip` left no alarms and no errors, so the
        // ladder called it PASSED — a revoked credential scoring a clean audit.
        const r = await runOn(
            powerpipeBenchmarkJson('b', {
                controls: [powerpipeErroredControl('c1'), powerpipeErroredControl('c2')],
            }),
        );
        expect(r.status).toBe('ERROR');
        expect(r.summaryObj?.counts.error).toBe(2);
        expect(r.summaryObj?.counts.skip).toBe(0);
    });

    it('one dead control among healthy ones still ERRORs rather than passing', async () => {
        const r = await runOn(
            powerpipeBenchmarkJson('b', {
                controls: [powerpipeControl('c1', 'ok'), powerpipeErroredControl('c2')],
            }),
        );
        expect(r.status).toBe('ERROR');
    });

    it('controls in a shape we cannot read → ERROR, never PASSED', async () => {
        // Should the collector's summary shape ever move again, the counters
        // stop being legible. That must surface as ERROR, not as a quiet pass.
        const r = await runOn(
            powerpipeBenchmarkJson('b', {
                controls: [
                    powerpipeControl('c1', 'ok', { summary: groupShapedControlSummary('ok') as never, results: null }),
                ],
            }),
        );
        expect(r.status).toBe('ERROR');
        expect(r.summaryObj?.counts.unknown).toBe(1);
    });

    it('a genuinely empty scope still PASSES — unknown has not swallowed skip', async () => {
        // The counterweight: if illegible and inapplicable were merged the other
        // way, an account with nothing in scope would ERROR forever.
        const r = await runOn(
            powerpipeBenchmarkJson('b', {
                controls: [powerpipeControl('c1', 'ok'), powerpipeControl('c2', 'skip')],
            }),
        );
        expect(r.status).toBe('PASSED');
    });
});

describe('H2 — empty populations are NOT_APPLICABLE (identity)', () => {
    it('no accounts → NOT_APPLICABLE', () => {
        expect(runIdentityCheck('mfa_enforced', [], {}, NOW).status).toBe('NOT_APPLICABLE');
    });

    it('admin membership unknown (null) for all → no_dormant_admins NOT_APPLICABLE', () => {
        const accounts = [acct({ isAdmin: null }), acct({ externalUserId: 'u2', email: 'b@x.com', isAdmin: null })];
        expect(runIdentityCheck('no_dormant_admins', accounts, {}, NOW).status).toBe('NOT_APPLICABLE');
        expect(runIdentityCheck('admin_count_within_threshold', accounts, {}, NOW).status).toBe('NOT_APPLICABLE');
    });

    it('MFA signal unknown (null) for all → mfa_enforced NOT_APPLICABLE', () => {
        expect(runIdentityCheck('mfa_enforced', [acct({ mfaEnrolled: null })], {}, NOW).status).toBe('NOT_APPLICABLE');
    });

    it('SSO signal unknown (null) for all → sso_enforced NOT_APPLICABLE', () => {
        expect(runIdentityCheck('sso_enforced', [acct({ ssoEnrolled: null })], {}, NOW).status).toBe('NOT_APPLICABLE');
    });

    it('a KNOWN non-MFA account can still FAIL (the check isn\'t neutered)', () => {
        expect(runIdentityCheck('mfa_enforced', [acct({ mfaEnrolled: false })], {}, NOW).status).toBe('FAILED');
    });

    it('a KNOWN admin that is dormant FAILs (real signal works)', () => {
        const dormant = acct({ isAdmin: true, lastActiveAt: new Date('2000-01-01') });
        expect(runIdentityCheck('no_dormant_admins', [dormant], {}, NOW).status).toBe('FAILED');
    });
});

describe('H2 — empty populations are NOT_APPLICABLE (device / personnel / training)', () => {
    it('device: no devices → NOT_APPLICABLE', () => {
        expect(runDeviceCheck('devices_encrypted', [], NOW).status).toBe('NOT_APPLICABLE');
    });

    it('personnel: empty roster → NOT_APPLICABLE', () => {
        expect(runPersonnelCheck('every_employee_has_manager', { employees: [], accounts: [] }, {}, NOW).status).toBe('NOT_APPLICABLE');
    });

    it('personnel: no departing employees → offboarded_access_removed NOT_APPLICABLE', () => {
        const data = { employees: [{ workEmail: 'a@x.com', status: 'ACTIVE', managerEmployeeId: 'm1', startDate: null }], accounts: [{ email: 'a@x.com', status: 'ACTIVE', provider: 'okta' }] };
        expect(runPersonnelCheck('offboarded_access_removed', data, {}, NOW).status).toBe('NOT_APPLICABLE');
    });

    it('personnel: an OFFBOARDING employee with a live account FAILs offboarded_access_removed', () => {
        const data = { employees: [{ workEmail: 'x@x.com', status: 'OFFBOARDING', managerEmployeeId: 'm1', startDate: null }], accounts: [{ email: 'x@x.com', status: 'ACTIVE', provider: 'okta' }] };
        expect(runPersonnelCheck('offboarded_access_removed', data, {}, NOW).status).toBe('FAILED');
    });

    it('training: no assignments → NOT_APPLICABLE', () => {
        expect(runTrainingCheck('training_completed_annually', { assignments: [], backgroundChecks: [] }, NOW).status).toBe('NOT_APPLICABLE');
    });

    it('training: an open assignment with NO due date does not silently PASS', () => {
        const r = runTrainingCheck('training_completed_annually', { assignments: [{ employeeId: 'e1', employeeEmail: 'e@x.com', status: 'ASSIGNED', dueAt: null, completedAt: null, cadenceDays: 365 }], backgroundChecks: [] }, NOW);
        expect(r.status).toBe('FAILED');
    });
});
