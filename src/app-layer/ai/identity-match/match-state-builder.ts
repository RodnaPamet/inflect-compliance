/**
 * The adjudication payload - what leaves Inflect, and what cannot.
 *
 * ===========================================================================
 * AN ALLOWLIST, AND THE TYPE IS THE ALLOWLIST
 * ===========================================================================
 *
 * `MatchStateAccount` and `MatchStateCandidate` (`systemone-wire.ts`) name every
 * field that may be sent. This module maps a `CanonicalAccount` - which carries
 * the employee number, the dates, the employment status, the manager reference,
 * the entitlements and the privilege flag - down onto those types. The forbidden
 * columns are not redacted here; there is nowhere for them to go.
 *
 * It takes the WIDE type on purpose. Accepting a pre-narrowed input would move
 * the narrowing to an un-tested mapping step at the call site, which is exactly
 * where a new snapshot column would leak. The test seeds a sentinel into every
 * forbidden field of a real `CanonicalAccount` and asserts none of them appears
 * in the serialised state, and it pins the KEY SET of both halves so a new
 * allowlisted field is a deliberate act with a failing test attached.
 *
 * ===========================================================================
 * WHY THIS MODULE LIVES HERE
 * ===========================================================================
 *
 * `src/app-layer/ai/identity-match/` is in `AGENTIC_PATH_GLOBS_LIVE`
 * (`eslint-rules/agentic-path.js`), so `local/no-raw-prompt-logging` is scoped
 * over it. `src/lib/legacy-access/` - where the rest of this step's pure logic
 * sits - is not. Putting the module that handles the most attacker-shaped text
 * in the subsystem OUTSIDE the scope that exists for attacker-shaped text would
 * have been the wrong half of that trade.
 *
 * ===========================================================================
 * NFKC BEFORE NEUTRALISATION, AND THAT ORDER IS A SECURITY PROPERTY
 * ===========================================================================
 *
 * Every free-text value goes through `baseClean` (NFKC, invisible characters
 * stripped, whitespace collapsed) and THEN `neutralizeUntrustedText`.
 *
 * Reversing the two is a bypass. NFKC *creates* reserved tokens: the fullwidth
 * forms U+FF1C U+FF5C ... U+FF5C U+FF1E normalise to a real ChatML sentinel, so
 * a value written in fullwidth passes a neutraliser that runs first and emerges
 * as that sentinel afterwards. There is a test with that exact payload.
 *
 * What the neutraliser is worth here is less than it is worth in a prose
 * template, and saying so is more useful than implying otherwise: these are
 * System One models, the state is JSON, and there is no turn boundary in a JSON
 * string value for a forged role marker to terminate. It is defence in depth.
 * The protections that carry the weight are that the models emit no free text,
 * that the response schema re-checks the option it is given, and that a guard
 * verdict quarantines the account before a call is made.
 *
 * ===========================================================================
 * THE ORDER OF OPERATIONS IS LOAD-BEARING
 * ===========================================================================
 *
 *   rank by the engine's score  ->  cap at five  ->  trim for the budget
 *   ->  shuffle  ->  label A-E
 *
 * **Trim before shuffle.** The cap drops the *weakest* candidates, so the
 * engine's own suggestion survives every trim - trimming the tail of a shuffled
 * list would drop a candidate at random, and dropping the engine's suggestion
 * makes `AGREES` unreachable for reasons no verdict could express.
 *
 * **Shuffle after trim.** The letters must carry no ranking information. The
 * seed is a SHA-256 of the account key and the employee id, so the permutation
 * is deterministic, independent of input order, and *different per account* - a
 * seed without the account key would give every employee a stable position
 * across the whole run, which is a positional prior by another name.
 *
 * @module app-layer/ai/identity-match/match-state-builder
 */

import { createHash } from 'node:crypto';

import { neutralizeUntrustedText } from '@/app-layer/ai/risk-assessment/prompt-builder';
import type { CanonicalAccount } from '@/lib/legacy-access/canonical';
import {
    baseClean,
    normaliseEmail,
    normaliseName,
    normaliseUsername,
    type Variant,
} from '@/lib/identity/reconcile/normalise';

import {
    MATCH_OPTIONS,
    STATE_BUDGET_CHARS,
    type MatchOption,
    type MatchState,
    type MatchStateCandidate,
} from './systemone-wire';

/**
 * The separator for hash and dedup keys.
 *
 * A NUL, because it cannot occur in an account key, an employee id or a
 * transliteration scheme name - so no pair of distinct inputs can produce the
 * same joined string, which is the only property a separator owes a hash.
 */
const SEP = '\u0000';

// --- Bounds ---------------------------------------------------------------

