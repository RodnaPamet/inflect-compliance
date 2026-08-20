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

const NOW = new Date('2026-07-07T00:00:00Z');
const fakeExec = (stdout: string, ok = true, missing = false) => async () => ({ ok, stdout, stderr: ok ? '' : 'boom', missing });

function acct(over: Partial<NormalizedIdentityAccount> = {}): NormalizedIdentityAccount {
    return { externalUserId: 'u1', email: 'a@x.com', status: 'ACTIVE', isAdmin: false, mfaEnrolled: true, ssoEnrolled: true, onPremisesSyncEnabled: null, groups: [], lastActiveAt: NOW, ...over };
}

describe('H2 — collectors fail closed', () => {
    it('non-zero collector exit → ERROR, never PASSED', async () => {
        const r = await runPowerpipeBenchmark({ benchmarkId: 'b', env: process.env, secretValues: [], exec: fakeExec('', false) });
        expect(r.status).toBe('ERROR');
    });

    it('zero parsed controls (empty output) → ERROR, never PASSED', async () => {
        const r = await runPowerpipeBenchmark({ benchmarkId: 'b', env: process.env, secretValues: [], exec: fakeExec('{}', true) });
        expect(r.status).toBe('ERROR');
    });

    it('CLI missing → ERROR', async () => {
        const r = await runPowerpipeBenchmark({ benchmarkId: 'b', env: process.env, secretValues: [], exec: fakeExec('', false, true) });
        expect(r.status).toBe('ERROR');
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
