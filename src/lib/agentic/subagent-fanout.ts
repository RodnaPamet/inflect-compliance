/**
 * THE FAN-OUT CAP: how many subagents one parent TURN may delegate to (#3473).
 *
 * PURE — no database, no Prisma, no runtime import — because the only place
 * this can be enforced is inside the Flue execution interceptor, which runs in
 * the ESM graph where `pg` will not load. The cap's VALUE is resolved by the
 * driver and travels in the run binding beside the tools and the skills; this
 * module is the arithmetic and the sentence.
 *
 * ## Why the runtime's own limit is not enough
 *
 * Measured against `@flue/runtime` 2.1.1: `MAX_DELEGATION_DEPTH = 4`, a
 * module-level `const` in its `src/session.ts`, not configurable and not
 * exported. So DEPTH is bounded for us whether we ask or not — and the owner's
 * decision (2026-10-15) tightens it to 1, which is our code's job rather than
 * the runtime's.
 *
 * FAN-OUT has no runtime bound at all. Nothing in the runtime limits how many
 * `task` operations one turn may start, which leaves `ENGINE_CAPS`
 * (`MAX_STEPS 50`, `MAX_TOKENS 200_000`) as the only thing standing between a
 * parent and spending its whole run in a single delegation burst.
 *
 * That is a real bound and it is the wrong SHAPE. A budget bound says "you may
 * do this until the money runs out"; a structural bound says "not like that".
 * The difference shows up in what an operator reads afterwards: a run that
 * burned 200k tokens on one fan-out and a run that burned 200k doing the work
 * are indistinguishable by their totals.
 *
 * ## Why the cap is per TURN and not per run
 *
 * Per-run would be a second, weaker spelling of the token budget: a long run
 * legitimately consults specialists on several turns, and a per-run cap either
 * refuses that or is set so high it refuses nothing. The thing worth bounding
 * is the BURST — one model turn deciding to ask five specialists at once — so
 * the count resets with the turn, and `ENGINE_CAPS` keeps bounding the whole.
 */

/**
 * The product default, mirrored from the database default so the two cannot be
 * read apart.
 *
 * `TenantSecuritySettings.agentMaxSubagentsPerTurn` is `NOT NULL DEFAULT 3`,
 * so in practice every tenant has a value and this constant is never the
 * operative one. It exists for the gap a type cannot close: a binding built
 * from a row read before the column existed, or by a test that did not set it,
 * must still carry a NUMBER rather than `undefined` — and the number it
 * carries has to be the safe one.
 *
 * `tests/unit/subagent-fanout.test.ts` asserts this equals the schema's
 * default, so the mirror is checked rather than hoped for.
 */
export const DEFAULT_MAX_SUBAGENTS_PER_TURN = 3;

export interface FanOutVerdict {
    allowed: boolean;
    /** The cap in force. Always a number — there is no "no cap" for this one. */
    cap: number;
    /** How many delegations this turn has already started. */
    delegatedThisTurn: number;
    /** How many more this turn may start. */
    headroom: number;
}

/**
 * Coerce a stored cap into the number the comparison uses.
 *
 * NO `null` ARM, which is the one place this differs from `normaliseCap` in
 * `run-concurrency.ts` — and the difference is the whole design. There, `null`
 * is the configured meaning of "no cap", because the thing being capped
 * already runs and defaulting it would refuse live work. Here nothing can
 * delegate yet, so a default restricts nothing, and the owner's decision was a
 * cap DEFAULTING LOW. A `null` arm would reintroduce "unlimited" as a
 * reachable state through the back door.
 *
 * A negative or non-finite value falls back to the DEFAULT rather than to
 * zero or to infinity. Zero would be a silent kill switch written by a typo;
 * infinity would be a silent bypass. The default is the only fallback that is
 * neither.
 */
export function normaliseFanOutCap(cap: number | null | undefined): number {
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0) {
        return DEFAULT_MAX_SUBAGENTS_PER_TURN;
    }
    return Math.floor(cap);
}

export function evaluateFanOut(input: {
    cap: number | null | undefined;
    delegatedThisTurn: number;
}): FanOutVerdict {
    const cap = normaliseFanOutCap(input.cap);
    // FLOORED AT ZERO, so a caller that lost count cannot buy headroom with a
    // negative. The counter is incremented by the interceptor and a bug there
    // must not become a bypass here.
    const delegated = Math.max(0, Math.floor(input.delegatedThisTurn));
    return {
        allowed: delegated < cap,
        cap,
        delegatedThisTurn: delegated,
        headroom: Math.max(0, cap - delegated),
    };
}

/**
 * What the model is told when the cap refuses a delegation.
 *
 * THIS STRING REACHES THE MODEL, not an operator — it is the `task` tool's
 * error, and the next thing that happens is the model deciding what to do
 * about it. So it says what to do instead: carry on without the delegate.
 * Without that, a refusal reads as a transient failure and the model retries
 * it, spending the turn on a call that cannot succeed.
 *
 * It also lands in the step ledger, which is the half an operator reads. That
 * is why it names the CAP and the COUNT: the owner's condition for making this
 * a knob was that the knob's effect be visible when it bites, rather than
 * looking like a model that chose not to delegate.
 *
 * It names no other delegate and no tenant content. A tool error is the
 * loosest-held string in the system — it crosses into the model's context and
 * into logs — and `no-raw-prompt-logging` is the guard that cares.
 */
export function fanOutRefusalMessage(verdict: FanOutVerdict): string {
    if (verdict.cap === 0) {
        return (
            'delegation_disabled: this workspace does not permit delegating to '
            + 'subagents. Do not retry — complete the task yourself, or say which '
            + 'part you cannot do without a specialist.'
        );
    }
    return (
        `delegation_limit_reached: this turn has already delegated to `
        + `${verdict.delegatedThisTurn} subagent(s) and the limit is ${verdict.cap}. `
        + 'Do not retry — use what those delegates returned, or continue without '
        + 'another one. A later turn may delegate again.'
    );
}
