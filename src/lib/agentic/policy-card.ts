/**
 * The agent POLICY CARD — its vocabulary, its ladders, and the one rule that
 * governs an edit.
 *
 * A policy card is a declarative, versioned statement of what ONE registered
 * agent may do, evaluated AT THE TOOL BOUNDARY before anything runs. 1/10
 * recorded what an agent is, 2/10 bounded what its credential may reach, 3/10
 * scored how much authority it has earned. All three are RECORDS. This is where
 * those records become a refusal: a card names the tools, the data rung, the
 * autonomy rung and the action budget, and a call outside them does not execute.
 *
 * ## Why the ladder shape is COPIED from `src/lib/identity/write-ladder.ts`
 *
 * That module exists because the identity write-mode order lived in four places
 * and they agreed only by coincidence — until the clamp moved, at which point
 * `mode !== CLAMP` refused a tenant that was BELOW the clamp rather than above
 * it. The lesson is written into its docstring and it is the reason this file
 * has the shape it has:
 *
 *   • ORDER LIVES IN ONE PLACE. Every dimension below is a `const` tuple (or an
 *     explicit numeric ladder) and INDEX IS THE ORDERING. Nothing compares two
 *     rungs by any route other than `rungOf`.
 *   • COMPARISON IS ORDINAL, NEVER EQUALITY. `!==` is correct only while the
 *     ceiling sits at the top rung, and silently wrong the moment it moves.
 *   • NARROWING IS FREE, WIDENING IS ONE RUNG. Taking authority away is never
 *     the move to refuse; giving it is.
 *   • NO SERVER IMPORTS. An admin client has to be able to render the same
 *     ladder, and importing a value from a usecase would pull prisma into a
 *     browser bundle. The only import here is a TYPE, which is erased.
 *
 * What is NOT copied is the rung vocabulary: identity write modes are not agent
 * policy. Reusing the SHAPE is the instruction; reusing the VALUES would have
 * been a category error.
 *
 * ## Why a card can only ever NARROW
 *
 * Every term the card contributes is a narrowing term over something another
 * layer already decided — the tool grants of 2/10, the autonomy ceiling of
 * `autonomy-ceiling.ts`, the data-access axis the register declares. A card
 * naming a tool nobody granted grants nothing; a card naming autonomy 6 on an
 * agent the tier caps at 2 lifts nothing. This is the same discipline
 * `resolveAutonomyCeiling` states as "a MINIMUM over independent narrowing
 * terms, so no term can widen", and it is what makes adding a card to a live
 * agent safe: the worst a card can do is refuse.
 *
 * The corollary is the one thing to remember when reading a refusal: an ABSENT
 * card contributes NO term. "This agent has no policy card" must not mean "this
 * agent may do nothing", or creating the register's own governance artefact
 * would be the outage. Deny-by-default lives in the tool GRANTS, which are
 * already deny-by-default; the card narrows them further.
 */
import type { AgentDataAccessScope } from '@prisma/client';

// ─── The rule vocabulary ────────────────────────────────────────────

/**
 * Every rule a card can refuse under. Stable codes: they are written into the
 * `AUTHZ_DENIED` audit row, so an operator reading a refusal six months later
 * has to land on the same meaning, and a card's `escalationTriggers` names them
 * verbatim.
 *
 * "Denied" alone is not a finding — it is the absence of one. A refusal that
 * does not say WHICH declaration refused it leaves an operator to guess between
 * a mis-scoped key, an ungranted tool and a spent budget, which are three
 * different investigations with three different fixes.
 */
export const POLICY_CARD_RULES = [
    'TOOL_NOT_PERMITTED',
    'DATA_SCOPE_EXCEEDED',
    'AUTONOMY_EXCEEDED',
    'RUN_ACTION_CAP_EXCEEDED',
    'DAILY_ACTION_CAP_EXCEEDED',
] as const;

export type PolicyCardRule = (typeof POLICY_CARD_RULES)[number];

// ─── The four ladders ───────────────────────────────────────────────

