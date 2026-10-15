/**
 * Step 4a's scorers: the medium and weak signals, plugged into Step 3b's
 * extension point.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT MAKES THIS SAFE TO ADD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * These are the fuzzy signals — a declared naming convention, and two string
 * similarity measures. They are exactly what a precision gate is afraid of, and
 * Step 3b anticipated them: {@link CandidateScorer} returns `SupportingSignal`,
 * whose `kind` is narrowed to the non-strong union. So nothing in this file can
 * produce a `LINKED`, at any score, and that is a compile error rather than a
 * review note.
 *
 * The exhaustive test Step 3b shipped already covers the five kinds used here —
 * it enumerated all 127 subsets of the supporting kinds at score 10,000 each,
 * before any of them had an implementation. This step adds the implementations and
 * that test keeps holding.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A COLLISION IS AN EQUAL SCORE, NOT A TIE-BREAK
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * When a convention generates `jsmith` for both John and Jane Smith, the scorer
 * emits the SAME signal at the SAME score to each. The engine's decision ladder
 * then reads two supporting candidates whose scores are equal and yields
 * `AMBIGUOUS` — which is the correct outcome and needs no new engine branch.
 *
 * That is worth stating because the alternative is tempting and wrong: having the
 * scorer pick one (the earlier hire, the lower id) would be this module inventing
 * a rule the convention does not contain, and it would arrive at a reviewer as a
 * confident-looking suggestion rather than as the genuine ambiguity it is.
 *
 * @module lib/identity/reconcile/scorers
 */

import type {
    CandidateBlocker,
    CandidateScorer,
    RosterEmployee,
    SupportingSignal,
} from './engine';
import {
    generateUsername,
    matchConvention,
    nameParts,
    parseConvention,
    type ParsedConvention,
} from './conventions';
import { baseClean, normaliseUsername, translitVariants } from './normalise';
import { scoreNames } from './similarity';

/**
 * Scores. Ordering weights only — nothing compares these against a link
 * threshold, because nothing CAN.
 *
 * A convention outranks similarity because it is a rule somebody adopted about
 * this specific system, where similarity is a general guess about names. A
 * romanised match of either kind is docked, because it rests on a transformation
 * as well as on the data.
 */
export const SCORER_WEIGHTS = {
    CONVENTION: 220,
    CONVENTION_TRANSLITERATED: 180,
    /** Multiplied by the similarity score, which lies in [0, 1]. */
    SIMILARITY_SCALE: 140,
    /** Below this, a similarity is noise and is not emitted at all. */
    SIMILARITY_FLOOR: 0.82,
    /**
     * A shared department (#3516).
     *
     * DELIBERATELY THE SMALLEST WEIGHT HERE, and it must stay below
     * {@link SCORER_WEIGHTS.CONVENTION}: `legacy-reviewer-actions` bounds its
     * bulk action by the largest score any single supporting signal can
     * contribute, so a new weight above CONVENTION would silently re-tune who
     * qualifies for bulk confirmation. 40 is corroboration, not identification
     * — a department is shared by many people and identifies none of them.
     */
    DEPARTMENT: 40,
} as const;

/**
 * A scorer for one adopted convention.
 *
 * Closed over the roster because a collision is a property of the ROSTER, not of
 * the pair the engine is currently scoring — the scorer must know that `jsmith`
 * also belongs to somebody else in order to score them equally.
 *
 * The match is computed once per account and memoised, not once per pair: the
 * engine calls a scorer for every blocked candidate, and recomputing a whole-roster
 * match each time would turn a blocked comparison back into an O(roster) one and
 * quietly undo the blocking index.
 */
export function makeConventionScorer(
    template: string | ParsedConvention,
    roster: readonly RosterEmployee[]
): CandidateScorer {
    const convention = typeof template === 'string' ? parseConvention(template) : template;
    const memo = new Map<string, ReturnType<typeof matchConvention>>();

    return (account, candidate): readonly SupportingSignal[] => {
        let match = memo.get(account.accountKey);
        if (!match) {
            match = matchConvention(convention, account.accountKey, roster);
            memo.set(account.accountKey, match);
        }
        if (!match.employeeIds.includes(candidate.id)) return [];

        // The SAME score for every colliding employee. See the module docblock.
        const score = match.scheme
            ? SCORER_WEIGHTS.CONVENTION_TRANSLITERATED
            : SCORER_WEIGHTS.CONVENTION;

        return [
            {
                kind: 'USERNAME_CONVENTION',
                score,
                evidence: match.scheme
                    ? `${convention.template} via ${match.scheme}`
                    : convention.template,
            },
        ];
    };
}

/**
 * A scorer for name similarity.
 *
 * Compares the account's display name with the candidate's. It is called only for
 * pairs that BLOCKING produced, which is what keeps the comparison count linear —
 * the engine's own budget test asserts that, and a scorer that reached outside its
 * pair would break it.
 *
 * Emits nothing below {@link SCORER_WEIGHTS.SIMILARITY_FLOOR}. A weak similarity is
 * not weak evidence, it is noise, and emitting it would fill a reviewer's candidate
 * list with names that merely share letters.
 */
