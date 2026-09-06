/**
 * RUN CAPS — how much one agent run may spend, and what happens at the ceiling.
 *
 * OWASP ASI08 (cascading failures) is not usually a single tool doing something
 * catastrophic. It is a loop: an agent that proposes, reads, re-reads and
 * proposes again, at machine speed, until the review queue is unusable and the
 * bill is real. Propose-not-commit already bounds what ONE action can do. What
 * was unbounded until this module is HOW MANY.
 *
 * ## The load-bearing property: a cap HALTS, it never truncates
 *
 * `charge` is ALL-OR-NOTHING. A request for ten units against a budget with
 * three left is refused for all ten; it is never granted three. That is the
 * whole design and it is worth stating plainly, because the convenient
 * alternative is the failure mode:
 *
 *   A run that proposes 500 items under a cap of 100, and is quietly given the
 *   first 100, produces a review queue that LOOKS like the agent's considered
 *   output. Nobody chose that subset. Nothing downstream can tell it apart from
 *   a run that meant to propose exactly 100 — the evidence that would say so is
 *   the evidence that was dropped.
 *
 * So the refused units are reported in full on the halt (`refused`), the ledger
 * does not advance (`used` is unchanged, `remaining` still holds the unspent
 * balance), and the caller's job is to record that the remaining work was NOT
 * done. `bounded-exec.ts` reaches the same conclusion for a tool's OUTPUT — "a
 * truncated tool output is worse than no output, because an agent cannot see
 * the difference" — and this is the same sentence about a run's WORK.
 *
 * ## Composition: strictest wins, and a TIE names the ENGINE
 *
 * Two independent ceilings exist and they can disagree:
 *
 *   • the ENGINE's, in `ENGINE_CAPS` — global, applies to every run, and is
 *     about what this deployment is willing to spend on any one run;
 *   • the AGENT'S POLICY CARD's `maxActionsPerRun` — per agent, versioned, and
 *     is about what this particular agent has been trusted with.
 *
 * The effective cap is the MINIMUM. That is the same rule `resolveAutonomyCeiling`
 * states for autonomy ("a MINIMUM over independent narrowing terms, so no term
 * can widen") and the same rule the card itself is built on: a card can only
 * ever narrow. Taking the maximum would let a card WIDEN a global ceiling,
 * which would make the engine's cap a suggestion; taking the card's value alone
 * would make an operator with edit rights on one card able to raise this
 * deployment's ceiling.
 *
 * A TIE resolves to `ENGINE`, and that is not cosmetic. `source` is what an
 * operator reads to decide what to widen. When card and engine agree at 50,
 * widening the card to 100 changes nothing — the engine still binds — so
 * naming the card would send somebody to make an edit that cannot work.
 *
 * ## An agent with NO card gets the ENGINE ceiling, never "unbounded"
 *
 * `policy-card.ts` is explicit that an absent card contributes NO term, and it
 * is right: reading "no card" as "may do nothing" would make creating the
 * register's own governance artefact the thing that takes a working agent dark.
 *
 * But "contributes no term" was being read as "there is no term", and on the
 * per-run action axis there was no other one — so an agent with a card was
 * bounded at (say) 25 calls per run and an agent WITHOUT a card was bounded at
 * infinity. Deleting a card raised the ceiling. That is the governance control
 * being strictly worse than not having it.
 *
 * `resolveRunCaps(null)` therefore returns the ENGINE ceiling on every axis.
 * The card still only narrows, an absent card still refuses nothing on its own,
 * and deleting a card now moves an agent from 25 to 50 rather than from 25 to
 * unbounded. Since the engine cap also clamps the TOP rung of
 * `ACTION_CAP_LADDER` (1000), an uncarded agent is never strictly more
 * permissive than the most permissive card this product can express.
 *
 * ## The day window is deliberately NOT here
 *
 * A per-DAY budget needs a durable counter and a window. Both already exist,
 * exactly once: `AgentPolicyCard.actionsInWindow` and `reserveDailyAction` /
 * `utcDay` in `policy-card-store.ts`, whose window rolls inside the same UPDATE
 * that increments it. This module does not restate any of that and does not
 * define a second "day" — a budget with two homes is two budgets. See the
 * implementation note for the window-rollover behaviour of a run in flight and
 * for the one axis this composition does NOT reach.
 *
 * @see tests/unit/agent-caps.test.ts
 */
import { ENGINE_CAPS } from './workflow-types';

// ─── The axes ───────────────────────────────────────────────────────

/**
 * What a run spends, in the units it spends it in.
 *
 * `RUNTIME_MS` is the odd one and is called out here rather than discovered:
 * its units are spent by the CLOCK, not by the caller, so it is the one axis
 * whose `used` is read rather than accumulated. Everything else about it —
 * the limit, the source, the halt shape, the boundary — is identical.
 */