/**
 * The data-access rungs, least-exposing first.
 *
 * This IS `enum AgentDataAccessScope` in `prisma/schema/enums.prisma`, whose own
 * doc comment says the order is load-bearing and the enum is append-only. The
 * tuple is not a second opinion about that order — `tests/unit/policy-card-ladder.test.ts`
 * pins it against the generated enum, so a reorder in the schema fails here
 * rather than silently re-ranking every card.
 */
export const DATA_SCOPE_LADDER = [
    'NONE',
    'READ_METADATA',
    'READ_TENANT_DATA',
    'WRITE_TENANT_DATA',
    'EXTERNAL_EGRESS',
] as const satisfies readonly AgentDataAccessScope[];

/**
 * The card's data rung IS the Prisma enum, not a parallel union.
 *
 * The `satisfies` above proves every rung on the ladder is a real enum member
 * at COMPILE time. The other direction — an enum member with no rung, which
 * would sort to -1 and refuse everything — cannot be proved by a type, so
 * `tests/unit/policy-card-ladder.test.ts` compares the tuple against the
 * generated enum's own values. One check each way; neither alone is the claim.
 */
export type PolicyDataScope = AgentDataAccessScope;

/**
 * The autonomy rungs — the same 0-6 ladder `RegisteredAgent.autonomyLevel` lives
 * on, where the rung IS the number. Spelled out as a tuple anyway so every
 * dimension in this file answers `rungOf` the same way, and so a card carrying
 * `7` is off the ladder rather than merely large.
 */
export const AUTONOMY_LADDER = [0, 1, 2, 3, 4, 5, 6] as const;

/**
 * The action-budget rungs.
 *
 * A budget is a number, and "one rung per widen" is meaningless over the
 * integers — 10 → 1000 is one edit and three orders of magnitude. So the budget
 * is ORDINAL like everything else here: a card may only hold a value on this
 * ladder, and widening moves one step along it.
 *
 * There is deliberately NO unlimited rung. An agent with an unbounded action
 * budget is the thing the card exists to prevent, and "unlimited" written as a
 * very large number at least shows up in a diff as the top rung rather than as
 * a plausible-looking integer.
 *
 * The top rung is 1000 and the run ladder is read against `ENGINE_CAPS.MAX_STEPS`
 * (50) — a per-run budget above that cannot bind, because the engine's own step
 * cap stops the run first. That is fine and deliberate: the two caps bound
 * different things (the engine bounds a workflow, the card bounds an agent
 * across every entry point including direct tool calls), and the card must not
 * import the engine to find that out.
 */
export const ACTION_CAP_LADDER = [0, 1, 5, 10, 25, 50, 100, 250, 500, 1000] as const;

export type ActionCap = (typeof ACTION_CAP_LADDER)[number];

/** Runtime narrowing for a budget read back out of a database column. */
export function isActionCap(value: number): value is ActionCap {
    return (ACTION_CAP_LADDER as readonly number[]).includes(value);
}

/**
 * How many humans stand between this agent and a committed change, strictest
 * first.
 *
 *   SECOND_APPROVER — two distinct humans must approve a proposal.
 *   SINGLE_APPROVER — one human must approve it.
 *   AUTO_APPROVAL   — a rule may approve it with nobody looking.
 *
 * Three rungs rather than the two booleans `reviewRequirementForRiskTier`
 * returns, because the two booleans can express a fourth state that means
 * nothing ("second approver required AND auto-approvable") and an ordinal
 * ladder cannot. The seeding in `policy-card-evaluation.ts` maps the seam's
 * booleans onto these rungs; it does not invent a second answer.
 *
 * NOT read at the tool boundary — a tool call is not an approval. It is
 * DECLARED and PINNED so that when 8/10 builds the review queue, the queue reads
 * the version that was in force when the proposal was made rather than the one
 * in force when somebody got round to reviewing it.
 */
export const APPROVAL_LADDER = ['SECOND_APPROVER', 'SINGLE_APPROVER', 'AUTO_APPROVAL'] as const;

export type ApprovalRung = (typeof APPROVAL_LADDER)[number];

// ─── The card ───────────────────────────────────────────────────────