/** The option set holds five candidates plus `NONE`. */
export const MAX_CANDIDATES = MATCH_OPTIONS.length - 1;

/**
 * The floor the budget trim will not go below.
 *
 * A single candidate plus `NONE` is a question with one real answer, and a
 * `choice` over one option answers it by arithmetic rather than by judgement.
 * Two is the smallest set where picking one is a discrimination.
 */
export const MIN_CANDIDATES_UNDER_BUDGET = 2;

/**
 * The cap on the account's flattened variant list.
 *
 * The budget trim can only drop CANDIDATES. A long Cyrillic display name can
 * produce variants on the account side that no amount of candidate-dropping
 * reaches, so without a bound here the only possible outcome for such an
 * account is `OVER_BUDGET`. Dropping a variant costs recall and can never
 * create a link, which is the fail-safe direction.
 */
export const MAX_ACCOUNT_VARIANTS = 24;

/** The same bound per candidate, for the same reason. */
export const MAX_CANDIDATE_VARIANTS = 12;

/** The labels, in order, without `NONE`. */
const CANDIDATE_LABELS: readonly MatchOption[] = MATCH_OPTIONS.filter((o) => o !== 'NONE');

// --- Inputs ---------------------------------------------------------------

/**
 * One candidate, as this module needs it.
 *
 * Wider than `RosterEmployee`, which carries no middle name, preferred name or
 * job title - the design's candidate allowlist names all three, so the roster
 * read that feeds adjudication has to select them. It is deliberately NOT the
 * Prisma `Employee` row: that carries the employee number, the dates and the
 * manager, none of which may be sent.
 *
 * `score` is the engine's, and it exists here for exactly one purpose: to order
 * the budget trim. It is never serialised - `buildMatchState` reads it and the
 * payload has no field it could occupy.
 */
export interface AdjudicationCandidate {
    readonly employeeId: string;
    readonly fullName: string;
    readonly givenName: string | null;
    readonly middleName: string | null;
    readonly familyName: string | null;
    readonly preferredName: string | null;
    readonly department: string | null;
    readonly jobTitle: string | null;
    readonly score: number;
}

export interface MatchStateInput {
    readonly account: CanonicalAccount;
    readonly candidates: readonly AdjudicationCandidate[];
    /** Characters, not tokens. See {@link budgetForModel}. */
    readonly budgetChars: number;
}

// --- Outputs --------------------------------------------------------------

/** The letter-to-employee mapping. Server-side only; never part of the state. */
export interface LabelAssignment {
    readonly label: MatchOption;
    readonly employeeId: string;
}

export interface MatchStateBuilt {
    readonly ok: true;
    readonly state: MatchState;
    readonly labelling: readonly LabelAssignment[];
    /** Candidates beyond the five the option set holds. */
    readonly droppedForRank: number;
    /** Candidates the budget removed, after the rank cap. */
    readonly droppedForBudget: number;
    readonly stateChars: number;
}

/**
 * Why no payload was built.
 *
 * Both reasons are `NonVerdictReason`s in `lib/legacy-access/verdict.ts`, so a
 * refusal here is recorded as a reason on the row rather than as an absence.
 *
 * `OVER_BUDGET` is a refusal and not a truncation on purpose: a state cut to
 * fit is a state with candidates the model never saw, and a candidate the model
 * never saw reads downstream as a candidate it rejected.
 */
export interface MatchStateRefused {
    readonly ok: false;
    /**
     * `OVER_BUDGET` is now the only way to refuse.
     *
     * `NO_CANDIDATES` was removed with the orphan change rather than left as an
     * unreachable member: a union that names an outcome nothing produces sends
     * the next reader looking for the branch that produces it.
     */
    readonly reason: 'OVER_BUDGET';
    /** The size of the smallest state that could be built, when measured. */
    readonly stateChars: number | null;
}

export type MatchStateBuildResult = MatchStateBuilt | MatchStateRefused;

// --- Budget ---------------------------------------------------------------

/**
 * The character budget for a model, failing safe on an unknown one.
 *
 * An unrecognised model gets the TIGHTEST known budget rather than the loosest
 * or an unbounded one: overshooting a real limit truncates the state inside the
 * vendor, which is the outcome `OVER_BUDGET` exists to prevent, and it does so
 * invisibly.
 */
export function budgetForModel(model: string): number {
    const known: Readonly<Record<string, number | undefined>> = STATE_BUDGET_CHARS;
    return known[model] ?? Math.min(...Object.values(STATE_BUDGET_CHARS));
}

// --- Neutralisation -------------------------------------------------------

