/**
 * Step 5b: the campaign findings.
 *
 * The hardening list asks for a fixture and a test per finding type, and for
 * one invariant on top: "no other state ever suppresses a leaver with live
 * access". That invariant gets an ADVERSARIAL test rather than a happy-path
 * one — every other finding is piled onto a leaver at once, and the leaver must
 * still be there. A per-finding test cannot catch a precedence rule; only
 * loading the subject with competing states can.
 */
import {
    DEFAULT_DORMANT_DAYS,
    LEGACY_FINDINGS,
    findingsFor,
    populationContext,
    type FindingContext,
    type FindingSubject,
    type LegacyFinding,
} from '@/lib/legacy-access/findings';

const NOW = new Date('2026-10-10T00:00:00.000Z');
const LONG_AGO = new Date('2024-01-01T00:00:00.000Z');
const RECENT = new Date('2026-10-01T00:00:00.000Z');

function subject(over: Partial<FindingSubject> = {}): FindingSubject {
    return {
        accountKey: 'jsmith',
        status: 'ACTIVE',
        lastLoginAt: RECENT,
        isPrivileged: false,
        department: 'Finance',
        managerRef: 'mgr-1',
        outcome: 'LINKED',
        employeeId: 'e1',
        employmentStatus: 'ACTIVE',
        classification: 'EMPLOYEE',
        ownerUserId: null,
        ...over,
    };
}

function context(over: Partial<FindingContext> = {}): FindingContext {
    return {
        now: NOW,
        dormantDays: DEFAULT_DORMANT_DAYS,
        populationReportsLastLogin: true,
        accountsPerEmployee: new Map([['e1', 1]]),
        priorCertification: new Map(),
        ...over,
    };
}

describe('each finding type has a fixture that raises it', () => {
    it('LEAVER_WITH_LIVE_ACCESS — terminated employee, account still usable', () => {
        const f = findingsFor(subject({ employmentStatus: 'TERMINATED' }), context());
        expect(f).toContain<LegacyFinding>('LEAVER_WITH_LIVE_ACCESS');
    });

    it('ORPHAN — the engine found nobody', () => {
        expect(findingsFor(subject({ outcome: 'UNMATCHED', employeeId: null, employmentStatus: null, classification: null }), context()))
            .toContain<LegacyFinding>('ORPHAN');
    });

    it('ORPHAN — or a reviewer looked and said nobody can be found', () => {
        expect(findingsFor(subject({ classification: 'ORPHAN', employeeId: null, employmentStatus: null }), context()))
            .toContain<LegacyFinding>('ORPHAN');
    });

    it('UNRESOLVED_AMBIGUITY — two equally supported candidates', () => {
        expect(findingsFor(subject({ outcome: 'AMBIGUOUS', employeeId: null, employmentStatus: null }), context()))
            .toContain<LegacyFinding>('UNRESOLVED_AMBIGUITY');
    });

    it('DORMANT — last login older than the threshold', () => {
        expect(findingsFor(subject({ lastLoginAt: LONG_AGO }), context()))
            .toContain<LegacyFinding>('DORMANT');
    });

    it('PRIVILEGED', () => {
        expect(findingsFor(subject({ isPrivileged: true }), context()))
            .toContain<LegacyFinding>('PRIVILEGED');
    });

    it('NON_PERSON_WITHOUT_OWNER — a service account nobody owns', () => {
        expect(findingsFor(subject({ classification: 'NON_PERSON', ownerUserId: null, employeeId: null, employmentStatus: null }), context()))
            .toContain<LegacyFinding>('NON_PERSON_WITHOUT_OWNER');
    });

    it('MULTIPLE_ACCOUNTS_ONE_PERSON — jsmith and john.smith are one person', () => {
        const f = findingsFor(subject(), context({ accountsPerEmployee: new Map([['e1', 2]]) }));
        expect(f).toContain<LegacyFinding>('MULTIPLE_ACCOUNTS_ONE_PERSON');
    });

    it('MOVER_SUSPECT — the department changed since the last certification', () => {
        const f = findingsFor(
            subject({ department: 'Engineering' }),
            context({ priorCertification: new Map([['jsmith', { department: 'Finance', managerRef: 'mgr-1' }]]) })
        );
        expect(f).toContain<LegacyFinding>('MOVER_SUSPECT');
    });

    it('MOVER_SUSPECT — or the manager did', () => {
        const f = findingsFor(
            subject({ managerRef: 'mgr-2' }),
            context({ priorCertification: new Map([['jsmith', { department: 'Finance', managerRef: 'mgr-1' }]]) })
        );
        expect(f).toContain<LegacyFinding>('MOVER_SUSPECT');
    });

    it('every member of LEGACY_FINDINGS is raised by one of the fixtures above', () => {
        // The denominator. A ninth finding added to the union with no fixture
        // would otherwise sit there untested, and this test names it.
        const raised = new Set<LegacyFinding>([
            ...findingsFor(subject({ employmentStatus: 'TERMINATED' }), context()),
            ...findingsFor(subject({ outcome: 'UNMATCHED', employeeId: null, employmentStatus: null, classification: null }), context()),
            ...findingsFor(subject({ outcome: 'AMBIGUOUS', employeeId: null, employmentStatus: null }), context()),
            ...findingsFor(subject({ lastLoginAt: LONG_AGO }), context()),
            ...findingsFor(subject({ isPrivileged: true }), context()),
            ...findingsFor(subject({ classification: 'NON_PERSON', ownerUserId: null, employeeId: null, employmentStatus: null }), context()),
            ...findingsFor(subject(), context({ accountsPerEmployee: new Map([['e1', 2]]) })),
            ...findingsFor(subject({ department: 'Engineering' }), context({ priorCertification: new Map([['jsmith', { department: 'Finance', managerRef: null }]]) })),
        ]);
        expect([...LEGACY_FINDINGS].filter((f) => !raised.has(f))).toEqual([]);
    });
});