/**
 * One version of a policy card, as evaluated. Every field is a declaration; none
 * is derived at read time, because a version has to mean the same thing when it
 * is read back as evidence years later.
 */
export interface AgentPolicyCardValue {
    /**
     * The tools this agent may call. INTERSECTED with the 2/10 grant list, never
     * unioned — see the header. An empty list means no tools, which is a
     * deliberate and legible state for a card, unlike an absent card.
     */
    permittedTools: readonly string[];
    /**
     * The highest data-access rung any call may reach. The PERMITTED SET is the
     * prefix of `DATA_SCOPE_LADDER` up to and including this rung — derived, not
     * stored, because the enum's own doc comment says each rung is strictly more
     * exposing than the one above it, so "may write tenant data but may not read
     * it" is not a state the world can be in.
     */
    maxDataScope: PolicyDataScope;
    /** The highest autonomy rung any call may require. */
    maxAutonomyLevel: number;
    /** How many tool calls one run (one invocation) may make. */
    maxActionsPerRun: ActionCap;
    /** How many tool calls this agent may make in one UTC day. */
    maxActionsPerDay: ActionCap;
    /**
     * Which refusals are worth waking somebody for. A refusal always audits;
     * a refusal on a declared trigger additionally carries `escalate: true` into
     * the audit row, which is what an alert keys off.
     *
     * A new card declares ALL of them — quieting one is a widening, and has to
     * be a deliberate rung like every other widening here.
     */
    escalationTriggers: readonly PolicyCardRule[];
    /** How many humans must sign a proposal from this agent. */
    approvalRung: ApprovalRung;
}

/**
 * The two `String[]`/`String` columns, narrowed by MEMBERSHIP rather than cast.
 *
 * One home, used by BOTH the boundary that reads a card and the usecase that
 * edits one. A second narrowing would be a second opinion about what a stored
 * row means, and the two would differ on exactly the rows that matter — the ones
 * carrying a value this build does not recognise.
 *
 * The two defaults point in OPPOSITE directions on purpose. An unrecognised
 * escalation code is DROPPED (it escalates on nothing — the quiet direction, and
 * correct, because the refusal still audits either way). An unrecognised
 * approval rung reads as the STRICTEST (the loud direction, and also correct,
 * because that field decides how many humans sign). Same table, opposite
 * defaults, because they answer different questions.
 */
export function narrowEscalationTriggers(stored: readonly string[]): PolicyCardRule[] {
    return stored.filter((r): r is PolicyCardRule =>
        (POLICY_CARD_RULES as readonly string[]).includes(r),
    );
}

export function narrowApprovalRung(stored: string): ApprovalRung {
    return (APPROVAL_LADDER as readonly string[]).includes(stored)
        ? (stored as ApprovalRung)
        : APPROVAL_LADDER[0];
}

/** The permitted data scopes, as the prefix the max rung implies. */
export function permittedDataScopes(max: PolicyDataScope): readonly PolicyDataScope[] {
    return DATA_SCOPE_LADDER.slice(0, DATA_SCOPE_LADDER.indexOf(max) + 1);
}

// ─── Ordinal helpers ────────────────────────────────────────────────

/**
 * The rung a value sits on, or -1 when this build does not recognise it.
 *
 * ═══ READ THE FAILURE DIRECTION, AS `write-ladder.ts` DOES ═══
 *
 * -1 is the LOWEST rung, so an unrecognised value reads as the LEAST privileged
 * thing on every ladder here. That is the safe direction for all four, and it is
 * the opposite of the identity ladder's `isAboveClamp`, where -1 read as "not
 * above the clamp" and therefore as PERMITTED — the hazard that module's
 * `coerceStoredMode` exists to head off.
 *
 * The difference is not luck, it is the question being asked. There, the rung
 * was the SUBJECT being clamped and low meant allowed. Here, the rung is the
 * CEILING and low means refuse. So a card carrying a value from a newer build
 * refuses calls rather than admitting them, and `isWithinRung` never has to ask
 * whether the value was understood.
 */
function rungOf(ladder: readonly (string | number)[], value: string | number): number {
    return ladder.indexOf(value);
}

