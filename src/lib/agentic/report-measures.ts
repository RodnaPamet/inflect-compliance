/**
 * A NUMBER THAT KNOWS WHY IT IS NOT A NUMBER.
 *
 * Every assessor-facing figure in the agent-governance pack is a `Measure`
 * rather than a bare `number`, because the pack has to distinguish three
 * situations that a `number` collapses into one:
 *
 *   • a tenant with NO AGENTS AT ALL,
 *   • an agent NOBODY HAS ASSESSED,
 *   • an agent assessed and found to cover NOTHING.
 *
 * Rendered as `0` they are indistinguishable, and only the third is a finding
 * about the tenant's controls. The first is a finding about the register being
 * empty and the second is a finding about the assessment never having been
 * done — different questions, different remediations, and an assessor who is
 * shown one `0` for all three has been told nothing.
 *
 * This is the same argument `getSampleAuditDisagreementRate` already makes for
 * one field (`disagreementRate` is `null`, never 0, when nothing was answered)
 * and `computeAgentRiskCoverage` makes for another (`frameworkInstalled`
 * distinguishes "installed and nothing covered" from "not installed"),
 * generalised so that no future metric has to remember to make it again.
 *
 * ## The states, and the line between them
 *
 * `NO_POPULATION` is about the DENOMINATOR: there were no rows to count over.
 * `NOT_ASSESSED` is about the JUDGEMENT: the rows exist, and nobody has
 * produced the verdict this number would summarise. `NOT_OBSERVABLE` is about
 * the PLATFORM: the fact is outside what this product can see, and saying so is
 * more honest than a figure derived from the part it happens to hold.
 *
 * The line matters most at zero. "Zero tool calls escaped the kill switch" is
 * the strongest claim in the whole pack — and a tenant that has never run a
 * drill produces exactly the same zero by summing an empty list. That one is
 * `NO_POPULATION`.
 *
 * There is a THIRD way to arrive at that same zero, and it is the one that got
 * past the first fix: a drill that ERRORED. It is a row, so the denominator is
 * not empty and `NO_POPULATION` does not fire — but `toolCallsAfterKill` carries
 * `@default(0)` and a run that never reached the boundary never overwrites it,
 * so the pack's flagship claim was being earned by a drill the schema itself
 * describes as having "proved nothing". Rows existing while the judgement they
 * would carry does not is exactly `NOT_ASSESSED`, and it is why the population
 * a sum runs over must be "the rows that measured something", never "the rows".
 *
 * ## `basis` is a CODE, never prose
 *
 * A non-measured state carries a stable code saying which absence it is. Codes
 * and not sentences for the reason `AgentProposalSampleAudit.dissentCodes` gives:
 * a code aggregates into "which KIND of absence", which is the thing that
 * changes what an operator does next, and prose does not. The vocabulary is
 * closed and pinned below so a surface can translate it.
 *
 * Pure. No clock, no I/O, no Prisma — so every number in the pack can be
 * re-derived from its inputs during the review that questions it.
 */

/** The four states a reported figure can be in. */
export const MEASURE_STATES = [
    'MEASURED',
    'NO_POPULATION',
    'NOT_ASSESSED',
    'NOT_OBSERVABLE',
] as const;

export type MeasureState = (typeof MEASURE_STATES)[number];

/**
 * Why a figure is not a number. Closed vocabulary — a surface that cannot
 * translate a code shows the code, which is legible; a surface handed free text
 * shows somebody's sentence, which is not translatable at all.
 */
export const MEASURE_BASES = [
    /** The tenant has registered no agents, so there is nothing to count over. */
    'NO_AGENTS_REGISTERED',
    /** No agent of the kind this metric counts over (e.g. no third-party agent). */
    'NO_AGENTS_IN_SCOPE',
    /** Neither representation of the OWASP agentic framework is installed. */
    'ASI_FRAMEWORK_NOT_INSTALLED',
    /** The framework is installed but carries no requirement rows. */
    'ASI_FRAMEWORK_EMPTY',
    /** No proposal in the window was decided by a human. */
    'NO_DECIDED_PROPOSALS',
    /** Decisions exist but fall below the engine's minimum reportable sample. */
    'BELOW_REPORTABLE_SAMPLE',
    /** No sample audit has been answered, so a disagreement rate has no base. */
    'NO_ANSWERED_SAMPLE_AUDITS',
    /** No kill-switch drill has run, so nothing was measured after a kill. */
    'NO_DRILLS_RUN',
    /**
     * Drills ran and every one of them ERRORED, so none produced a measurement.
     *
     * Distinct from `NO_DRILLS_RUN` because the two demand different actions:
     * that one says "go run a drill", this one says "your drills are running
     * and breaking — fix the harness". Collapsing them would hide the second
     * behind advice that has already been taken.
     */
    'ALL_DRILLS_ERRORED',
    /** No kill switch was ever engaged in the window. */
    'NO_KILLS_ENGAGED',
    /** No vendor supplies an agent here, so vendor assurance has no subject. */
    'NO_SUPPLYING_VENDORS',
    /** The fact lives outside this platform's boundary — see the definition. */
    'OUTSIDE_PLATFORM_BOUNDARY',
] as const;

export type MeasureBasis = (typeof MEASURE_BASES)[number];

export type Measure =
    | { readonly state: 'MEASURED'; readonly value: number; readonly basis: null }
    | {
          readonly state: Exclude<MeasureState, 'MEASURED'>;
          readonly value: null;
          readonly basis: MeasureBasis;
      };

/** A figure that was actually counted. `0` here means genuinely none. */
export function measured(value: number): Measure {
    return { state: 'MEASURED', value, basis: null };
}

/** Nothing to count over. The denominator is empty, not zero. */
export function noPopulation(basis: MeasureBasis): Measure {
    return { state: 'NO_POPULATION', value: null, basis };
}

/** The rows exist; the judgement this number summarises does not. */
export function notAssessed(basis: MeasureBasis): Measure {
    return { state: 'NOT_ASSESSED', value: null, basis };
}

/** The platform structurally cannot see this. */
export function notObservable(basis: MeasureBasis): Measure {
    return { state: 'NOT_OBSERVABLE', value: null, basis };
}

/**
 * A ratio in 0..1, or `NO_POPULATION` when the denominator is empty.
 *
 * The whole reason this helper exists is the guard on the denominator: `0 / 0`
 * is `NaN`, which serialises to `null` in JSON and would arrive at a surface
 * indistinguishable from a deliberate absence, and `numerator / denominator`
 * with a zero denominator hand-defaulted to `0` is the "empty renders as zero"
 * defect stated as arithmetic.
 */
export function ratio(numerator: number, denominator: number, basis: MeasureBasis): Measure {
    if (denominator <= 0) return noPopulation(basis);
    return measured(numerator / denominator);
}

/** Narrow to the measured arm — for callers that want the number or nothing. */
export function isMeasured(
    m: Measure,
): m is { readonly state: 'MEASURED'; readonly value: number; readonly basis: null } {
    return m.state === 'MEASURED';
}
