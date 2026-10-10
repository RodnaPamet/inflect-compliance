/**
 * The deterministic reconciliation engine (Step 3b).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS MODULE IS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Given legacy accounts, an HR roster, a directory index and the aliases a
 * human has already confirmed, decide for each account exactly one of five
 * outcomes. `LINKED` is the only one that acts without a reviewer, so the whole
 * design is arranged around one asymmetry:
 *
 *   A missed link costs a reviewer thirty seconds.
 *   A WRONG link grants one person another person's access, silently, and the
 *   recertification campaign then records a human approving it.
 *
 * So recall is a reported number and precision is a gate. `tests/unit/
 * identity-reconcile-precision.test.ts` fails on a single false `LINKED` and
 * merely prints recall.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY STRENGTH IS NOT A NUMBER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The obvious design gives every signal a weight, sums them, and links above a
 * threshold. That design cannot hold the precision gate, because enough weak
 * evidence eventually outweighs a threshold: two initials, a shared department
 * and a similar surname will cross any line you pick, and the line has to move
 * every time a signal is added.
 *
 * Here a link requires ONE signal that is strong BY KIND. Scores exist, but only
 * to order the candidates a human will see. No sum of supporting signals can
 * produce a link, which is a property of the type system rather than of a
 * constant:
 *
 *   - `StrongSignalKind` is a closed union of four members, defined here.
 *   - {@link CandidateScorer} — the extension point Step 4a plugs naming
 *     conventions and similarity into — returns `SupportingSignal`, whose
 *     `kind` cannot be a strong kind. A 4a scorer therefore CANNOT cause a
 *     false link, however it scores. It is not a convention; it will not
 *     compile.
 *
 * That matters because 4a is where the fuzzy matching lands, and fuzzy matching
 * is exactly what a precision gate is afraid of.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO I/O AND NO CLOCK
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `reconcile` is pure. It imports nothing that reaches Prisma (asserted by the
 * precision test), and it reads no clock — `now` is a parameter. Both are
 * testability, but the clock is also correctness: a reconciliation re-run over
 * the same snapshot must produce the same answer, and `Date.now()` inside a
 * matcher means the second run of an unchanged snapshot can disagree with the
 * first. "Was this link fresh?" is a question about the snapshot, so the caller
 * answers it and passes the answer in.
 *
 * @module lib/identity/reconcile/engine
 */

import {
    normaliseEmail,
    normaliseEmployeeNumber,
    normaliseName,
    normaliseUsername,
    baseClean,
} from './normalise';

// ─── Outcomes ──────────────────────────────────────────────────────────────

/**
 * The five terminal states. Identical to the corpus's `Outcome` on purpose:
 * `tests/fixtures/identity-reconcile/corpus.ts` is the acceptance oracle, and a
 * second spelling of the same five words is how the oracle and the engine come
 * to disagree about what they are measuring.
 */
export type Outcome = 'LINKED' | 'SUGGESTED' | 'AMBIGUOUS' | 'UNMATCHED' | 'NON_PERSON';

// ─── Signals ───────────────────────────────────────────────────────────────

/**
 * The only four signals that can produce a `LINKED`.
 *
 * Each is an IDENTIFIER match rather than a resemblance:
 *
 * - `CONFIRMED_ALIAS` — a human already said these are the same person.
 * - `EMPLOYEE_NUMBER` — the strongest field in the system, and the one Step 0c
 *   refuses to synthesise from an email for this reason.
 * - `EMAIL_EXACT` — `emailKey` equality, BYTE FOR BYTE. Not "the same mailbox"
 *   (see {@link SupportingSignalKind.EMAIL_UNTAGGED}); the same key the JML
 *   chain joins on, so a link made here is a link the leaver can act on.
 * - `DIRECTORY_BRIDGE` — the account's login matches a directory account the
 *   caller has already linked to an employee, freshly and uncontradicted.
 */
export type StrongSignalKind =
    | 'CONFIRMED_ALIAS'
    | 'EMPLOYEE_NUMBER'
    | 'EMAIL_EXACT'
    | 'DIRECTORY_BRIDGE';

/**
 * Everything else. These order the candidate list a reviewer sees and NEVER
 * produce a link.
 *
 * The first two are emitted by this step. The rest are declared here, unused,
 * because the exhaustive "no combination of supporting signals links" test
 * enumerates this union — so the guarantee is proven for Step 4a's signals
 * today, before 4a exists. A union member added later without a strength entry
 * fails to compile; one added with a strength entry is covered by that test the
 * moment it appears.
 *
 * - `EMAIL_UNTAGGED` — same mailbox after `+tag` removal or a domain alias.
 *   One layer above the key, deliberately: `normalise.ts` explains why domain
 *   equivalence must never reach `emailKey`.
 * - `STALE_DIRECTORY_LINK` — a directory link that exists but is not fresh. An
 *   expired link is how a departed account keeps looking covered, so it informs
 *   a suggestion and never a link.
 * - `NAME_EXACT`, `NAME_TRANSLIT`, `NAME_INITIAL`, `USERNAME_CONVENTION`,
 *   `SIMILARITY` — Step 4a.
 */
export type SupportingSignalKind =
    | 'EMAIL_UNTAGGED'
    | 'STALE_DIRECTORY_LINK'
    | 'NAME_EXACT'
    | 'NAME_TRANSLIT'
    | 'NAME_INITIAL'
    | 'USERNAME_CONVENTION'
    | 'SIMILARITY';

export type SignalKind = StrongSignalKind | SupportingSignalKind;

export type SignalStrength = 'STRONG' | 'SUPPORTING';