/** Is `required` at or below `permitted` on this ladder? Ordinal, never `===`. */
function isWithinRung(
    ladder: readonly (string | number)[],
    required: string | number,
    permitted: string | number,
): boolean {
    const permittedRung = rungOf(ladder, permitted);
    if (permittedRung === -1) return false;
    const requiredRung = rungOf(ladder, required);
    // A REQUIRED rung this build does not recognise is the mirror hazard: it
    // would sort to -1 and pass every ceiling. Refuse instead — the caller is
    // asking for something nothing here can rank.
    if (requiredRung === -1) return false;
    return requiredRung <= permittedRung;
}

/** Is the data rung this call reaches within the card's ceiling? */
export function dataScopeWithinCard(reached: string, permitted: PolicyDataScope): boolean {
    return isWithinRung(DATA_SCOPE_LADDER, reached, permitted);
}

/** Is the autonomy rung this call requires within the card's ceiling? */
export function autonomyWithinCard(required: number, permitted: number): boolean {
    return isWithinRung(AUTONOMY_LADDER, required, permitted);
}

// ─── The one rule that governs an edit ──────────────────────────────

/** Every dimension an edit can move, named for the audit row and the UI. */
export const POLICY_DIMENSIONS = [
    'permittedTools',
    'maxDataScope',
    'maxAutonomyLevel',
    'maxActionsPerRun',
    'maxActionsPerDay',
    'escalationTriggers',
    'approvalRung',
] as const;

export type PolicyDimension = (typeof POLICY_DIMENSIONS)[number];

/** One dimension's movement between two versions of a card. */
export interface PolicyDelta {
    dimension: PolicyDimension;
    /** Positive = widened by that many rungs; negative = narrowed. Never 0. */
    rungs: number;
    /** What moved, in the operator's words. */
    detail: string;
}

/**
 * Every dimension that MOVED between two card versions, with the direction and
 * the distance.
 *
 * A set dimension's distance is its symmetric difference in the widening
 * direction: adding three tools is three rungs, because "one rung per widen" has
 * to mean something for a set or the tool list would be the way around the rule.
 * Adding two and removing five in one edit is a net WIDENING of two — the
 * removals do not pay for the additions, since the point of the rule is that
 * each new reach is looked at on its own.
 */
export function comparePolicyCards(
    from: AgentPolicyCardValue,
    to: AgentPolicyCardValue,
): PolicyDelta[] {
    const deltas: PolicyDelta[] = [];

    const toolsAdded = to.permittedTools.filter((t) => !from.permittedTools.includes(t));
    const toolsRemoved = from.permittedTools.filter((t) => !to.permittedTools.includes(t));
    if (toolsAdded.length > 0) {
        deltas.push({
            dimension: 'permittedTools',
            rungs: toolsAdded.length,
            detail: `grants ${toolsAdded.join(', ')}`,
        });
    }
    if (toolsRemoved.length > 0) {
        deltas.push({
            dimension: 'permittedTools',
            rungs: -toolsRemoved.length,
            detail: `withdraws ${toolsRemoved.join(', ')}`,
        });
    }

    // An escalation trigger REMOVED is a widening — the card stops asking to be
    // told. Sign is therefore inverted against the tool list, which is exactly
    // the kind of thing a reader gets wrong once, so it is stated rather than
    // left to the arithmetic.
    const triggersDropped = from.escalationTriggers.filter(
        (r) => !to.escalationTriggers.includes(r),
    );
    const triggersAdded = to.escalationTriggers.filter(
        (r) => !from.escalationTriggers.includes(r),
    );
    if (triggersDropped.length > 0) {
        deltas.push({
            dimension: 'escalationTriggers',
            rungs: triggersDropped.length,
            detail: `stops escalating on ${triggersDropped.join(', ')}`,
        });
    }
    if (triggersAdded.length > 0) {
        deltas.push({
            dimension: 'escalationTriggers',
            rungs: -triggersAdded.length,
            detail: `starts escalating on ${triggersAdded.join(', ')}`,
        });
    }

    ordinalDelta(deltas, 'maxDataScope', DATA_SCOPE_LADDER, from.maxDataScope, to.maxDataScope);
    ordinalDelta(
        deltas,
        'maxAutonomyLevel',
        AUTONOMY_LADDER,
        from.maxAutonomyLevel,
        to.maxAutonomyLevel,
    );
    ordinalDelta(
        deltas,
        'maxActionsPerRun',
        ACTION_CAP_LADDER,
        from.maxActionsPerRun,
        to.maxActionsPerRun,
    );
    ordinalDelta(
        deltas,
        'maxActionsPerDay',
        ACTION_CAP_LADDER,
        from.maxActionsPerDay,
        to.maxActionsPerDay,
    );
    ordinalDelta(deltas, 'approvalRung', APPROVAL_LADDER, from.approvalRung, to.approvalRung);

    return deltas;
}

