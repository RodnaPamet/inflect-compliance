/**
 * Step 5b: what a legacy recertification campaign RAISES about each account.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FINDINGS ARE A SET, NOT A LABEL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every subject gets zero or more findings, and they accumulate. That is not a
 * modelling preference — it is the step's own hardening requirement:
 *
 *     no other state ever suppresses a leaver with live access
 *
 * A single-label design cannot honour that. Sooner or later something has to be
 * "the" label, and the day a privileged dormant leaver arrives, two of those
 * three win and the third is the one that mattered. A set has no precedence to
 * get wrong.
 *
 * It also matches what a reviewer needs: "this is a leaver AND privileged AND
 * one of three accounts belonging to the same person" is three reasons to
 * revoke, and a campaign that showed one of them would be understating the case
 * every time.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DORMANCY, AND THE TRAP IT CARRIES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A legacy application may not report last-login at all. The existing identity
 * check treats a missing timestamp as dormant — correct there, because a
 * directory that answers for other accounts and not this one is telling you
 * something. Applied to a legacy snapshot with NO `lastLoginAt` anywhere it
 * would mark the entire population dormant, and a finding on every row is a
 * finding on none.
 *
 * So dormancy is only computed when the POPULATION reports it, which is the
 * same discipline as `no_dormant_admins`' `NOT_APPLICABLE` arm: "if admin
 * membership is unknown for the whole population, we cannot identify admins —
 * NOT_APPLICABLE, not a vacuous pass."
 *
 * Within a population that does report it, a missing timestamp on ONE account
 * IS dormancy — that account has never been seen to log in while its
 * neighbours have.
 *
 * @module lib/legacy-access/findings
 */

/** Reused rather than redeclared — see `providers/identity/types.ts`. */
export const DEFAULT_DORMANT_DAYS = 90;

export type LegacyFinding =
    | 'LEAVER_WITH_LIVE_ACCESS'
    | 'ORPHAN'
    | 'UNRESOLVED_AMBIGUITY'
    | 'DORMANT'
    | 'PRIVILEGED'
    | 'NON_PERSON_WITHOUT_OWNER'
    | 'MULTIPLE_ACCOUNTS_ONE_PERSON'
    | 'MOVER_SUSPECT';

export const LEGACY_FINDINGS: readonly LegacyFinding[] = [
    'LEAVER_WITH_LIVE_ACCESS',
    'ORPHAN',
    'UNRESOLVED_AMBIGUITY',
    'DORMANT',
    'PRIVILEGED',
    'NON_PERSON_WITHOUT_OWNER',
    'MULTIPLE_ACCOUNTS_ONE_PERSON',
    'MOVER_SUSPECT',
];

/**
 * Account statuses that mean the access is still USABLE.
 *
 * `UNKNOWN` is in here, and that is the whole point. A leaver whose account
 * state the application would not tell us about is the case that most needs
 * raising — treating unknown as "probably disabled" would suppress exactly the
 * finding this campaign exists to produce. The canonical status set is
 * ACTIVE | DISABLED | LOCKED | EXPIRED | UNKNOWN.
 */
const LIVE_STATUSES: readonly string[] = ['ACTIVE', 'LOCKED', 'UNKNOWN'];

export interface FindingSubject {
    readonly accountKey: string;
    readonly status: string | null;
    readonly lastLoginAt: Date | null;
    readonly isPrivileged: boolean | null;
    readonly department: string | null;
    readonly managerRef: string | null;
    /** The engine's outcome for this account on the reconciled run. */
    readonly outcome: 'LINKED' | 'SUGGESTED' | 'AMBIGUOUS' | 'UNMATCHED' | 'NON_PERSON';
    readonly employeeId: string | null;
    /** The employee's employment status, when the account resolved to one. */
    readonly employmentStatus: 'ACTIVE' | 'TERMINATED' | null;
    /** A reviewer's standing classification, when one exists. */
    readonly classification: 'EMPLOYEE' | 'NON_PERSON' | 'EXTERNAL' | 'ORPHAN' | null;
    readonly ownerUserId: string | null;
}

export interface FindingContext {
    readonly now: Date;
    readonly dormantDays: number;
    /**
     * Does ANY account in this campaign report a last login? Computed over the
     * population, not per subject — see the module docblock.
     */
    readonly populationReportsLastLogin: boolean;
    /** employeeId → how many accounts in this campaign resolve to them. */
    readonly accountsPerEmployee: ReadonlyMap<string, number>;
    /**
     * What the LAST CLOSED certification recorded for this subject, by
     * accountKey. Absent means this subject has never been certified, which is
     * not a mover — it is a first sighting, and calling it one would make every
     * subject of a first campaign a mover.
     */
    readonly priorCertification: ReadonlyMap<
        string,
        { readonly department: string | null; readonly managerRef: string | null }
    >;
}