export function makeSimilarityScorer(): CandidateScorer {
    return (account, candidate): readonly SupportingSignal[] => {
        const accountName = account.displayName ?? '';
        const candidateName =
            candidate.fullName ||
            [candidate.givenName, candidate.familyName].filter(Boolean).join(' ');
        if (!accountName || !candidateName) return [];

        const score = scoreNames(accountName, candidateName);
        if (score.best < SCORER_WEIGHTS.SIMILARITY_FLOOR) return [];

        const signals: SupportingSignal[] = [
            {
                kind: score.scheme ? 'NAME_TRANSLIT' : 'SIMILARITY',
                score: Math.round(score.best * SCORER_WEIGHTS.SIMILARITY_SCALE),
                evidence: score.scheme
                    ? `${score.best.toFixed(3)} via ${score.scheme}`
                    : score.best.toFixed(3),
            },
        ];
        return signals;
    };
}

/**
 * A SECOND OPINION on a candidate somebody else already proposed (#3516).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Measured over the Step 3a corpus with 4a wired: of 24 residue rows a reviewer
 * sees, **seven rest on `NAME_TRANSLIT` alone and five on `SIMILARITY` alone**.
 * Those rows give a person one piece of evidence and no way to corroborate it
 * without going to the roster themselves. Every other supporting kind is about
 * a name, an address or a directory link — so a second signal drawn from any of
 * them restates the first rather than confirming it.
 *
 * A department is independent of how a name is spelled. It is the cheapest
 * genuinely separate fact this engine already holds on both sides
 * (`CanonicalAccount.department`, `RosterEmployee.department`).
 *
 * ── WHAT IT DOES NOT DO, WHICH MATTERS MORE ────────────────────────────────
 *
 * It changes **no outcome**. `DEPARTMENT_MATCH` is `SUPPORTING`, so it cannot
 * reach `LINKED` however it scores — proven for every subset of the supporting
 * kinds at score 10,000 by `identity-reconcile-precision`'s exhaustive test,
 * which enumerates the union and therefore covered this kind the moment it was
 * added.
 *
 * It is a SCORER and never a blocker. A scorer runs per candidate the blocker
 * already produced, so this can only annotate a shortlist, never widen one.
 * Keyed as a blocker it would make every member of Finance a candidate for
 * every other — a shortlist of dozens, which is worse than none.
 *
 * And it cannot break a tie on its own: two candidates in the same department
 * both receive it, so the engine's equal-score rule is unaffected. It only
 * separates candidates who differ on the department, which is exactly when the
 * separation is real.
 */
export function makeDepartmentScorer(): CandidateScorer {
    return (account, candidate): readonly SupportingSignal[] => {
        const a = normaliseOrgUnit(account.department);
        const b = normaliseOrgUnit(candidate.department);
        // Absence is not a match. Two accounts with no department are not
        // colleagues, and scoring them as such would corroborate every weak
        // name match in a source system that leaves the field blank — which is
        // most of them.
        if (!a || !b || a !== b) return [];
        return [
            {
                kind: 'DEPARTMENT_MATCH',
                score: SCORER_WEIGHTS.DEPARTMENT,
                // The value, so a reviewer can see WHICH department agreed
                // rather than being told that one did.
                evidence: a,
            },
        ];
    };
}

/**
 * Compare org units the way a person would, and no further.
 *
 * Case and surrounding whitespace are noise — "Finance" and "finance " are the
 * same unit. Internal punctuation and spacing are NOT normalised away: "Finance
 * & Controlling" and "Finance" are different units, and folding them would
 * manufacture agreement between neighbouring teams. That is the same line
 * `EMAIL_EXACT` draws at byte-equality for the same reason.
 */
function normaliseOrgUnit(v: string | null | undefined): string | null {
    const t = (v ?? '').trim().toLowerCase();
    return t === '' ? null : t;
}

// ─── Blocking ──────────────────────────────────────────────────────────────

/**
 * Block on the username a convention would generate.
 *
 * Built ONCE: every employee's expected username, indexed. Looking up an account
 * is then a map read, which is what makes this blocking rather than a scan — a
 * blocker that walked the roster per account would turn the engine's linear
 * comparison count quadratic, and the budget test would say so.
 *
 * Transliterated forms are indexed under the same key space, so a Cyrillic roster
 * name is reachable from a romanised login. The scorer, not the blocker, is what
 * records which scheme produced the match and scores it lower.
 */