describe('nothing suppresses a leaver with live access', () => {
    it.each([
        ['orphan', { outcome: 'UNMATCHED' as const }],
        ['ambiguous', { outcome: 'AMBIGUOUS' as const }],
        ['non-person', { classification: 'NON_PERSON' as const }],
        ['privileged', { isPrivileged: true }],
        ['dormant', { lastLoginAt: LONG_AGO }],
        ['external', { classification: 'EXTERNAL' as const }],
        ['locked', { status: 'LOCKED' }],
        ['unknown status', { status: 'UNKNOWN' }],
    ])('a terminated employee is STILL a leaver when also %s', (_label, over) => {
        const f = findingsFor(
            subject({ employmentStatus: 'TERMINATED', ...over }),
            context({ accountsPerEmployee: new Map([['e1', 3]]) })
        );
        expect(f).toContain<LegacyFinding>('LEAVER_WITH_LIVE_ACCESS');
    });

    it('and survives EVERY other state at once', () => {
        // The adversarial case: load the subject with everything.
        const f = findingsFor(
            subject({
                employmentStatus: 'TERMINATED',
                outcome: 'AMBIGUOUS',
                classification: 'NON_PERSON',
                ownerUserId: null,
                isPrivileged: true,
                lastLoginAt: LONG_AGO,
                status: 'UNKNOWN',
                department: 'Engineering',
            }),
            context({
                accountsPerEmployee: new Map([['e1', 4]]),
                priorCertification: new Map([['jsmith', { department: 'Finance', managerRef: 'mgr-1' }]]),
            })
        );
        expect(f).toContain<LegacyFinding>('LEAVER_WITH_LIVE_ACCESS');
        // And it is genuinely crowded — if this were 1 the test above would be
        // proving nothing about precedence.
        expect(f.length).toBeGreaterThanOrEqual(6);
    });

    it('a DISABLED account is not a leaver with LIVE access', () => {
        // The other direction. Without this, "leaver" would fire on every
        // terminated employee whose access was correctly removed, and the
        // finding would mean nothing.
        const f = findingsFor(
            subject({ employmentStatus: 'TERMINATED', status: 'DISABLED' }),
            context()
        );
        expect(f).not.toContain<LegacyFinding>('LEAVER_WITH_LIVE_ACCESS');
    });

    it('an UNKNOWN account status IS live', () => {
        // A leaver whose account state the application would not disclose is
        // the case that most needs raising. Treating unknown as
        // probably-disabled would suppress exactly this.
        expect(findingsFor(subject({ employmentStatus: 'TERMINATED', status: 'UNKNOWN' }), context()))
            .toContain<LegacyFinding>('LEAVER_WITH_LIVE_ACCESS');
    });
});