/**
 * Strength by kind, exhaustive over {@link SignalKind}.
 *
 * The one place strength is decided. A signal cannot describe itself as strong;
 * `strengthOf` reads this table, and the table is keyed by a closed union, so
 * adding a kind without classifying it is a compile error rather than a silent
 * `undefined` that `=== 'STRONG'` quietly reports as false.
 */
const SIGNAL_STRENGTH: Readonly<Record<SignalKind, SignalStrength>> = {
    CONFIRMED_ALIAS: 'STRONG',
    EMPLOYEE_NUMBER: 'STRONG',
    EMAIL_EXACT: 'STRONG',
    DIRECTORY_BRIDGE: 'STRONG',
    EMAIL_UNTAGGED: 'SUPPORTING',
    STALE_DIRECTORY_LINK: 'SUPPORTING',
    NAME_EXACT: 'SUPPORTING',
    NAME_TRANSLIT: 'SUPPORTING',
    NAME_INITIAL: 'SUPPORTING',
    USERNAME_CONVENTION: 'SUPPORTING',
    SIMILARITY: 'SUPPORTING',
};

export const ALL_SIGNAL_KINDS: readonly SignalKind[] = Object.keys(SIGNAL_STRENGTH) as SignalKind[];

export const STRONG_SIGNAL_KINDS: readonly StrongSignalKind[] = ALL_SIGNAL_KINDS.filter(
    (k): k is StrongSignalKind => SIGNAL_STRENGTH[k] === 'STRONG'
);

export const SUPPORTING_SIGNAL_KINDS: readonly SupportingSignalKind[] = ALL_SIGNAL_KINDS.filter(
    (k): k is SupportingSignalKind => SIGNAL_STRENGTH[k] === 'SUPPORTING'
);

export function strengthOf(kind: SignalKind): SignalStrength {
    return SIGNAL_STRENGTH[kind];
}

export interface Signal {
    readonly kind: SignalKind;
    /** Ordering weight only. Never compared against a link threshold. */
    readonly score: number;
    /** The matched value, for a reviewer reading why this was suggested. */
    readonly evidence: string;
}

/**
 * A signal a {@link CandidateScorer} may return.
 *
 * `kind` is narrowed to {@link SupportingSignalKind}, which is what makes
 * "Step 4a cannot introduce a false link" a type error rather than a review
 * note.
 */
export interface SupportingSignal extends Signal {
    readonly kind: SupportingSignalKind;
}

// ─── Vetoes ────────────────────────────────────────────────────────────────

/**
 * A veto beats every score.
 *
 * Not "subtracts a lot" — removes the candidate from linking entirely. Each one
 * is a statement that these two records are KNOWN to be different people, which
 * is strictly stronger than any amount of resemblance saying they might be the
 * same one.
 */
export type VetoKind =
    /** Both carry a real employee number and the numbers differ. */
    | 'EMPLOYEE_NUMBER_CONFLICT'
    /** Different local parts in the SAME mail domain — one org's namespace. */
    | 'EMAIL_DOMAIN_CONFLICT'
    /** The account was created after the candidate left. */
    | 'ACCOUNT_POSTDATES_END_DATE';

export interface Veto {
    readonly kind: VetoKind;
    readonly detail: string;
}

// ─── Inputs ────────────────────────────────────────────────────────────────

export interface CanonicalAccount {
    readonly accountKey: string;
    readonly displayName?: string | null;
    readonly email?: string | null;
    /**
     * Carried by some source systems directly. Step 0c persists it where it
     * exists; `null` where the source had none. Never derived from an email.
     */
    readonly employeeNumber?: string | null;
    readonly department?: string | null;
    readonly title?: string | null;
    /** ISO date. Compared against a candidate's `endDate`. */
    readonly createdAt?: string | null;
    readonly status?: string | null;
}

export interface RosterEmployee {
    readonly id: string;
    readonly givenName?: string | null;
    readonly familyName?: string | null;
    readonly fullName: string;
    readonly workEmail?: string | null;
    readonly employeeNumber?: string | null;
    readonly status: 'ACTIVE' | 'TERMINATED';
    readonly startDate?: string | null;
    readonly endDate?: string | null;
    readonly department?: string | null;
}

/**
 * One directory account, with the caller's verdict on its link already applied.
 *
 * `linkFresh` is the caller's answer, not ours — see the clock note in the
 * module docblock. `findLeaverCandidates` applies the same predicate, and the
 * two must agree or an account the leaver cannot disable looks covered.
 */
export interface DirectoryAccount {
    readonly connectionId: string;
    readonly email: string;
    readonly samAccountName?: string | null;
    readonly userPrincipalName?: string | null;
    readonly linkFresh: boolean;
    readonly linkedEmployeeId: string | null;
}

export interface ConfirmedAlias {
    readonly accountKey: string;
    readonly employeeId: string;
}

/**
 * Extension point for Step 4a.
 *
 * Called once per (account, candidate) pair that blocking produced — so a
 * scorer never sees the full cross product and cannot reintroduce the O(n²)
 * the blocking index exists to avoid. It may return any number of supporting
 * signals and, by its return type, no strong one.
 */
export type CandidateScorer = (
    account: CanonicalAccount,
    candidate: RosterEmployee,
    context: ScorerContext
) => readonly SupportingSignal[];