/**
 * Clean, then neutralise. Empty becomes null.
 *
 * The ORDER is the point - see the module docblock. `baseClean` first because
 * NFKC can create the very tokens the neutraliser removes.
 */
function nz(raw: string | null | undefined): string | null {
    const cleaned = baseClean(raw);
    if (!cleaned) return null;
    const out = neutralizeUntrustedText(cleaned).trim();
    return out.length > 0 ? out : null;
}

/** The same, for a list, dropping anything that neutralised away to nothing. */
function nzList(raw: readonly (string | null | undefined)[]): readonly string[] {
    const out: string[] = [];
    for (const v of raw) {
        const clean = nz(v);
        if (clean !== null) out.push(clean);
    }
    return out;
}

/**
 * Flatten per-token variant lists into one deduplicated, bounded list.
 *
 * `translitVariants` already returns a deterministic order per token, and the
 * token order is the name's own, so the result is stable for identical input -
 * two identical reviews must not look like different ones.
 */
function flattenVariants(
    groups: readonly (readonly Variant[])[],
    limit: number,
): readonly { readonly scheme: string; readonly value: string }[] {
    const out: { scheme: string; value: string }[] = [];
    const seen = new Set<string>();
    for (const group of groups) {
        for (const v of group) {
            const value = nz(v.value);
            if (value === null) continue;
            const key = `${v.scheme}${SEP}${value}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ scheme: v.scheme, value });
            if (out.length >= limit) return out;
        }
    }
    return out;
}

// --- The shuffle ----------------------------------------------------------

/**
 * The per-pair shuffle key.
 *
 * A hash per `(account, employee)` pair rather than a seeded Fisher-Yates over
 * the list: it is independent of the order the candidates arrive in, so the
 * permutation cannot inherit the engine's ranking through the sort's stability,
 * and adding a sixth candidate does not re-letter the other five.
 */
function shuffleKey(accountKey: string, employeeId: string): string {
    return createHash('sha256').update(`${accountKey}${SEP}${employeeId}`).digest('hex');
}

// --- The builder ----------------------------------------------------------

function buildAccount(account: CanonicalAccount) {
    // NEUTRALISE FIRST, THEN DERIVE. Not the other way round: `normaliseUsername`
    // splits on `.`, `_`, `-` and a case change, so `<|im_start|>` tokenises into
    // `<|im` and `start|>` - and NEITHER fragment is a reserved token, so
    // neutralising the tokens afterwards leaves both of them intact and the
    // payload carries the sentinel in two pieces. The suite's
    // "neutralises username tokens" case is that exact string.
    //
    // The general rule, which the display name needs too: every derived value
    // (tokens, name parts, transliteration variants) comes off ALREADY-neutralised
    // text. A scrub applied after a split cannot see what the split broke.
    const cleanUsername = nz(account.username);
    const cleanDisplayName = nz(account.displayName);

    const username = normaliseUsername(cleanUsername);
    const name = normaliseName(cleanDisplayName);
    const email = normaliseEmail(account.email);

    return {
        username: cleanUsername ?? '',
        // Still neutralised a second time, cheaply and idempotently: it drops
        // anything that scrubs away to nothing, and the next derivation added
        // here inherits the guarantee rather than needing to remember it.
        usernameTokens: nzList(username.tokens),
        displayName: cleanDisplayName,
        givenName: nz(account.givenName) ?? nz(name.given),
        familyName: nz(account.familyName) ?? nz(name.family),
        // The LOCAL PART only. `normaliseEmail` also returns `.domain`, and this
        // is the one place a reader should be able to see that it is not read.
        emailLocalPart: nz(email.localPart),
        department: nz(account.department),
        title: nz(account.title),
        accountType: account.accountType,
        variants: flattenVariants([...name.variants, ...username.variants], MAX_ACCOUNT_VARIANTS),
    } as const;
}

/**
 * The candidate's name parts, with the engine's own fallback.
 *
 * `nameKey` in `lib/identity/reconcile/engine.ts` resolves a missing part from
 * `normaliseName(fullName)`, and this uses the same precedence deliberately: if
 * the model saw different name material from the engine, `AGREES` would be
 * comparing two answers to two different questions.
 */
function buildCandidate(c: AdjudicationCandidate, label: MatchOption): MatchStateCandidate {
    // Neutralise before parsing, for the reason `buildAccount` spells out: a
    // sentinel split across two name tokens survives a per-token scrub.
    const parsed = normaliseName(nz(c.fullName));
    const given = nz(c.givenName) ?? nz(parsed.given);
    const family = nz(c.familyName) ?? nz(parsed.family);
    const middles = nzList(c.middleName ? [c.middleName] : parsed.middle);

    return {
        label,
        givenName: given,
        middleNames: middles,
        familyName: family,
        preferredName: nz(c.preferredName),
        department: nz(c.department),
        title: nz(c.jobTitle),
        variants: flattenVariants(parsed.variants, MAX_CANDIDATE_VARIANTS),
    };
}

/**
 * Build the state for one account, or refuse.
 *
 * Deterministic in every respect: identical input yields an identical payload
 * and an identical labelling, which is what makes a stored verdict re-derivable
 * and a disagreement between two runs a real disagreement.
 */
export function buildMatchState(input: MatchStateInput): MatchStateBuildResult {
    // AN ORPHAN IS BUILT, NOT REFUSED. With no candidates the state carries the
    // account alone and `buildMatchRequest` asks the person question by itself —
    // because a `choice` over one option returns P(NONE) = 1 by normalisation,
    // and `NO_MATCH` read off that would annotate every orphan at maximum
    // confidence from an answer the model had no alternative to.
    //
    // This used to return `NO_CANDIDATES`, which was never a storable reason:
    // the ten `NonVerdictReason`s all describe something that happened to a
    // question somebody asked, and an orphan was not asked one. Now it is.

    // A TOTAL order. Score descending, then employee id ascending - a strict
    // `>` comparison alone leaves tied candidates in arrival order, and arrival
    // order is the engine's, which is the one thing the labels must not carry.
    const ranked = [...input.candidates].sort(
        (a, b) =>
            b.score - a.score ||
            (a.employeeId < b.employeeId ? -1 : a.employeeId > b.employeeId ? 1 : 0),
    );
    const capped = ranked.slice(0, MAX_CANDIDATES);
    const droppedForRank = ranked.length - capped.length;

    const account = buildAccount(input.account);
    const floor = Math.min(MIN_CANDIDATES_UNDER_BUDGET, capped.length);

    let lastChars = 0;
    for (let keep = capped.length; keep >= floor; keep--) {
        // Trim by RANK, shuffle what survives. The slice is of the score-ordered
        // list, so the engine's own suggestion is the last thing to be dropped.
        const kept = capped.slice(0, keep);
        const order = [...kept].sort((a, b) => {
            const ka = shuffleKey(input.account.accountKey, a.employeeId);
            const kb = shuffleKey(input.account.accountKey, b.employeeId);
            if (ka !== kb) return ka < kb ? -1 : 1;
            return a.employeeId < b.employeeId ? -1 : 1;
        });

        const labelling = order.map((c, i) => ({
            label: CANDIDATE_LABELS[i],
            employeeId: c.employeeId,
        }));
        const state: MatchState = {
            account,
            candidates: order.map((c, i) => buildCandidate(c, CANDIDATE_LABELS[i])),
        };

        lastChars = JSON.stringify(state).length;
        if (lastChars <= input.budgetChars) {
            return {
                ok: true,
                state,
                labelling,
                droppedForRank,
                droppedForBudget: capped.length - keep,
                stateChars: lastChars,
            };
        }
    }

    return { ok: false, reason: 'OVER_BUDGET', stateChars: lastChars };
}

// --- The guard seam -------------------------------------------------------

/**
 * Every string in the state, as one text, for `guardUntrustedInput`.
 *
 * Derived from the built state rather than from the source row, so what the
 * injection scanner reads is exactly what the provider will receive. A new
 * allowlisted field is scanned the day it is added, with nothing to remember.
 */
export function guardSubject(state: MatchState): string {
    const out: string[] = [];
    const walk = (node: unknown): void => {
        if (typeof node === 'string') {
            out.push(node);
            return;
        }
        if (Array.isArray(node)) {
            for (const item of node) walk(item);
            return;
        }
        if (node !== null && typeof node === 'object') {
            for (const value of Object.values(node)) walk(value);
        }
    };
    walk(state);
    return out.join('\n');
}

/**
 * Whether a guard outcome stops this account being adjudicated.
 *
 * **`reviewRequired`, not `blocked`.** Under the default `balanced` mode a
 * `malicious` INPUT verdict resolves to `flag`, so `assertGuardAllowed` alone
 * would send an account whose display name scanned as an injection attempt to
 * the model anyway. This surface has no human in the loop before the call, and
 * the cost of refusing is a row that goes to the queue unannotated - which is
 * the queue as it would be with no model at all. So a flag is enough, whatever
 * the tenant's `aiGuardMode` says.
 *
 * Deliberately a predicate rather than a throw: the run adjudicates hundreds of
 * accounts and one hostile record must quarantine itself, not the pass.
 */
export function guardQuarantines(outcome: { readonly reviewRequired: boolean }): boolean {
    return outcome.reviewRequired;
}