/**
 * Every finding that holds for one subject.
 *
 * Pure, and deliberately takes `now` rather than reading a clock: a campaign's
 * findings are computed once at creation and stored, so the same inputs must
 * produce the same findings when a test or an auditor re-derives them.
 */
export function findingsFor(
    s: FindingSubject,
    ctx: FindingContext
): readonly LegacyFinding[] {
    const out: LegacyFinding[] = [];
    const live = LIVE_STATUSES.includes(s.status ?? 'UNKNOWN');

    // 1. The one that must never be suppressed. Checked first for readability
    //    only — nothing below can remove it, because this is a set.
    if (s.employmentStatus === 'TERMINATED' && live) {
        out.push('LEAVER_WITH_LIVE_ACCESS');
    }

    // 2. Orphan. Either the engine found nobody, or a reviewer looked and said
    //    nobody can be found. The second is a stronger statement than the
    //    first and still the same finding: an account with no owner.
    if (s.outcome === 'UNMATCHED' || s.classification === 'ORPHAN') {
        out.push('ORPHAN');
    }

    // 3. Ambiguity the engine refused to resolve. NOT the same as several
    //    accounts for one person (8 below): this is one account with two
    //    equally-supported candidates, which is a question about identity.
    if (s.outcome === 'AMBIGUOUS') {
        out.push('UNRESOLVED_AMBIGUITY');
    }

    // 4. Dormancy, only where the population can speak to it.
    if (ctx.populationReportsLastLogin) {
        const cutoff = new Date(ctx.now.getTime() - ctx.dormantDays * 86_400_000);
        if (s.lastLoginAt === null || s.lastLoginAt < cutoff) out.push('DORMANT');
    }

    // 5. Privileged. `null` is NOT privileged — the mapping did not carry the
    //    column, and inventing privilege would put a critical badge on every
    //    row of a snapshot that cannot answer. The inverse of the dormancy
    //    decision, and deliberately so: dormancy raises on absence within a
    //    population that reports it; privilege is a positive claim about an
    //    entitlement and absence is not evidence for it.
    if (s.isPrivileged === true) out.push('PRIVILEGED');

    // 6. A service account nobody owns. Both routes to the classification
    //    count: a reviewer's NON_PERSON without an owner, and the engine's
    //    NON_PERSON rule, which never has one.
    const nonPerson = s.classification === 'NON_PERSON' || s.outcome === 'NON_PERSON';
    if (nonPerson && !s.ownerUserId) out.push('NON_PERSON_WITHOUT_OWNER');

    // 7. `jsmith` and `john.smith` are not an ambiguity — each resolved
    //    confidently — but one person holding two logins into one application
    //    is a finding, and it is invisible from either row on its own.
    if (s.employeeId) {
        const n = ctx.accountsPerEmployee.get(s.employeeId) ?? 0;
        if (n > 1) out.push('MULTIPLE_ACCOUNTS_ONE_PERSON');
    }

    // 8. Mover-suspect. A mover is unrepresentable in the JML chain by design;
    //    detecting one at review time adds no JML direction, because a review
    //    writes nothing to a directory. It is a prompt for a human.
    //
    //    Only against a PRIOR certification. No prior record is a first
    //    sighting, not a move — the alternative makes every subject of a first
    //    campaign a mover, which would bury the real ones on cycle two.
    const prior = ctx.priorCertification.get(s.accountKey);
    if (prior) {
        const movedDept = differs(prior.department, s.department);
        const movedMgr = differs(prior.managerRef, s.managerRef);
        if (movedDept || movedMgr) out.push('MOVER_SUSPECT');
    }

    return out;
}

/**
 * Did a value change in a way worth raising?
 *
 * Absence on EITHER side is not a change. A department the mapping stopped
 * carrying, or started carrying, is a change to the MAPPING — and raising it as
 * a personnel move would turn one configuration edit into a mover finding on
 * every row at once.
 */
function differs(before: string | null, after: string | null): boolean {
    if (before === null || after === null) return false;
    return before.trim().toLowerCase() !== after.trim().toLowerCase();
}

/**
 * The population-level inputs, derived from the subjects themselves.
 *
 * Here rather than at the call site because both are easy to get subtly wrong:
 * the dormancy flag has to range over the WHOLE population, and the per-employee
 * count has to be taken over the campaign's subjects rather than over the
 * tenant's accounts — a person with one account in this application and three
 * in another is not a finding here.
 */
export function populationContext(
    subjects: readonly FindingSubject[]
): Pick<FindingContext, 'populationReportsLastLogin' | 'accountsPerEmployee'> {
    const accountsPerEmployee = new Map<string, number>();
    let reports = false;
    for (const s of subjects) {
        if (s.lastLoginAt !== null) reports = true;
        if (s.employeeId) {
            accountsPerEmployee.set(s.employeeId, (accountsPerEmployee.get(s.employeeId) ?? 0) + 1);
        }
    }
    return { populationReportsLastLogin: reports, accountsPerEmployee };
}