/**
 * Extension point for Step 4a's BLOCKING, as distinct from its scoring.
 *
 * A scorer answers "how well do these two match?"; a blocker answers "which
 * employees is this account even compared against?". Step 3b shipped only the
 * second half, and that made the first half unreachable for the case 4a exists to
 * serve: an account with a name and nothing else blocks to NOBODY under the
 * built-in keys (email, employee number, alias, directory bridge), so no scorer is
 * ever called for it and the outcome is `NO_CANDIDATES` whatever 4a scores.
 *
 * Measured rather than reasoned: a name-only account over a one-person roster
 * reported `comparisons=0, blockedAccounts=0, NO_CANDIDATES`.
 *
 * A blocker MUST be a keyed lookup, not a scan. It returns candidate ids for one
 * account, and the engine's comparison budget counts every id it returns — so a
 * blocker that returned the whole roster would blow the budget test rather than
 * quietly undoing the index it was added to extend.
 */
export type CandidateBlocker = (
    account: CanonicalAccount,
    context: ScorerContext
) => readonly string[];

export interface ScorerContext {
    /** `baseClean`ed and parsed forms of the account, computed once. */
    readonly accountName: ReturnType<typeof normaliseName>;
    readonly accountEmail: ReturnType<typeof normaliseEmail>;
    readonly accountUsername: ReturnType<typeof normaliseUsername>;
    readonly now: string;
}

export interface EngineConfig {
    /**
     * Whole login tokens that mark an account as non-human.
     *
     * Compared as TOKENS, never substrings: `bsvcic` contains `svc` and belongs
     * to a person called Bea Svcic. The corpus carries that case as the control
     * for the service-account rule, and a substring test fails it.
     */
    readonly serviceTokens?: readonly string[];
    /** Step 4a's scorers. Empty in Step 3b. */
    readonly scorers?: readonly CandidateScorer[];
    /**
     * Step 4a's blockers. Empty in Step 3b.
     *
     * Each returns candidate ids for an account; every id returned is compared and
     * counted, so the stated comparison budget still binds.
     */
    readonly blockers?: readonly CandidateBlocker[];
    /** How many candidates to carry on each resolution, highest first. */
    readonly maxCandidates?: number;
}

export interface EngineInput {
    readonly accounts: readonly CanonicalAccount[];
    readonly roster: readonly RosterEmployee[];
    readonly directory: readonly DirectoryAccount[];
    readonly aliases: readonly ConfirmedAlias[];
    /** ISO instant. The engine reads no clock; this is the only "when". */
    readonly now: string;
    readonly config?: EngineConfig;
}

// ─── Outputs ───────────────────────────────────────────────────────────────

export interface ScoredCandidate {
    readonly employeeId: string;
    readonly score: number;
    readonly signals: readonly Signal[];
    readonly vetoes: readonly Veto[];
    readonly strongest: SignalStrength | null;
}

/**
 * The method that DECIDED the outcome.
 *
 * A strong kind names the signal that linked; the rest name the rule that
 * refused to. `NO_CANDIDATES` and `NO_STRONG_SIGNAL` are both `UNMATCHED`, and
 * keeping them apart is how the reported recall says whether blocking found
 * nobody or found somebody it could not prove.
 */
export type ResolutionMethod =
    | StrongSignalKind
    | 'NON_PERSON_RULE'
    | 'REKEYED_PERSON_RULE'
    | 'STRONG_MATCH_ON_LEAVER'
    | 'SUPPORTING_ONLY'
    | 'STRONG_SIGNAL_TIE'
    | 'VETOED'
    | 'NO_STRONG_SIGNAL'
    | 'NO_CANDIDATES';

export interface Resolution {
    readonly accountKey: string;
    readonly outcome: Outcome;
    readonly employeeId: string | null;
    readonly method: ResolutionMethod;
    readonly signals: readonly Signal[];
    readonly candidates: readonly ScoredCandidate[];
    readonly vetoes: readonly Veto[];
    /**
     * Why a rule fired, where the rule has no candidate to attach a signal to.
     * `NON_PERSON` is the case: its evidence is a login token, not a match, and
     * a reviewer disputing the classification needs to see which token did it.
     */
    readonly note?: string;
}

export interface EngineMetrics {
    readonly accounts: number;
    readonly rosterSize: number;
    /**
     * (account, candidate) pairs evaluated. The blocking budget is asserted
     * against this, by COUNT — a time-based assertion measures the runner.
     */
    readonly comparisons: number;
    /** Accounts for which blocking produced at least one candidate. */
    readonly blockedAccounts: number;
    readonly byOutcome: Readonly<Record<Outcome, number>>;
}

export interface EngineResult {
    readonly resolutions: readonly Resolution[];
    readonly metrics: EngineMetrics;
}

// ─── Stated limits ─────────────────────────────────────────────────────────

/**
 * Comparisons may not exceed this multiple of `accounts + roster`.
 *
 * STATED, not inherited, for the reason `db/concurrency-limits.ts` gives about
 * its own numbers: an unstated ceiling moves with the data and nobody can tell
 * whether a slow run is in contract. Bounding against `accounts + roster` —
 * something the input HAS — rather than a flat constant means the budget cannot
 * be satisfied by a small input or blown by a large legitimate one.
 *
 * Blocking makes the real figure proportional to collisions per key, so a
 * roster of distinct people sits far below this. It is a ceiling on
 * degeneration, not a target.
 */
export const COMPARISON_BUDGET_MULTIPLE = 8;

export const DEFAULT_MAX_CANDIDATES = 5;

/**
 * Default non-human login tokens.
 *
 * Deliberately short. Every entry here is a word that is not a name in any
 * locale this product ships to; a token that could be somebody's name belongs
 * in a tenant's own configuration, not in a default that silently excludes
 * them from their own recertification.
 */