describe('dormancy only speaks when the population does', () => {
    it('raises nothing when NO account reports a last login', () => {
        // Otherwise a legacy app that does not carry the column makes every
        // single row dormant, and a finding on every row is a finding on none.
        const f = findingsFor(
            subject({ lastLoginAt: null }),
            context({ populationReportsLastLogin: false })
        );
        expect(f).not.toContain<LegacyFinding>('DORMANT');
    });

    it('but a missing timestamp IS dormancy where the neighbours report one', () => {
        const f = findingsFor(
            subject({ lastLoginAt: null }),
            context({ populationReportsLastLogin: true })
        );
        expect(f).toContain<LegacyFinding>('DORMANT');
    });

    it('populationContext derives the flag and the per-employee counts together', () => {
        const ctx = populationContext([
            subject({ accountKey: 'a', employeeId: 'e1', lastLoginAt: null }),
            subject({ accountKey: 'b', employeeId: 'e1', lastLoginAt: RECENT }),
            subject({ accountKey: 'c', employeeId: 'e2', lastLoginAt: null }),
        ]);
        expect(ctx.populationReportsLastLogin).toBe(true);
        expect(ctx.accountsPerEmployee.get('e1')).toBe(2);
        expect(ctx.accountsPerEmployee.get('e2')).toBe(1);
    });

    it('and reports false when the whole population is silent', () => {
        const ctx = populationContext([
            subject({ accountKey: 'a', lastLoginAt: null }),
            subject({ accountKey: 'b', lastLoginAt: null }),
        ]);
        expect(ctx.populationReportsLastLogin).toBe(false);
    });
});

describe('what must NOT be raised', () => {
    it('a first sighting is not a mover', () => {
        // No prior certification. The alternative makes every subject of a
        // FIRST campaign a mover, which buries the real ones on cycle two.
        expect(findingsFor(subject({ department: 'Engineering' }), context()))
            .not.toContain<LegacyFinding>('MOVER_SUSPECT');
    });

    it('a department the mapping stopped carrying is not a move', () => {
        // Absence on either side is a change to the MAPPING. Raising it would
        // turn one configuration edit into a mover finding on every row.
        const f = findingsFor(
            subject({ department: null }),
            context({ priorCertification: new Map([['jsmith', { department: 'Finance', managerRef: null }]]) })
        );
        expect(f).not.toContain<LegacyFinding>('MOVER_SUSPECT');
    });

    it('a department that only changed CASE or padding is not a move', () => {
        const f = findingsFor(
            subject({ department: '  finance ' }),
            context({ priorCertification: new Map([['jsmith', { department: 'Finance', managerRef: null }]]) })
        );
        expect(f).not.toContain<LegacyFinding>('MOVER_SUSPECT');
    });

    it('an unknown privilege is not privilege', () => {
        // The inverse of the dormancy decision, deliberately: privilege is a
        // positive claim about an entitlement, and absence is not evidence for
        // it. A critical badge on every row of a snapshot that cannot answer
        // would be worse than silence.
        expect(findingsFor(subject({ isPrivileged: null }), context()))
            .not.toContain<LegacyFinding>('PRIVILEGED');
    });

    it('a NON_PERSON WITH an owner is not a finding', () => {
        const f = findingsFor(
            subject({ classification: 'NON_PERSON', ownerUserId: 'user-7', employeeId: null, employmentStatus: null }),
            context()
        );
        expect(f).not.toContain<LegacyFinding>('NON_PERSON_WITHOUT_OWNER');
    });

    it('a clean active employee raises nothing at all', () => {
        // The denominator for every test above: if this were non-empty, the
        // fixtures would not be isolating anything.
        expect(findingsFor(subject(), context())).toEqual([]);
    });
});