export const RUN_CAP_KINDS = [
    'STEPS',
    'TOOL_CALLS',
    'PROPOSALS',
    'TOKENS',
    'RUNTIME_MS',
] as const;

export type RunCapKind = (typeof RUN_CAP_KINDS)[number];

/** The axes a caller charges units to. Everything except the clock. */
export type CountedRunCapKind = Exclude<RunCapKind, 'RUNTIME_MS'>;

/**
 * WHICH ceiling bound this run — the thing an operator has to widen, if
 * widening is the right answer at all.
 *
 * A halt that says only "cap exceeded" is the same defect one level down as a
 * refusal that says only "denied": it leaves somebody to guess between an agent
 * operating outside its envelope (widen nothing, investigate) and a deployment
 * ceiling that is simply too low for this workflow (widen the engine).
 */
export const RUN_CAP_SOURCES = ['ENGINE', 'POLICY_CARD'] as const;

export type RunCapSource = (typeof RUN_CAP_SOURCES)[number];

// ─── The engine's ceiling ───────────────────────────────────────────

/**
 * The most items ONE run may propose, across every PROPOSE step it executes.
 *
 * A rung of `ACTION_CAP_LADDER`, because a budget in this subsystem is ordinal
 * and picking a number off the ladder is how a future widening stays reviewable
 * as one step rather than as three orders of magnitude.
 *
 * It is a separate axis from `TOOL_CALLS` and that is the point. The card's
 * `maxActionsPerRun` bounds CALLS; one `propose_controls` call is one call and
 * can carry five hundred items. A card capping an agent at a single action per
 * run therefore does nothing whatever to bound proposal flooding, which is the
 * ASI08 vector this axis exists for.
 */
export const ENGINE_MAX_PROPOSALS_PER_RUN = 100;

/**
 * The global ceiling, per axis. DERIVED from `ENGINE_CAPS` wherever that
 * already has an answer, so the engine's step / token / wall-clock numbers are
 * still declared exactly once and this module cannot drift from them.
 *
 * `TOOL_CALLS` equals `MAX_STEPS` rather than exceeding it: a workflow step
 * makes at most one tool call, so a tool-call ceiling above the step ceiling
 * could never bind, and a number that can never bind is not a bound.
 */
export const ENGINE_RUN_CAPS: Readonly<Record<RunCapKind, number>> = {
    STEPS: ENGINE_CAPS.MAX_STEPS,
    TOOL_CALLS: ENGINE_CAPS.MAX_STEPS,
    PROPOSALS: ENGINE_MAX_PROPOSALS_PER_RUN,
    TOKENS: ENGINE_CAPS.MAX_TOKENS,
    RUNTIME_MS: ENGINE_CAPS.WALL_CLOCK_MS,
};

// ─── Composition ────────────────────────────────────────────────────

/** One resolved ceiling, and which of the two declarations produced it. */
export interface EffectiveRunCap {
    readonly limit: number;
    readonly source: RunCapSource;
}

export type EffectiveRunCaps = Readonly<Record<RunCapKind, EffectiveRunCap>>;

/**
 * The slice of a policy card this composition reads.
 *
 * A structural type over one field rather than `AgentPolicyCardValue`, so a
 * caller can hand this the card it already has without this module needing to
 * know what else is on it — and so the ONE term the card contributes to a run
 * budget is visible in the signature rather than buried in a wide object.
 */
export interface CardCapTerms {
    readonly maxActionsPerRun: number;
}

/**
 * Resolve the effective ceiling on every axis.
 *
 * `null` means the agent has no policy card — see the header. It yields the
 * ENGINE ceiling on every axis, which is the same thing an agent whose card
 * sits at the top rung gets.
 */
export function resolveRunCaps(card: CardCapTerms | null): EffectiveRunCaps {
    return {
        STEPS: engineCap('STEPS'),
        // The one axis both declarations speak to today. The card's
        // `maxActionsPerRun` counts tool calls, which is exactly this.
        TOOL_CALLS: strictestOf('TOOL_CALLS', card === null ? null : card.maxActionsPerRun),
        PROPOSALS: engineCap('PROPOSALS'),
        TOKENS: engineCap('TOKENS'),
        RUNTIME_MS: engineCap('RUNTIME_MS'),
    };
}

function engineCap(kind: RunCapKind): EffectiveRunCap {
    return { limit: ENGINE_RUN_CAPS[kind], source: 'ENGINE' };
}

/**
 * The minimum of the two ceilings, with a tie attributed to the ENGINE.
 *
 * `>=` rather than `>` is the tie rule, and it is deliberate: see the header
 * for why naming the card on a tie would send an operator to make an edit that
 * cannot change the outcome.
 */
function strictestOf(kind: RunCapKind, cardLimit: number | null): EffectiveRunCap {
    const engineLimit = ENGINE_RUN_CAPS[kind];
    if (cardLimit === null || cardLimit >= engineLimit) {
        return { limit: engineLimit, source: 'ENGINE' };
    }
    return { limit: cardLimit, source: 'POLICY_CARD' };
}