export const DEFAULT_SERVICE_TOKENS: readonly string[] = [
    'svc',
    'service',
    'srv',
    // Named by the design document alongside `svc_backup` and `batch_user` as an
    // account that must not bury real leavers in the orphan list. Kept despite
    // being the one entry that reads like it could be a name, because it is not
    // a surname in any locale this ships to — and because the design says so.
    'admin',
    'batch',
    'cron',
    'daemon',
    'system',
    'sys',
    'noreply',
    'donotreply',
    'bot',
    'robot',
    'scheduler',
    'integration',
    'automation',
];

const SCORE: Readonly<Record<SignalKind, number>> = {
    CONFIRMED_ALIAS: 1000,
    EMPLOYEE_NUMBER: 900,
    EMAIL_EXACT: 800,
    DIRECTORY_BRIDGE: 700,
    EMAIL_UNTAGGED: 300,
    STALE_DIRECTORY_LINK: 250,
    NAME_EXACT: 200,
    NAME_TRANSLIT: 150,
    NAME_INITIAL: 50,
    USERNAME_CONVENTION: 40,
    SIMILARITY: 30,
};

// ─── Date handling, clock-free ─────────────────────────────────────────────

/**
 * The `YYYY-MM-DD` prefix of an ISO date, or null.
 *
 * Compared as STRINGS. ISO dates sort lexicographically, which sidesteps the
 * timezone question entirely: `Date.parse` on a bare `2024-03-01` is UTC
 * midnight while on `2024-03-01T00:00:00` it is local, so two fields written by
 * different producers could order differently depending on where the engine
 * runs. A pure function must not depend on `TZ`.
 */
function dayOf(raw: string | null | undefined): string | null {
    const s = baseClean(raw);
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
    return m ? m[1] : null;
}

// ─── Blocking ──────────────────────────────────────────────────────────────

interface RosterIndex {
    readonly byEmployeeNumber: Map<string, string[]>;
    readonly byEmailKey: Map<string, string[]>;
    readonly byEmailUntagged: Map<string, string[]>;
    readonly byId: Map<string, RosterEmployee>;
    /** Insertion-independent: ids within a bucket are sorted. */
    readonly order: readonly string[];
}

function pushKey(m: Map<string, string[]>, key: string | null, id: string): void {
    if (!key) return;
    const at = m.get(key);
    if (at) at.push(id);
    else m.set(key, [id]);
}

/**
 * Thrown when one roster id carries two different records.
 *
 * `RosterEmployee.id` is a primary key. Two different records under one key
 * means the snapshot is inconsistent, and `byId.set` would silently keep
 * whichever arrived last — so the outcome would depend on roster order, which
 * is the one thing the engine promises it never does.
 *
 * It refuses the whole run rather than that row, deliberately: a roster that
 * contradicts itself about one person gives no reason to trust what it says
 * about the others, and a reconciliation that is wrong about who someone is
 * grants access. Found by the order-independence test, which built a roster by
 * concatenating the corpus's per-case slices and got two outcomes depending on
 * the shuffle.
 */
export class DuplicateRosterIdError extends Error {
    constructor(readonly duplicateIds: readonly string[]) {
        super(
            `roster contains ${duplicateIds.length} id(s) with conflicting records: ` +
                `${duplicateIds.join(', ')}. RosterEmployee.id is a primary key; two ` +
                `different records under one id make the result depend on input order.`
        );
        this.name = 'DuplicateRosterIdError';
    }
}

function buildRosterIndex(roster: readonly RosterEmployee[]): RosterIndex {
    const byEmployeeNumber = new Map<string, string[]>();
    const byEmailKey = new Map<string, string[]>();
    const byEmailUntagged = new Map<string, string[]>();
    const byId = new Map<string, RosterEmployee>();

    // An exactly-repeated row is harmless and is tolerated; a CONTRADICTING one
    // is not. Comparing serialised content keeps the check cheap and makes the
    // distinction the one that matters.
    const seen = new Map<string, string>();
    const conflicting = new Set<string>();

    for (const e of roster) {
        const shape = JSON.stringify([
            e.id,
            e.fullName,
            e.givenName ?? null,
            e.familyName ?? null,
            e.workEmail ?? null,
            e.employeeNumber ?? null,
            e.status,
            e.startDate ?? null,
            e.endDate ?? null,
            e.department ?? null,
        ]);
        const prior = seen.get(e.id);
        if (prior !== undefined && prior !== shape) conflicting.add(e.id);
        if (prior !== undefined) continue;
        seen.set(e.id, shape);

        byId.set(e.id, e);
        pushKey(byEmployeeNumber, normaliseEmployeeNumber(e.employeeNumber), e.id);
        const em = normaliseEmail(e.workEmail);
        pushKey(byEmailKey, em.key, e.id);
        pushKey(byEmailUntagged, em.untagged, e.id);
    }

    if (conflicting.size > 0) throw new DuplicateRosterIdError([...conflicting].sort());

    // Order-independence: a shuffled roster must produce byte-identical output,
    // so every bucket is sorted rather than left in arrival order.
    for (const m of [byEmployeeNumber, byEmailKey, byEmailUntagged]) {
        for (const [k, v] of m) m.set(k, [...v].sort());
    }

    return {
        byEmployeeNumber,
        byEmailKey,
        byEmailUntagged,
        byId,
        order: [...byId.keys()].sort(),
    };
}

/**
 * The directory bridge index, keyed by login.
 *
 * Keyed on both `samAccountName` and the UPN's local part, because a legacy
 * login spells itself as whichever the source system used.
 *
 * A key present in more than one CONNECTION is dropped rather than resolved:
 * two accounts called `jjones` in different domains are two people until
 * someone says otherwise. Dropping the key is what makes that an absence of
 * evidence instead of a coin toss.
 */
