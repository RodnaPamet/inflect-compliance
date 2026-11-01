/**
 * The owner-orphan pass's decisions, asserted on the pure module (#3670).
 *
 * What "the owner has left" means, the HR match rule (exact normalised email,
 * exactly one employee, never a name), the row status rule, the code-not-text
 * rule for an OWNER_DEPARTED kill, and the ladder the pass's mode climbs.
 * The database half — the pass, the kill, the lift — is
 * `tests/integration/agent-owner-orphan-pass.test.ts`.
 */
import {
    classifyOwnerDeparture,
    indexRosterByEmailKey,
    isOwnerDepartedKill,
    matchOwnerToRoster,
    ORPHAN_PASS_ACTOR,
    ORPHAN_PASS_MAX_MODE,
    orphanPassStatus,
    ownerDepartedReasonText,
    type RosterEmployee,
} from '@/lib/agentic/owner-orphan';
import { describeOrphanPassModeRefusal, orphanPassModeRefusal } from '@/app-layer/usecases/agent-owner-orphan-policy';
import { DRY_RUN_MIN_DAYS } from '@/app-layer/usecases/identity-write-policy';
import { resolveRoutePermission } from '@/lib/security/route-permissions';

const DAY = 86_400_000;
const NOW = new Date('2026-11-02T05:15:00Z');

function employee(id: string, workEmail: string, status = 'ACTIVE', managerEmployeeId: string | null = null): RosterEmployee {
    return { id, workEmail, status, managerEmployeeId };
}

describe('the HR signal matches by exact normalised email, and by nothing else', () => {
    const roster = [
        employee('e-dana', 'dana.smith@acme.test', 'TERMINATED', 'e-boss'),
        employee('e-boss', 'boss@acme.test'),
        // The same person's NAME at a different address — a name match would
        // pair them, and the pass must not.
        employee('e-dana-2', 'd.smith@other.test', 'TERMINATED'),
        // Two employees whose addresses fold to one key: not a match, a data problem.
        employee('e-twin-a', 'Twin@acme.test', 'TERMINATED'),
        employee('e-twin-b', 'twin@acme.test', 'TERMINATED'),
        employee('e-blank', '   '),
    ];
    const index = indexRosterByEmailKey(roster);

    it('matches across case and surrounding whitespace — the emailKey rule', () => {
        expect(matchOwnerToRoster('  Dana.Smith@ACME.test ', index, true)).toEqual({
            kind: 'ONE',
            employeeId: 'e-dana',
            status: 'TERMINATED',
            managerEmployeeId: 'e-boss',
        });
    });

    it('never matches on anything a name could supply', () => {
        // Same local part, different domain: no match.
        expect(matchOwnerToRoster('dana.smith@other.test', index, true)).toEqual({ kind: 'NONE' });
        // A folded "+tag" is NOT the same key — emailKey is byte equality after
        // trim and lowercase, never a folded address.
        expect(matchOwnerToRoster('dana.smith+ops@acme.test', index, true)).toEqual({ kind: 'NONE' });
    });

    it('refuses two employees sharing a key as AMBIGUOUS, never picks one', () => {
        expect(matchOwnerToRoster('twin@acme.test', index, true)).toEqual({
            kind: 'AMBIGUOUS',
            employeeIds: ['e-twin-a', 'e-twin-b'],
        });
    });

    it('lets no absence match another absence', () => {
        expect(matchOwnerToRoster('', index, true)).toEqual({ kind: 'NO_EMAIL' });
        expect(matchOwnerToRoster(null, index, true)).toEqual({ kind: 'NO_EMAIL' });
    });

    it('does not match at all against a roster it could not read in full', () => {
        expect(matchOwnerToRoster('dana.smith@acme.test', index, false)).toEqual({ kind: 'NOT_READ' });
    });
});

