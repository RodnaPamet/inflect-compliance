/**
 * What "Sync now" reports (#4466).
 *
 * The sync route answers 200 for a sync that did not work: the directory and
 * HR reads record ERROR / PARTIAL / SKIPPED and return. The pages decided the
 * banner from `counts.error` alone and counted `identity.upserted` alone, so a
 * revoked Okta credential read as a green "Sync complete … 0 accounts synced"
 * and an HR sync of 300 people read "0 accounts synced".
 */
import { summariseSync } from '@/lib/integrations/sync-outcome';

const noChecks = { total: 0, passed: 0, failed: 0, error: 0 };

describe('the directory read', () => {
    it('reports a FAILED directory sync as an error, with its reason', () => {
        const s = summariseSync({
            identity: { status: 'ERROR', upserted: 0, errorMessage: 'Okta API returned 401' },
            hris: null,
            counts: noChecks,
        });
        expect(s.tone).toBe('error');
        expect(s.parts).toEqual([
            { key: 'directoryError', values: { count: 0 } },
            { key: 'reason', values: { reason: 'Okta API returned 401' } },
        ]);
    });

    it('reports a PARTIAL directory sync as a warning, not a success', () => {
        const s = summariseSync({ identity: { status: 'PARTIAL', upserted: 40 }, counts: noChecks });
        expect(s.tone).toBe('warning');
        expect(s.parts).toEqual([{ key: 'directoryPartial', values: { count: 40 } }]);
    });

    it('reports a contended (SKIPPED) sync as a warning', () => {
        const s = summariseSync({ identity: { status: 'SKIPPED', upserted: 0 }, counts: noChecks });
        expect(s.tone).toBe('warning');
        expect(s.parts[0].key).toBe('directorySkipped');
    });

    it('reports a passed sync in green with the accounts it read', () => {
        const s = summariseSync({ identity: { status: 'PASSED', upserted: 120 }, counts: noChecks });
        expect(s.tone).toBe('success');
        expect(s.parts).toEqual([{ key: 'directoryPassed', values: { count: 120 } }]);
    });

    it('reads a status it does not know as an error, never a success', () => {
        const s = summariseSync({ identity: { status: 'SOMETHING_NEW', upserted: 3 }, counts: noChecks });
        expect(s.tone).toBe('error');
        expect(s.parts[0].key).toBe('directoryError');
    });
});

describe('the HR read', () => {
    it('counts the people an HR sync read', () => {
        const s = summariseSync({ identity: null, hris: { status: 'PASSED', upserted: 300 }, counts: noChecks });
        expect(s.tone).toBe('success');
        expect(s.parts).toEqual([{ key: 'hrPassed', values: { count: 300 } }]);
    });

    it('reports a failed HR sync as an error, with its reason', () => {
        const s = summariseSync({
            hris: { status: 'ERROR', upserted: 0, errorMessage: 'Workday token expired' },
            counts: noChecks,
        });
        expect(s.tone).toBe('error');
        expect(s.parts).toContainEqual({ key: 'reason', values: { reason: 'Workday token expired' } });
    });
});

describe('the checks', () => {
    it('counts checks that could not run, and colours the banner by them', () => {
        const s = summariseSync({ counts: { total: 3, passed: 1, failed: 1, error: 1 } });
        expect(s.tone).toBe('error');
        expect(s.parts).toEqual([
            { key: 'checks', values: { total: 3, passed: 1, failed: 1, errored: 1 } },
        ]);
    });

    it('says no check is wired, rather than "0 checks", when nothing ran — and not in green', () => {
        const s = summariseSync({ identity: null, hris: null, counts: noChecks });
        expect(s.tone).toBe('warning');
        expect(s.parts).toEqual([{ key: 'ranNothing' }]);
    });

    it('a failed directory read is not hidden by passing checks', () => {
        const s = summariseSync({
            identity: { status: 'ERROR', upserted: 0 },
            counts: { total: 2, passed: 2, failed: 0, error: 0 },
        });
        expect(s.tone).toBe('error');
    });
});