interface BridgeEntry {
    readonly employeeIds: readonly string[];
    readonly connectionIds: readonly string[];
    readonly fresh: boolean;
}

function buildBridgeIndex(directory: readonly DirectoryAccount[]): Map<string, BridgeEntry> {
    const raw = new Map<string, { ids: Set<string>; conns: Set<string>; fresh: Set<boolean> }>();

    const add = (login: string | null | undefined, d: DirectoryAccount): void => {
        if (!d.linkedEmployeeId) return;
        const key = baseClean(login).toLowerCase();
        if (!key) return;
        const slot = raw.get(key) ?? { ids: new Set(), conns: new Set(), fresh: new Set() };
        slot.ids.add(d.linkedEmployeeId);
        slot.conns.add(d.connectionId);
        slot.fresh.add(d.linkFresh);
        raw.set(key, slot);
    };

    for (const d of directory) {
        add(d.samAccountName, d);
        const upn = normaliseEmail(d.userPrincipalName);
        if (upn.localPart) add(upn.localPart, d);
    }

    const out = new Map<string, BridgeEntry>();
    for (const [k, v] of raw) {
        out.set(k, {
            employeeIds: [...v.ids].sort(),
            connectionIds: [...v.conns].sort(),
            // A key is fresh only if EVERY link spelling it is fresh. One stale
            // spelling is a contradiction, and the step's rule is that the
            // bridge takes only fresh, uncontradicted links.
            fresh: v.fresh.size === 1 && v.fresh.has(true),
        });
    }
    return out;
}

// ─── NON_PERSON ────────────────────────────────────────────────────────────

/**
 * Classify a non-human account, BEFORE any matching.
 *
 * Order is the point. A service account that goes through matching first lands
 * in the orphan list, and the orphan list is what a reviewer reads to find
 * leavers who still have access — so burying real leavers under `svc_*` rows is
 * how a recertification campaign misses the thing it exists to catch.
 *
 * Two independent signals, and it takes BOTH a non-human login and the absence
 * of a human name:
 *
 *   - a whole login token in `serviceTokens`;
 *   - no display name, or a display name that is itself service-shaped.
 *
 * Requiring both is what keeps `bsvcic` / "Bea Svcic" a person. A login-only
 * rule would classify her as a robot and quietly drop her from her own review.
 */
function classifyNonPerson(
    account: CanonicalAccount,
    serviceTokens: ReadonlySet<string>
): string | null {
    const login = normaliseUsername(account.accountKey);
    const loginTokens = login.tokens.map((t) => t.toLowerCase());
    const hit = loginTokens.find((t) => serviceTokens.has(t));
    if (!hit) return null;

    const display = baseClean(account.displayName);
    if (display) {
        const nameTokens = display
            .toLowerCase()
            .split(/[^\p{L}\p{N}]+/u)
            .filter(Boolean);
        const nameIsServiceShaped = nameTokens.some((t) => serviceTokens.has(t));
        if (!nameIsServiceShaped) return null;
    }

    // The matched token, which is the whole evidence for the classification.
    return hit;
}

// ─── Vetoes ────────────────────────────────────────────────────────────────

function vetoesFor(
    account: CanonicalAccount,
    candidate: RosterEmployee,
    accountEmail: ReturnType<typeof normaliseEmail>,
    accountEmployeeNumber: string | null
): Veto[] {
    const out: Veto[] = [];

    const candNumber = normaliseEmployeeNumber(candidate.employeeNumber);
    if (accountEmployeeNumber && candNumber && accountEmployeeNumber !== candNumber) {
        out.push({
            kind: 'EMPLOYEE_NUMBER_CONFLICT',
            detail: `${accountEmployeeNumber} != ${candNumber}`,
        });
    }

    const candEmail = normaliseEmail(candidate.workEmail);
    if (
        accountEmail.domain &&
        candEmail.domain &&
        accountEmail.domain === candEmail.domain &&
        accountEmail.localPart &&
        candEmail.localPart &&
        accountEmail.localPart !== candEmail.localPart
    ) {
        // Same domain is one organisation's namespace, where two local parts
        // are two mailboxes and therefore two people. Across DIFFERENT domains
        // the same reasoning does not hold — a personal address and a work
        // address routinely differ — so this veto is deliberately domain-local.
        out.push({
            kind: 'EMAIL_DOMAIN_CONFLICT',
            detail: `${accountEmail.untagged} != ${candEmail.untagged}`,
        });
    }

    const created = dayOf(account.createdAt);
    const ended = dayOf(candidate.endDate);
    if (created && ended && created > ended) {
        out.push({
            kind: 'ACCOUNT_POSTDATES_END_DATE',
            detail: `created ${created} > ended ${ended}`,
        });
    }

    return out;
}

// ─── The re-keyed person rule ──────────────────────────────────────────────

/**
 * Find the ACTIVE record that re-keyed a terminated one.
 *
 * HR systems re-key people: same human, new row, new id, often a new address.
 * The strong signal — an old email, an old number — points at the TERMINATED
 * row, and linking there is wrong in the worst direction: it attaches a live
 * account to a record the leaver process has already finished with, so the
 * account looks handled and never gets disabled.
 *
 * So a strong signal landing on a terminated record yields `SUGGESTED` at the
 * successor, never `LINKED`. Identity here is the normalised name plus a
 * timeline that does not overlap; that is good enough to SUGGEST, which is all
 * this rule is allowed to do.
 */