describe('classifyOwnerDeparture — each signal, alone and together', () => {
    const noHr = { kind: 'NONE' } as const;

    it.each(['DEACTIVATED', 'REMOVED', 'ABSENT', 'INVITED'] as const)(
        'a %s membership orphans the agent',
        (membership) => {
            const v = classifyOwnerDeparture({ membership, hr: noHr });
            expect(v.orphaned).toBe(true);
            expect(v.signals).toEqual([{ kind: 'MEMBERSHIP_NOT_ACTIVE', membership }]);
        },
    );

    it('an ACTIVE owner with no HR record is not an orphan', () => {
        expect(classifyOwnerDeparture({ membership: 'ACTIVE', hr: noHr })).toEqual({
            orphaned: false,
            signals: [],
            note: null,
        });
    });

    it('a TERMINATED HR record orphans an agent whose owner is still an ACTIVE member', () => {
        const v = classifyOwnerDeparture({
            membership: 'ACTIVE',
            hr: { kind: 'ONE', employeeId: 'e1', status: 'TERMINATED', managerEmployeeId: null },
        });
        expect(v.orphaned).toBe(true);
        expect(v.signals).toEqual([{ kind: 'HR_TERMINATED', employeeId: 'e1' }]);
    });

    it.each(['ACTIVE', 'ONBOARDING', 'OFFBOARDING', 'LEAVE'])('an HR status of %s is not a departure', (status) => {
        const v = classifyOwnerDeparture({
            membership: 'ACTIVE',
            hr: { kind: 'ONE', employeeId: 'e1', status, managerEmployeeId: null },
        });
        expect(v.orphaned).toBe(false);
    });

    it('records BOTH signals when both fire', () => {
        const v = classifyOwnerDeparture({
            membership: 'DEACTIVATED',
            hr: { kind: 'ONE', employeeId: 'e1', status: 'TERMINATED', managerEmployeeId: null },
        });
        expect(v.signals.map((s) => s.kind)).toEqual(['MEMBERSHIP_NOT_ACTIVE', 'HR_TERMINATED']);
    });

    it('notes an ambiguous match and an unread roster rather than guessing', () => {
        expect(
            classifyOwnerDeparture({ membership: 'ACTIVE', hr: { kind: 'AMBIGUOUS', employeeIds: ['a', 'b'] } }),
        ).toEqual({ orphaned: false, signals: [], note: 'HR_MATCH_AMBIGUOUS' });
        expect(classifyOwnerDeparture({ membership: 'ACTIVE', hr: { kind: 'NOT_READ' } }).note).toBe(
            'HR_ROSTER_NOT_READ',
        );
    });
});

describe('an OWNER_DEPARTED kill is recognised by its CODE, never by its text', () => {
    it('reads the code column', () => {
        expect(isOwnerDepartedKill({ reasonCode: 'OWNER_DEPARTED' })).toBe(true);
        expect(isOwnerDepartedKill({ reasonCode: null })).toBe(false);
    });

    it('a person typing the words makes an ordinary kill', () => {
        // The free-text reason is not consulted at all: there is no field on
        // the input for it to read.
        expect(isOwnerDepartedKill({ reasonCode: null, ...{ reason: 'OWNER_DEPARTED' } })).toBe(false);
    });

    it('the reason text names signals and no person', () => {
        const text = ownerDepartedReasonText([
            { kind: 'MEMBERSHIP_NOT_ACTIVE', membership: 'REMOVED' },
            { kind: 'HR_TERMINATED', employeeId: 'emp-123' },
        ]);
        expect(text.startsWith('OWNER_DEPARTED')).toBe(true);
        expect(text).toContain('membership REMOVED');
        // Not even the employee id: the row's subject is the agent.
        expect(text).not.toContain('emp-123');
    });

    it('the system actor is not a user id', () => {
        expect(ORPHAN_PASS_ACTOR).toBe('system:agent-owner-orphan-pass');
    });
});

describe('orphanPassStatus — the row and the job result read one rule', () => {
    const base = { refusal: null, failed: 0, decisionsTruncated: false, rosterRead: true } as const;

    it('a refusal is NOT_APPLICABLE', () => {
        expect(orphanPassStatus({ ...base, refusal: 'MODE_DISABLED', mode: 'DISABLED' })).toBe('NOT_APPLICABLE');
        expect(orphanPassStatus({ ...base, refusal: 'NO_ACTIVE_AGENTS', mode: 'AUTOMATIC' })).toBe('NOT_APPLICABLE');
    });

    it('a dry run applies nothing, so it is NOT_APPLICABLE', () => {
        expect(orphanPassStatus({ ...base, mode: 'DRY_RUN' })).toBe('NOT_APPLICABLE');
    });

    it('anything incomplete is PARTIAL, at either rung', () => {
        expect(orphanPassStatus({ ...base, mode: 'AUTOMATIC', failed: 1 })).toBe('PARTIAL');
        expect(orphanPassStatus({ ...base, mode: 'AUTOMATIC', decisionsTruncated: true })).toBe('PARTIAL');
        expect(orphanPassStatus({ ...base, mode: 'DRY_RUN', rosterRead: false })).toBe('PARTIAL');
    });

    it('a complete automatic pass is PASSED', () => {
        expect(orphanPassStatus({ ...base, mode: 'AUTOMATIC' })).toBe('PASSED');
    });
});

