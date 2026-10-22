/**
 * THE HARNESS LADDER — how well governed one agent is, H0 to H5 (#3660).
 *
 * An agent is a model plus a loop. The HARNESS is everything around that loop
 * that decides what it may call, what it was taught, with which credential,
 * under whose accountability, how it is observed and how it is stopped. The
 * scanner (UC1) scores every agent it finds on this ladder, and the auditor
 * agent (UC4) audits against the same one. See docs/agentic-iam-roadmap.md.
 *
 * ## The shape is copied from `src/lib/identity/write-ladder.ts`, deliberately
 *
 *   • ORDER LIVES IN ONE PLACE. `HARNESS_LEVELS` is a const tuple and its index
 *     is the ordering. Nothing compares two levels by any other route.
 *   • COMPARISON IS ORDINAL. `levelAtLeast` compares indices; a check written as
 *     equality is correct only while the bar sits on one particular rung.
 *   • NO SERVER IMPORTS. The scanner, the ingest and the matrix page hold the
 *     same module, so a criterion cannot mean one thing in the client's network
 *     and another in the product.
 *
 * ## Unanswered counts as NO, and so does an answer with no evidence
 *
 * An agent meets a rung only when EVERY criterion on that rung and on every
 * rung below it is met WITH an evidence reference. A criterion the scanner did
 * not report, or reported as met without saying where it saw that, is not met.
 * The alternative — score what you can see and assume the rest — gives the
 * agent nobody can observe the friendliest score, which is the inversion the
 * agent register already refuses one level up (an unscored risk tier means
 * deny, never LOW).
 *
 * ## The ladder is REPORT-ONLY (owner decision, 2026-10-17)
 *
 * A level never gates activation or a tool call. It feeds findings: an agent
 * holding a write-capable or external tool below H3, or a read-only agent below
 * H2, is a HARNESS_SHORTFALL. `shortfallBarFor` is that rule. The authority
 * funnel may not import this module, and `eslint.config.mjs` refuses it at
 * error level for the funnel's files: a stale or failed scan must not be able
 * to stop a working agent.
 *
 * PURE: no clock, no I/O, no imports.
 */

/** The rungs, lowest to highest. INDEX IS THE ORDER. */
export const HARNESS_LEVELS = ['H0', 'H1', 'H2', 'H3', 'H4', 'H5'] as const;

export type HarnessLevel = (typeof HARNESS_LEVELS)[number];

/** What each rung is called, for surfaces that show the ladder. */
export const HARNESS_LEVEL_NAMES: Readonly<Record<HarnessLevel, string>> = {
    H0: 'Shadow',
    H1: 'Registered',
    H2: 'Bounded',
    H3: 'Guarded',
    H4: 'Observed and stoppable',
    H5: 'Evidenced',
};

/**
 * Every criterion, by the rung that first requires it. The ids are STABLE: the
 * scanner contract carries them, findings name them and an assessor may cite
 * one, so they are authored, never generated, and never renamed. Adding a
 * criterion to a rung lowers the level of every agent that has not evidenced it,
 * which is intended — and is why that is a reviewed diff here rather than
 * configuration.
 *
 * H0 has no criteria: it is what an agent is before it has met anything.
 */
export const HARNESS_CRITERIA = {
    H0: [],
    H1: [
        'H1.registered',
        'H1.owner',
        'H1.axes_declared',
        'H1.tier_scored_fresh',
    ],
    H2: [
        'H2.credential_bound',
        'H2.grant_kind_declared',
        'H2.tools_allowlisted',
        'H2.audience_tokens',
        'H2.policy_card',
    ],
    H3: [
        'H3.manifests_pinned',
        'H3.payloads_guarded',
        'H3.propose_not_commit',
        'H3.prior_state_reads',
        'H3.skills_declared',
        'H3.delegation_narrows',
        /*
            `H3.egress_enforced` — the agent's outbound network access is
            enforced against an allow-list, with evidence (#3947).

            WORDED FOR THE PROPERTY, NOT THE PRODUCT. A kernel sandbox is one
            source of this evidence; so is a Kubernetes NetworkPolicy, a cloud
            egress firewall, or a mediating proxy that fails closed. A criterion
            meaning "runs in <vendor>" would turn the ladder into a vendor
            checklist and could never be met by the next mechanism, which is the
            opposite of what a ladder is for.

            ENFORCED is the load-bearing word, and it is not the same as
            CONFIGURED. A policy that logs a forbidden request and forwards it
            anyway has an allow-list and no enforcement — and that is the
            DOCUMENTED DEFAULT of at least one runtime we expect to meet this
            criterion, so the distinction is not hypothetical. Evidence that
            rules exist is not evidence that they bind; a verdict needs the
            second.

            Sits on H3 ("Guarded") beside `payloads_guarded`: both are about
            what leaves the loop. `tools_allowlisted` on H2 asks which hosts the
            agent was CONFIGURED to reach; this asks whether anything stops it
            reaching others.
        */
        'H3.egress_enforced',
    ],
    H4: [
        'H4.ledger_baseline',
        'H4.receipts',
        'H4.kill_switch_drilled',
        'H4.token_budget',
    ],
    H5: [
        'H5.asi_coverage',
        'H5.evidence_emitted',
        'H5.skills_evaluated',
        'H5.sample_audit',
        'H5.independent_audit',
    ],
} as const satisfies Readonly<Record<HarnessLevel, readonly string[]>>;

export type HarnessCriterionId = (typeof HARNESS_CRITERIA)[HarnessLevel][number];