// ─── The halt ───────────────────────────────────────────────────────

/**
 * A cap fired. EVERY field here exists because an operator reading a halted run
 * asks a different question that needs it, and none of them is content.
 *
 * `refused` is the one that makes this a halt rather than a trim. It is the
 * units the caller asked for and did NOT get — all of them, never a remainder
 * after a partial grant, because there are no partial grants.
 */
export interface RunCapHalt {
    readonly kind: RunCapKind;
    readonly limit: number;
    readonly source: RunCapSource;
    /** Units already spent when the refusal happened. Never exceeds `limit`. */
    readonly used: number;
    /** Units this charge asked for. NONE of them were granted. */
    readonly refused: number;
    /** Operator-facing, and it says the work stopped rather than shrank. */
    readonly message: string;
}

function haltMessage(
    kind: RunCapKind,
    cap: EffectiveRunCap,
    used: number,
    refused: number,
): string {
    return (
        `Run halted at its ${kind} cap of ${cap.limit} (set by the ${cap.source}). ` +
        `${used} already spent; ${refused} more asked for and NONE granted. ` +
        'The remaining work was not done and was not trimmed to fit — a run that ' +
        'silently continued on a subset nobody chose would be indistinguishable ' +
        'from one that finished.'
    );
}

// ─── The ledger ─────────────────────────────────────────────────────

/**
 * The slice of the clock the runtime cap needs.
 *
 * Injected for the reason `bounded-exec.ts` injects its timers: a wall-clock
 * bound proved by sleeping is a bound proved slowly and flakily, and — the part
 * that actually matters — a runtime check that stops being made looks exactly
 * like one that is being made whenever real time has not passed.
 */
export type RunClock = () => number;

export interface RunBudgetInput {
    caps: EffectiveRunCaps;
    now: RunClock;
    /**
     * When the RUN started, not this segment. The wall-clock cap spans resumes:
     * a run that pauses for a day at a human checkpoint has spent a day.
     */
    startedAtMs: number;
    /**
     * Units earlier segments of the same run already spent.
     *
     * Omitting an axis seeds it at zero, and for a RESUMED run that is a bug
     * with a known shape: `resolveMcpInvocation`'s own `actionsAlready` comment
     * records that a counter starting at zero per segment hands a run with
     * three checkpoints four budgets. Seed every axis you can seed durably.
     */
    spent?: Partial<Record<CountedRunCapKind, number>>;
}

export interface RunBudget {
    readonly caps: EffectiveRunCaps;
    /**
     * Spend `units` on `kind`, ALL OR NOTHING.
     *
     * Returns `null` when the units were granted and the ledger advanced, or a
     * `RunCapHalt` when they were not — in which case the ledger did NOT
     * advance and nothing was partially applied.
     *
     * `RUNTIME_MS` takes `0`: the clock has already spent whatever it has spent,
     * so the caller is asking "am I still inside the deadline?" rather than
     * requesting anything.
     */
    charge(kind: RunCapKind, units: number): RunCapHalt | null;
    /** Units spent so far. For `RUNTIME_MS`, elapsed wall-clock. */
    used(kind: RunCapKind): number;
    /** Units still available. Never negative. */
    remaining(kind: RunCapKind): number;
}

export function createRunBudget(input: RunBudgetInput): RunBudget {
    const { caps, now, startedAtMs } = input;
    const counters: Record<CountedRunCapKind, number> = {
        STEPS: input.spent?.STEPS ?? 0,
        TOOL_CALLS: input.spent?.TOOL_CALLS ?? 0,
        PROPOSALS: input.spent?.PROPOSALS ?? 0,
        TOKENS: input.spent?.TOKENS ?? 0,
    };

    const used = (kind: RunCapKind): number =>
        kind === 'RUNTIME_MS' ? now() - startedAtMs : counters[kind];

    return {
        caps,
        used,
        remaining(kind: RunCapKind): number {
            return Math.max(0, caps[kind].limit - used(kind));
        },
        charge(kind: RunCapKind, units: number): RunCapHalt | null {
            const cap = caps[kind];
            const spent = used(kind);
            // A cap of N grants exactly N units: the Nth is inside the budget
            // and the one that would make N+1 is refused. Same `+1 >` boundary
            // `evaluateCardReach` uses for the card's own per-run budget, so the
            // two budgets bind on the same call rather than one call apart.
            if (spent + units > cap.limit) {
                return {
                    kind,
                    limit: cap.limit,
                    source: cap.source,
                    used: spent,
                    refused: units,
                    message: haltMessage(kind, cap, spent, units),
                };
            }
            if (kind !== 'RUNTIME_MS') counters[kind] = spent + units;
            return null;
        },
    };
}