describe('the pass mode climbs the identity ladder', () => {
    const at = (mode: 'DISABLED' | 'DRY_RUN' | 'AUTOMATIC', daysAgo: number | null = null) => ({
        mode,
        dryRunSince: daysAgo === null ? null : new Date(NOW.getTime() - daysAgo * DAY),
    });

    it('narrowing is always allowed, straight to DISABLED included', () => {
        expect(describeOrphanPassModeRefusal(at('AUTOMATIC'), 'DISABLED', NOW)).toBeNull();
        expect(describeOrphanPassModeRefusal(at('DRY_RUN', 0), 'DISABLED', NOW)).toBeNull();
    });

    it('refuses widening by more than one rung', () => {
        expect(describeOrphanPassModeRefusal(at('DISABLED'), 'AUTOMATIC', NOW)).toMatch(/one level at a time/);
    });

    // #4903: the page words the refusal from its code; the sentence is built
    // from the same answer, so the two cannot disagree.
    it('returns each refusal as a code and its arguments', () => {
        expect(orphanPassModeRefusal(at('DISABLED'), 'AUTOMATIC', NOW)).toEqual({
            code: 'MULTI_RUNG',
            from: 'DISABLED',
            to: 'AUTOMATIC',
        });
        expect(orphanPassModeRefusal(at('DRY_RUN'), 'AUTOMATIC', NOW)).toEqual({ code: 'NO_DRY_RUN_START' });
        expect(orphanPassModeRefusal(at('DRY_RUN', 30), 'AUTOMATIC', NOW, 0)).toEqual({
            code: 'TOO_FEW_PASSES',
            passes: 0,
            required: expect.any(Number),
        });
        expect(orphanPassModeRefusal(at('DRY_RUN', 2), 'AUTOMATIC', NOW, 6)).toEqual({
            code: 'DWELL',
            days: 2,
            required: DRY_RUN_MIN_DAYS,
            left: DRY_RUN_MIN_DAYS - 2,
        });
        expect(orphanPassModeRefusal(at('AUTOMATIC'), 'DISABLED', NOW)).toBeNull();
    });

    it('allows DISABLED → DRY_RUN outright', () => {
        expect(describeOrphanPassModeRefusal(at('DISABLED'), 'DRY_RUN', NOW)).toBeNull();
    });

    it('refuses leaving DRY_RUN before the seven-day dwell', () => {
        const refusal = describeOrphanPassModeRefusal(at('DRY_RUN', DRY_RUN_MIN_DAYS - 1), 'AUTOMATIC', NOW, 6);
        expect(refusal).toMatch(new RegExp(`${DRY_RUN_MIN_DAYS - 1} of ${DRY_RUN_MIN_DAYS} required days`));
        expect(DRY_RUN_MIN_DAYS).toBe(7);
    });

    it('refuses leaving DRY_RUN with no recorded pass in the window, however long it waited', () => {
        expect(describeOrphanPassModeRefusal(at('DRY_RUN', 30), 'AUTOMATIC', NOW, 0)).toMatch(
            /0 owner-orphan passes since the window opened/,
        );
    });

    it('refuses leaving a DRY_RUN with no recorded start', () => {
        expect(describeOrphanPassModeRefusal(at('DRY_RUN'), 'AUTOMATIC', NOW, 3)).toMatch(/no recorded start/);
    });

    it('allows DRY_RUN → AUTOMATIC after the dwell, with a pass in the window', () => {
        expect(describeOrphanPassModeRefusal(at('DRY_RUN', DRY_RUN_MIN_DAYS), 'AUTOMATIC', NOW, 1)).toBeNull();
    });

    it('refuses a rung above the ceiling — the brake the constant is kept for', () => {
        expect(describeOrphanPassModeRefusal(at('DRY_RUN', 30), 'AUTOMATIC', NOW, 5, 'DRY_RUN')).toMatch(
            /above the highest rung/,
        );
        // At the top rung today, so no rung is above it.
        expect(ORPHAN_PASS_MAX_MODE).toBe('AUTOMATIC');
    });
});

describe('the mode route resolves to tenant lifecycle, above the register catch-all', () => {
    it.each(['GET', 'PUT'] as const)('%s', (method) => {
        expect(
            resolveRoutePermission('/api/t/acme/admin/agents/owner-orphan-pass', method)?.permission,
        ).toBe('admin.tenant_lifecycle');
    });
});