/** Every criterion id, in rung order. */
export const ALL_HARNESS_CRITERIA: readonly HarnessCriterionId[] = HARNESS_LEVELS.flatMap(
    (level) => HARNESS_CRITERIA[level] as readonly HarnessCriterionId[],
);

/** Narrowing membership test — the one place a criterion id is widened to `string`. */
export function isHarnessCriterionId(value: string): value is HarnessCriterionId {
    return (ALL_HARNESS_CRITERIA as readonly string[]).includes(value);
}

/** The ordinal of a level. The only comparison route. */
export function rungOf(level: HarnessLevel): number {
    return HARNESS_LEVELS.indexOf(level);
}

/** Is `level` at or above `bar`? Ordinal, never equality. */
export function levelAtLeast(level: HarnessLevel, bar: HarnessLevel): boolean {
    return rungOf(level) >= rungOf(bar);
}

/** One reported answer for one criterion. */
export interface CriterionVerdict {
    readonly criterion: HarnessCriterionId;
    readonly met: boolean;
    /** Where the scanner saw it. A `met` with no evidence counts as not met. */
    readonly evidence: string | null;
}

export interface HarnessScore {
    readonly level: HarnessLevel;
    /**
     * The criteria standing between this agent and the next rung, in the order
     * the ladder lists them. Empty at H5. Each is either unanswered, answered
     * as not met, or answered as met without evidence.
     */
    readonly blockingNextRung: readonly HarnessCriterionId[];
}

/** Is this one criterion met, by the ladder's rule? Met, AND with a non-blank evidence reference. */
export function isVerdictEvidenced(v: CriterionVerdict | undefined): boolean {
    return v !== undefined && v.met === true && typeof v.evidence === 'string' && v.evidence.trim().length > 0;
}

/**
 * How one criterion reads, after the ladder's rule. Only `EVIDENCED` is met:
 * the other three are three different ways of NOT being met, kept apart so a
 * surface can say which — "reported met with nothing behind it" is a different
 * conversation with the scanner's owner from "never reported".
 */
export type CriterionState = 'EVIDENCED' | 'MET_UNEVIDENCED' | 'NOT_MET' | 'UNANSWERED';

/** The state of one (collapsed) verdict. `undefined` is a criterion the report never answered. */
export function criterionState(v: CriterionVerdict | undefined): CriterionState {
    if (v === undefined) return 'UNANSWERED';
    if (v.met !== true) return 'NOT_MET';
    return isVerdictEvidenced(v) ? 'EVIDENCED' : 'MET_UNEVIDENCED';
}

/** Lower is LESS favourable. Unanswered never arises from a reported verdict. */
const FAVOUR: Readonly<Record<CriterionState, number>> = {
    UNANSWERED: 0,
    NOT_MET: 1,
    MET_UNEVIDENCED: 2,
    EVIDENCED: 3,
};

/**
 * One verdict per criterion: a criterion reported more than once is judged on
 * its LEAST favourable answer (a report that says both "met" and "not met"
 * about one thing has not established it), and among equally unfavourable
 * answers the first reported stands. `scoreHarness` scores over exactly this,
 * and a surface that shows a cell per criterion must show exactly this, or the
 * cells and the level disagree.
 */
export function collapseVerdicts(
    verdicts: readonly CriterionVerdict[],
): ReadonlyMap<HarnessCriterionId, CriterionVerdict> {
    const byCriterion = new Map<HarnessCriterionId, CriterionVerdict>();
    for (const v of verdicts) {
        const seen = byCriterion.get(v.criterion);
        if (seen === undefined || FAVOUR[criterionState(v)] < FAVOUR[criterionState(seen)]) {
            byCriterion.set(v.criterion, v);
        }
    }
    return byCriterion;
}

/**
 * Score one agent. Returns the highest rung whose criteria — and every lower
 * rung's — are ALL met with evidence, judged over `collapseVerdicts`.
 */
export function scoreHarness(verdicts: readonly CriterionVerdict[]): HarnessScore {
    const byCriterion = collapseVerdicts(verdicts);

    let level: HarnessLevel = 'H0';
    for (const candidate of HARNESS_LEVELS.slice(1)) {
        const required = HARNESS_CRITERIA[candidate] as readonly HarnessCriterionId[];
        const unmet = required.filter((c) => criterionState(byCriterion.get(c)) !== 'EVIDENCED');
        if (unmet.length > 0) {
            return { level, blockingNextRung: unmet };
        }
        level = candidate;
    }
    return { level, blockingNextRung: [] };
}

/** What an agent can reach, as far as the shortfall rule cares. */
export type HarnessReach = 'read-only' | 'write-or-external';

/**
 * The report-only bar (owner decision, 2026-10-17): H3 for an agent holding any
 * write-capable or external tool, H2 for a read-only agent. An agent below its
 * bar is a HARNESS_SHORTFALL finding. It is never a refusal.
 *
 * An agent whose reach is UNKNOWN is held to the higher bar. Unknown reach is
 * what a write-capable agent looks like before anyone has checked, and the
 * lower bar would let it pass as read-only by default.
 */
export function shortfallBarFor(reach: HarnessReach | 'unknown'): HarnessLevel {
    return reach === 'read-only' ? 'H2' : 'H3';
}

/** Is this agent below its bar? */
export function isShortfall(level: HarnessLevel, reach: HarnessReach | 'unknown'): boolean {
    return !levelAtLeast(level, shortfallBarFor(reach));
}