function ordinalDelta(
    into: PolicyDelta[],
    dimension: PolicyDimension,
    ladder: readonly (string | number)[],
    from: string | number,
    to: string | number,
): void {
    const fromRung = rungOf(ladder, from);
    const toRung = rungOf(ladder, to);
    // An unrecognised value on either side. `assertOnLadder` refuses the write
    // before this is reached, so arriving here means a row written by a build
    // that knew a rung this one does not. Reported as a widening of the whole
    // ladder's height, which is refused by every step rule below — the same
    // fail-closed direction `rungOf` takes.
    if (fromRung === -1 || toRung === -1) {
        if (from === to) return;
        into.push({
            dimension,
            rungs: ladder.length,
            detail: `moves ${dimension} to a rung this build does not recognise (${String(to)})`,
        });
        return;
    }
    if (fromRung === toRung) return;
    into.push({
        dimension,
        rungs: toRung - fromRung,
        detail: `moves ${dimension} ${String(from)} → ${String(to)}`,
    });
}

/** Why an edit was refused, or `null` when it may proceed. */
export interface LadderRefusal {
    reason: 'MULTI_RUNG_WIDEN' | 'MULTI_DIMENSION_WIDEN';
    message: string;
    /** The widening deltas that caused it, so the message can be rebuilt. */
    widenings: PolicyDelta[];
}

/**
 * May this edit be written?
 *
 * NARROWING IS ALWAYS ALLOWED — any number of dimensions, any distance, in one
 * edit. Taking authority away is never the act to slow down, and a rule that
 * made an operator walk an agent DOWN one rung at a time during an incident is
 * a rule people route around.
 *
 * WIDENING IS ONE RUNG, ON ONE DIMENSION. Not because two rungs are twice as
 * dangerous, but because each rung is a separate decision somebody has to make
 * and sign, and an edit that moves three dimensions at once is reviewed as one
 * decision. This is the `setIdentityWriteMode` rule with more than one axis to
 * apply it to.
 *
 * Narrowings in the SAME edit are not refused and do not offset: an edit may
 * widen one dimension by one rung while narrowing any others as far as it likes.
 */
export function checkLadderStep(
    from: AgentPolicyCardValue,
    to: AgentPolicyCardValue,
): LadderRefusal | null {
    const widenings = comparePolicyCards(from, to).filter((d) => d.rungs > 0);
    if (widenings.length === 0) return null;

    if (widenings.length > 1) {
        return {
            reason: 'MULTI_DIMENSION_WIDEN',
            widenings,
            message:
                `This edit widens ${widenings.length} dimensions at once ` +
                `(${widenings.map((w) => w.detail).join('; ')}). A policy card is ` +
                'widened one dimension at a time, so each new reach is a decision ' +
                'somebody made rather than a line in a larger diff. Narrowing is ' +
                'not restricted — take as much away in one edit as you like.',
        };
    }

    const [only] = widenings;
    if (only.rungs > 1) {
        return {
            reason: 'MULTI_RUNG_WIDEN',
            widenings,
            message:
                `This edit widens ${only.dimension} by ${only.rungs} rungs ` +
                `(${only.detail}). A policy card widens one rung at a time. Save ` +
                'this edit one rung short and repeat it — narrowing back down is ' +
                'always a single step, so the ratchet only ever slows the direction ' +
                'that adds authority.',
        };
    }

    return null;
}