function rekeyedSuccessor(
    terminated: RosterEmployee,
    index: RosterIndex
): RosterEmployee | null {
    const endedAt = dayOf(terminated.endDate);
    const key = nameKey(terminated);
    if (!key) return null;

    const matches: RosterEmployee[] = [];
    for (const id of index.order) {
        const e = index.byId.get(id);
        if (!e || e.id === terminated.id || e.status !== 'ACTIVE') continue;
        if (nameKey(e) !== key) continue;
        const started = dayOf(e.startDate);
        // The successor must start at or after the predecessor left. Without
        // this, two concurrent namesakes read as one re-keyed person.
        if (endedAt && started && started < endedAt) continue;
        matches.push(e);
    }

    // Exactly one, or it is not a re-key — it is two people with one name.
    return matches.length === 1 ? matches[0] : null;
}

/**
 * A re-key lookup over one roster, built once.
 *
 * Exported for Step 4b's alias revalidation, which has to answer exactly the
 * question {@link rekeyedSuccessor} already answers — "is this terminated record
 * a re-key, or did this person simply leave?" — and must answer it the SAME way.
 *
 * That distinction is the whole of the revalidation rule: a re-keyed record makes
 * an alias doubtful and suspends it; a departure must NOT, because suspending
 * there would take the account out of the leaver population and hide it. Two
 * independent definitions of "re-keyed" would eventually disagree, and the
 * direction they disagree in grants access.
 *
 * A factory rather than a bare function because the index costs O(roster) to
 * build and revalidation calls this once per alias. Returning a closure keeps
 * that cost paid once, the same way {@link makeConventionBlocker} does.
 */
export function makeRekeyLookup(
    roster: readonly RosterEmployee[]
): (terminated: RosterEmployee) => RosterEmployee | null {
    const index = buildRosterIndex(roster);
    const memo = new Map<string, RosterEmployee | null>();
    return (terminated) => {
        const hit = memo.get(terminated.id);
        if (hit !== undefined) return hit;
        const found = rekeyedSuccessor(terminated, index);
        memo.set(terminated.id, found);
        return found;
    };
}

/**
 * The engine's date normalisation, exported so revalidation compares dates the
 * same way the vetoes do.
 *
 * Deliberately not re-implemented at the call site: `ACCOUNT_POSTDATES_END_DATE`
 * and revalidation's employment-window check are the same comparison asked at
 * two moments, and a second date parser is how they come to disagree about a
 * timestamp with an offset.
 */
export function isoDay(raw: string | null | undefined): string | null {
    return dayOf(raw);
}

function nameKey(e: RosterEmployee): string | null {
    const n = normaliseName(e.fullName);
    const given = (e.givenName ? baseClean(e.givenName) : n.given) ?? '';
    const family = (e.familyName ? baseClean(e.familyName) : n.family) ?? '';
    const key = `${given}|${family}`.toLowerCase();
    return key === '|' ? null : key;
}

// ─── The engine ────────────────────────────────────────────────────────────

/**
 * Resolve every account to exactly one outcome.
 *
 * Exactly one per account, in input order, whatever the inputs look like:
 * callers index the result against their own list, and a silently dropped
 * account is an account nobody reviews.
 */