export function makeConventionBlocker(
    template: string | ParsedConvention,
    roster: readonly RosterEmployee[]
): CandidateBlocker {
    const convention = typeof template === 'string' ? parseConvention(template) : template;
    const allowsCounter = convention.parts.some((p) => p.kind === 'counter');
    const byUsername = new Map<string, string[]>();

    const add = (username: string | null, id: string): void => {
        if (!username) return;
        const at = byUsername.get(username);
        if (at) {
            if (!at.includes(id)) at.push(id);
        } else byUsername.set(username, [id]);
    };

    for (const e of roster) {
        add(generateUsername(convention, e), e.id);
        const parts = nameParts(e);
        if (!parts) continue;
        for (const gv of translitVariants(parts.given)) {
            for (const fv of translitVariants(parts.family)) {
                if (gv.scheme === 'none' && fv.scheme === 'none') continue;
                add(
                    generateUsername(convention, {
                        id: e.id,
                        givenName: gv.value,
                        familyName: fv.value,
                        middleNames: parts.middle ? [parts.middle] : [],
                    }),
                    e.id
                );
            }
        }
    }
    // Deterministic order, so a shuffled roster yields the same candidate set.
    for (const [k, v] of byUsername) byUsername.set(k, [...v].sort());

    return (account): readonly string[] => {
        const cleaned = baseClean(account.accountKey).toLowerCase();
        if (!cleaned) return [];
        const direct = byUsername.get(cleaned);
        if (direct) return direct;
        if (!allowsCounter) return [];
        const u = normaliseUsername(cleaned);
        if (!u.disambiguator) return [];
        const stem = cleaned.slice(0, cleaned.length - u.disambiguator.length);
        return byUsername.get(stem) ?? [];
    };
}

/**
 * Block on the family name.
 *
 * The one name part that is worth blocking on: given names collide across the
 * whole roster (`john` matches everyone called John), where a family name
 * partitions it into groups small enough to compare. That is the same reasoning
 * the built-in email and employee-number keys rest on — a key is useful when it is
 * selective.
 *
 * Indexed over transliterated forms too, which is how `Иванов` becomes reachable
 * from a display name reading `Ivanov`.
 */
export function makeFamilyNameBlocker(roster: readonly RosterEmployee[]): CandidateBlocker {
    const byFamily = new Map<string, string[]>();
    const add = (key: string, id: string): void => {
        const k = baseClean(key).toLowerCase();
        if (!k) return;
        const at = byFamily.get(k);
        if (at) {
            if (!at.includes(id)) at.push(id);
        } else byFamily.set(k, [id]);
    };

    for (const e of roster) {
        const parts = nameParts(e);
        if (!parts) continue;
        add(parts.family, e.id);
        for (const v of translitVariants(parts.family)) add(v.value, e.id);
    }
    for (const [k, v] of byFamily) byFamily.set(k, [...v].sort());

    return (account, context): readonly string[] => {
        const out = new Set<string>();
        const family = context.accountName.family;
        if (family) {
            for (const id of byFamily.get(baseClean(family).toLowerCase()) ?? []) out.add(id);
            for (const v of translitVariants(family)) {
                for (const id of byFamily.get(baseClean(v.value).toLowerCase()) ?? []) out.add(id);
            }
        }
        // A login token can also be a family name — `smithj` tokenises to
        // ['smithj'], but `smith.j` gives ['smith','j'].
        for (const token of context.accountUsername.tokens) {
            for (const id of byFamily.get(baseClean(token).toLowerCase()) ?? []) out.add(id);
        }
        return [...out].sort();
    };
}

/**
 * Everything Step 4a adds, in one place.
 *
 * Both halves, because they are not independent: the scorers are unreachable for a
 * name-only account without the blockers, and the blockers produce candidates
 * nothing would score without the scorers. "Which extensions does Step 4a add?"
 * has one answer rather than one per call site.
 */
export function step4aExtensions(
    roster: readonly RosterEmployee[],
    convention?: string | ParsedConvention | null
): {
    scorers: readonly CandidateScorer[];
    blockers: readonly CandidateBlocker[];
    /**
     * The engine's `ambiguityMargin` (#3560), returned here because this is
     * where the weights it is derived from live.
     *
     * `SCORER_WEIGHTS.CONVENTION` is the largest score any single supporting
     * signal can contribute, so a leader ahead by less than it is a leader the
     * runner-up could overtake on one more match — which is not a choice the
     * engine should make for a reviewer. It is the SAME number
     * `legacy-reviewer-actions` uses for `BULK_MIN_MARGIN`, and deliberately:
     * "too close to suggest" and "too close to bulk-confirm" are one judgement,
     * and two constants would eventually disagree about it.
     */
    ambiguityMargin: number;
} {
    const scorers: CandidateScorer[] = [];
    const blockers: CandidateBlocker[] = [makeFamilyNameBlocker(roster)];
    if (convention) {
        scorers.push(makeConventionScorer(convention, roster));
        blockers.push(makeConventionBlocker(convention, roster));
    }
    scorers.push(makeSimilarityScorer());
    // The second opinion (#3516). Last, so it annotates whatever the scorers
    // above proposed rather than competing with them — and at the smallest
    // weight here, because it corroborates and never identifies.
    scorers.push(makeDepartmentScorer());
    return { scorers, blockers, ambiguityMargin: SCORER_WEIGHTS.CONVENTION };
}