export function reconcile(input: EngineInput): EngineResult {
    const config = input.config ?? {};
    const serviceTokens = new Set(
        (config.serviceTokens ?? DEFAULT_SERVICE_TOKENS).map((t) => t.toLowerCase())
    );
    const scorers = config.scorers ?? [];
    const blockers = config.blockers ?? [];
    const maxCandidates = config.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

    const index = buildRosterIndex(input.roster);
    const bridge = buildBridgeIndex(input.directory);

    const aliasByAccount = new Map<string, string[]>();
    for (const a of input.aliases) {
        const k = baseClean(a.accountKey).toLowerCase();
        const at = aliasByAccount.get(k);
        if (at) at.push(a.employeeId);
        else aliasByAccount.set(k, [a.employeeId]);
    }
    for (const [k, v] of aliasByAccount) aliasByAccount.set(k, [...v].sort());

    let comparisons = 0;
    let blockedAccounts = 0;
    const byOutcome: Record<Outcome, number> = {
        LINKED: 0,
        SUGGESTED: 0,
        AMBIGUOUS: 0,
        UNMATCHED: 0,
        NON_PERSON: 0,
    };

    const resolutions: Resolution[] = [];

    for (const account of input.accounts) {
        const nonPersonToken = classifyNonPerson(account, serviceTokens);
        if (nonPersonToken) {
            byOutcome.NON_PERSON += 1;
            resolutions.push({
                accountKey: account.accountKey,
                outcome: 'NON_PERSON',
                employeeId: null,
                method: 'NON_PERSON_RULE',
                signals: [],
                candidates: [],
                vetoes: [],
                note: `service token: ${nonPersonToken}`,
            });
            continue;
        }

        const accountEmail = normaliseEmail(account.email);
        const accountUsername = normaliseUsername(account.accountKey);
        const accountName = normaliseName(account.displayName);
        const loginKey = baseClean(account.accountKey).toLowerCase();

        // An account's own employee number comes from a real field, or from a
        // login that IS one. `normaliseEmployeeNumber` accepts up to eight
        // leading letters, so `kpatel3` would yield `3` — a name with a counter
        // posing as the strongest signal in the system. An all-digits login is
        // an identifier; anything else is a name, which is the same distinction
        // `normaliseUsername` draws when it refuses to split a stem with no
        // non-digit.
        const digitsOnlyLogin = /^\d+$/.test(baseClean(account.accountKey));
        const accountEmployeeNumber =
            normaliseEmployeeNumber(account.employeeNumber) ??
            (digitsOnlyLogin ? normaliseEmployeeNumber(account.accountKey) : null);

        // ── Blocking: candidate ids come only from shared keys ──────────────
        const candidateIds = new Set<string>();
        const addAll = (ids: readonly string[] | undefined): void => {
            if (!ids) return;
            for (const id of ids) candidateIds.add(id);
        };

        addAll(aliasByAccount.get(loginKey));
        if (accountEmployeeNumber) addAll(index.byEmployeeNumber.get(accountEmployeeNumber));
        if (accountEmail.key) addAll(index.byEmailKey.get(accountEmail.key));
        if (accountEmail.untagged) addAll(index.byEmailUntagged.get(accountEmail.untagged));
        const bridgeEntry = bridge.get(loginKey);
        if (bridgeEntry) addAll(bridgeEntry.employeeIds);

        const context: ScorerContext = { accountName, accountEmail, accountUsername, now: input.now };

        // Step 4a's blockers, after the built-in keys. They can only ADD
        // candidates, never remove one: a strong signal must not become
        // unreachable because an extension did not recognise the account.
        for (const blocker of blockers) {
            for (const id of blocker(account, context)) {
                if (index.byId.has(id)) candidateIds.add(id);
            }
        }

        if (candidateIds.size > 0) blockedAccounts += 1;

        const scored: ScoredCandidate[] = [];
        // Sorted ids, so the evaluation order does not depend on which key
        // happened to contribute a candidate first.
        for (const id of [...candidateIds].sort()) {
            const candidate = index.byId.get(id);
            if (!candidate) continue;
            comparisons += 1;

            const signals: Signal[] = [];

            const aliasIds = aliasByAccount.get(loginKey);
            if (aliasIds?.includes(id)) {
                signals.push({
                    kind: 'CONFIRMED_ALIAS',
                    score: SCORE.CONFIRMED_ALIAS,
                    evidence: account.accountKey,
                });
            }

            const candNumber = normaliseEmployeeNumber(candidate.employeeNumber);
            if (accountEmployeeNumber && candNumber && accountEmployeeNumber === candNumber) {
                signals.push({
                    kind: 'EMPLOYEE_NUMBER',
                    score: SCORE.EMPLOYEE_NUMBER,
                    evidence: candNumber,
                });
            }

            const candEmail = normaliseEmail(candidate.workEmail);
            if (accountEmail.key && candEmail.key && accountEmail.key === candEmail.key) {
                signals.push({
                    kind: 'EMAIL_EXACT',
                    score: SCORE.EMAIL_EXACT,
                    evidence: accountEmail.key,
                });
            } else if (
                accountEmail.untagged &&
                candEmail.untagged &&
                accountEmail.untagged === candEmail.untagged
            ) {
                // Same mailbox, different key. A suggestion, never a link —
                // the key is what the JML chain joins on.
                signals.push({
                    kind: 'EMAIL_UNTAGGED',
                    score: SCORE.EMAIL_UNTAGGED,
                    evidence: accountEmail.untagged,
                });
            }

            if (bridgeEntry?.employeeIds.includes(id)) {
                const single =
                    bridgeEntry.connectionIds.length === 1 && bridgeEntry.employeeIds.length === 1;
                if (bridgeEntry.fresh && single) {
                    signals.push({
                        kind: 'DIRECTORY_BRIDGE',
                        score: SCORE.DIRECTORY_BRIDGE,
                        evidence: `${bridgeEntry.connectionIds[0]}:${loginKey}`,
                    });
                } else {
                    signals.push({
                        kind: 'STALE_DIRECTORY_LINK',
                        score: SCORE.STALE_DIRECTORY_LINK,
                        evidence: `${bridgeEntry.connectionIds.join(',')}:${loginKey}`,
                    });
                }
            }

            for (const scorer of scorers) {
                for (const s of scorer(account, candidate, context)) signals.push(s);
            }

            const vetoes = vetoesFor(account, candidate, accountEmail, accountEmployeeNumber);

            const strongest = signals.length
                ? signals.some((s) => strengthOf(s.kind) === 'STRONG')
                    ? ('STRONG' as const)
                    : ('SUPPORTING' as const)
                : null;

            scored.push({
                employeeId: id,
                score: signals.reduce((a, s) => a + s.score, 0),
                signals: [...signals].sort(
                    (a, b) => b.score - a.score || a.kind.localeCompare(b.kind)
                ),
                vetoes,
                strongest,
            });
        }

        // Total order: score, then id. A strict `>` tie-break would leave two
        // equal candidates in arrival order, which is exactly the dependence on
        // input order the determinism test exists to catch.
        scored.sort((a, b) => b.score - a.score || a.employeeId.localeCompare(b.employeeId));

        const resolution = decide(account, scored, index, maxCandidates);
        byOutcome[resolution.outcome] += 1;
        resolutions.push(resolution);
    }

    return {
        resolutions,
        metrics: {
            accounts: input.accounts.length,
            rosterSize: input.roster.length,
            comparisons,
            blockedAccounts,
            byOutcome,
        },
    };
}

/**
 * Turn scored candidates into one outcome.
 *
 * Every branch here is a refusal except the first. `LINKED` requires a strong
 * signal, held by exactly one candidate, with no veto on it and a timeline that
 * holds — and then one more refusal on top, for the re-keyed case.
 */
function decide(
    account: CanonicalAccount,
    scored: readonly ScoredCandidate[],
    index: RosterIndex,
    maxCandidates: number
): Resolution {
    const candidates = scored.slice(0, maxCandidates);
    const base = {
        accountKey: account.accountKey,
        candidates,
        vetoes: scored.flatMap((c) => c.vetoes),
    };

    if (scored.length === 0) {
        return {
            ...base,
            outcome: 'UNMATCHED',
            employeeId: null,
            method: 'NO_CANDIDATES',
            signals: [],
        };
    }

    const unvetoedStrong = scored.filter(
        (c) => c.vetoes.length === 0 && c.signals.some((s) => strengthOf(s.kind) === 'STRONG')
    );

    if (unvetoedStrong.length === 1) {
        const winner = unvetoedStrong[0];
        const employee = index.byId.get(winner.employeeId);
        const strongSignal = winner.signals.find((s) => strengthOf(s.kind) === 'STRONG');

        if (employee && employee.status === 'TERMINATED') {
            // The one place a strong, unvetoed, unique signal still does not
            // link. See `rekeyedSuccessor`.
            const successor = rekeyedSuccessor(employee, index);

            // ...with one exception: a CONFIRMED_ALIAS on a record that was not
            // re-keyed.
            //
            // `rekeyedSuccessor`'s rationale is about INFERRED signals — "an old
            // email, an old number" pointing at a row the leaver process has
            // finished with. An alias is not an inference. A person looked at
            // this account and said it belongs to that human, and if that human
            // has since left with no successor then the terminated row is the
            // CORRECT answer, not a stale one.
            //
            // Downgrading it is the failure the alias exists to prevent. A
            // `LINKED` is acted on by later steps without anybody looking; a
            // `SUGGESTED` waits in a queue. So the departed employee's account
            // would stop being reported as a leaver with access at the moment
            // they departed — the one moment it matters. See
            // `lib/identity/reconcile/alias-revalidation`, whose whole subject
            // is this distinction, and which found this by asserting the
            // end-to-end claim rather than its own return value.
            //
            // A re-keyed record still downgrades, alias or not: there the person
            // IS still here under a new row, so the alias is genuinely doubtful.
            // Revalidation suspends that case before the engine sees it; this
            // branch is what keeps the engine right when called without it.
            const viaAlias = winner.signals.some((s) => s.kind === 'CONFIRMED_ALIAS');
            if (!(viaAlias && !successor)) {
                return {
                    ...base,
                    outcome: 'SUGGESTED',
                    employeeId: successor ? successor.id : winner.employeeId,
                    // ONE METHOD WAS DOING DUTY FOR TWO SITUATIONS.
                    // `rekeyedSuccessor` returns null when the departed record
                    // has no namesake, when a namesake's tenure OVERLAPS (two
                    // people, not a re-key) and when there are two namesakes
                    // (ambiguous, so not a re-key either). Reporting
                    // `REKEYED_PERSON_RULE` there told a reviewer to go and find
                    // a successor row that does not exist, and made the method
                    // useless as a metric dimension - "how many accounts are
                    // blocked on a re-key" counted every strong match on anyone
                    // who had left.
                    //
                    // The OUTCOME is unchanged in both cases: a strong inferred
                    // signal on a terminated record does not link, successor or
                    // not. Only the label is split.
                    method: successor ? 'REKEYED_PERSON_RULE' : 'STRONG_MATCH_ON_LEAVER',
                    signals: winner.signals,
                };
            }
        }

        return {
            ...base,
            outcome: 'LINKED',
            employeeId: winner.employeeId,
            method: (strongSignal?.kind ?? 'NO_STRONG_SIGNAL') as ResolutionMethod,
            signals: winner.signals,
        };
    }

    if (unvetoedStrong.length > 1) {
        // Two candidates both proving a strong signal is a contradiction in the
        // DATA, not a close call. Picking the higher score here is how one
        // person gets another's access, so the engine refuses.
        return {
            ...base,
            outcome: 'AMBIGUOUS',
            employeeId: null,
            method: 'STRONG_SIGNAL_TIE',
            signals: unvetoedStrong.flatMap((c) => c.signals),
        };
    }

    const vetoedStrong = scored.filter(
        (c) => c.vetoes.length > 0 && c.signals.some((s) => strengthOf(s.kind) === 'STRONG')
    );
    if (vetoedStrong.length > 0) {
        return {
            ...base,
            outcome: 'SUGGESTED',
            employeeId: null,
            method: 'VETOED',
            signals: vetoedStrong.flatMap((c) => c.signals),
        };
    }

    const supporting = scored.filter((c) => c.signals.length > 0 && c.vetoes.length === 0);
    if (supporting.length === 1) {
        return {
            ...base,
            outcome: 'SUGGESTED',
            employeeId: supporting[0].employeeId,
            method: 'SUPPORTING_ONLY',
            signals: supporting[0].signals,
        };
    }
    if (supporting.length > 1) {
        const [first, second] = supporting;
        // A tie on supporting evidence is AMBIGUOUS; a clear leader is a
        // suggestion with the rest carried for the reviewer to see.
        if (first.score === second.score) {
            return {
                ...base,
                outcome: 'AMBIGUOUS',
                employeeId: null,
                method: 'SUPPORTING_ONLY',
                signals: [],
            };
        }
        return {
            ...base,
            outcome: 'SUGGESTED',
            employeeId: first.employeeId,
            method: 'SUPPORTING_ONLY',
            signals: first.signals,
        };
    }

    return {
        ...base,
        outcome: 'UNMATCHED',
        employeeId: null,
        method: 'NO_STRONG_SIGNAL',
        signals: [],
    };
}
