/**
 * THE TWO PER-TURN CAPS, RESOLVED (#4594, owner decision 3 of 2026-11-13).
 *
 * Two numbers bound what one model turn may start:
 *
 *   delegations per turn  `delegate` calls in one turn of a Tool Runner parent,
 *                         `task` operations in one turn of a Flue parent;
 *   tool calls per turn   every `tool_use` block in one Tool Runner turn —
 *                         funnel tools, `activate_skill` and `delegate` alike.
 *
 * An organization sets the CEILING of each for every workspace under it
 * (`Organization.agentMaxSubagentsPerTurn` / `agentMaxToolCallsPerTurn`), and a
 * workspace may only NARROW it (`TenantSecuritySettings`, same names). The
 * value that applies is `min(ceiling, workspace)`, per cap, and a NULL
 * workspace value follows the ceiling. A workspace with no organization takes
 * the product defaults as its ceiling, which is what it had before #4594.
 *
 * PURE — no database, no Prisma, no runtime import — because the Flue engine
 * carries the delegation value into its execution interceptor, which runs in
 * the ESM graph where `pg` will not load. The read is `turn-caps-policy.ts`.
 *
 * Every resolved value carries its BASIS, so a page can say why a number is
 * what it is rather than show a number nobody can account for.
 */
import { DEFAULT_MAX_SUBAGENTS_PER_TURN } from './subagent-fanout';

/** The product default ceiling for delegations per turn: the fan-out cap's. */
export const DEFAULT_DELEGATIONS_PER_TURN = DEFAULT_MAX_SUBAGENTS_PER_TURN;
/**
 * The product default ceiling for tool calls per turn: one, the serial request
 * the Tool Runner engine sent before #4594 (`disable_parallel_tool_use`).
 */
export const DEFAULT_TOOL_CALLS_PER_TURN = 1;

/**
 * The ranges both the database CHECKs and the writers hold. The delegation
 * floor is 0 (no delegation, readably), the tool-call floor is 1 (a turn that
 * can call no tool is a different engine, not a narrowing), and both tops are
 * 10: a turn cannot start more delegations than tool calls.
 */
export const DELEGATIONS_PER_TURN_MIN = 0;
export const TOOL_CALLS_PER_TURN_MIN = 1;
export const TURN_CAP_MAX = 10;

export type TurnCapKey = 'delegationsPerTurn' | 'toolCallsPerTurn';
export const TURN_CAP_KEYS: readonly TurnCapKey[] = ['delegationsPerTurn', 'toolCallsPerTurn'];

/** The lowest value each cap may hold, by key. */
export const TURN_CAP_MIN: Readonly<Record<TurnCapKey, number>> = {
    delegationsPerTurn: DELEGATIONS_PER_TURN_MIN,
    toolCallsPerTurn: TOOL_CALLS_PER_TURN_MIN,
};

const DEFAULTS: Readonly<Record<TurnCapKey, number>> = {
    delegationsPerTurn: DEFAULT_DELEGATIONS_PER_TURN,
    toolCallsPerTurn: DEFAULT_TOOL_CALLS_PER_TURN,
};

/**
 * What a settings read that FAILED resolves to: the narrowest safe value of
 * both. No delegation (owner decision of 2026-11-12, which the fan-out cap
 * already held) and one tool call (its twin, 2026-11-13): never wider than any
 * choice an organization or a workspace can have stored.
 */
export const FAILED_READ_TURN_CAPS: Readonly<Record<TurnCapKey, number>> = {
    delegationsPerTurn: 0,
    toolCallsPerTurn: 1,
};

/**
 * Why a cap is what it is.
 *
 *   ORGANIZATION_CEILING  the organization's ceiling applies: the workspace has
 *                         not narrowed (NULL), or its value is above the ceiling
 *   WORKSPACE             the workspace narrowed, to this value or lower
 *   NO_ORGANIZATION       the workspace belongs to no organization, and the
 *                         product default is its ceiling
 *   FAILED_READ           the settings could not be read; the narrowest value
 */
export type TurnCapBasis = 'ORGANIZATION_CEILING' | 'WORKSPACE' | 'NO_ORGANIZATION' | 'FAILED_READ';

export interface ResolvedTurnCap {
    /** The value that applies. */
    readonly value: number;
    readonly basis: TurnCapBasis;
    /** The ceiling the value was taken under: the organization's, or the product default. */
    readonly ceiling: number;
    /** What the workspace stored, or null when it has not narrowed. */
    readonly workspace: number | null;
}

export type TurnCaps = Readonly<Record<TurnCapKey, ResolvedTurnCap>>;

export interface TurnCapInputs {
    /** The organization's two ceilings, or null when the workspace has none. */
    readonly organization: { readonly delegationsPerTurn: number; readonly toolCallsPerTurn: number } | null;
    /**
     * The workspace's two stored values, or null when it has no settings row:
     * an ABSENT row narrows nothing.
     */
    readonly workspace: {
        readonly delegationsPerTurn: number | null;
        readonly toolCallsPerTurn: number | null;
    } | null;
}

/** A whole number at or above `min`, or null for anything that is not one. */
function wholeAtLeast(value: unknown, min: number): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.max(min, Math.floor(value));
}

function resolveOne(key: TurnCapKey, input: TurnCapInputs): ResolvedTurnCap {
    const min = TURN_CAP_MIN[key];
    // An organization's ceiling the CHECK forbids (it cannot be stored) reads as
    // the product default, clamped into the range: never wider than the top,
    // and never a silent "no tool calls".
    const orgValue = input.organization ? wholeAtLeast(input.organization[key], min) : null;
    const ceiling = Math.min(orgValue ?? DEFAULTS[key], TURN_CAP_MAX);
    const ceilingBasis: TurnCapBasis = input.organization ? 'ORGANIZATION_CEILING' : 'NO_ORGANIZATION';
    // A workspace value that is not a whole number at or above the floor narrows
    // nothing: a negative is a typo, not a stricter choice.
    const workspace = input.workspace ? wholeAtLeast(input.workspace[key], min) : null;
    if (workspace !== null && workspace <= ceiling) {
        return { value: workspace, basis: 'WORKSPACE', ceiling, workspace };
    }
    return { value: ceiling, basis: ceilingBasis, ceiling, workspace };
}

/** The two caps that apply, each the lower of the ceiling and the workspace's value. */
export function resolveTurnCaps(input: TurnCapInputs): TurnCaps {
    return {
        delegationsPerTurn: resolveOne('delegationsPerTurn', input),
        toolCallsPerTurn: resolveOne('toolCallsPerTurn', input),
    };
}

/** What a failed read resolves to: 0 delegations and 1 tool call, basis FAILED_READ. */
export function failedReadTurnCaps(): TurnCaps {
    const one = (key: TurnCapKey): ResolvedTurnCap => ({
        value: FAILED_READ_TURN_CAPS[key],
        basis: 'FAILED_READ',
        ceiling: FAILED_READ_TURN_CAPS[key],
        workspace: null,
    });
    return { delegationsPerTurn: one('delegationsPerTurn'), toolCallsPerTurn: one('toolCallsPerTurn') };
}

/** Is `value` a value this cap may hold? Shared by both writers and their schemas. */
export function isPermittedTurnCap(key: TurnCapKey, value: unknown): value is number {
    return (
        typeof value === 'number'
        && Number.isInteger(value)
        && value >= TURN_CAP_MIN[key]
        && value <= TURN_CAP_MAX
    );
}

/** One tool call's admission against the turn's cap. */
export interface ToolCallsPerTurnVerdict {
    readonly allowed: boolean;
    readonly cap: number;
    /** How many tool calls this turn had already made when this one arrived. */
    readonly madeThisTurn: number;
}

/**
 * Whether one more tool call fits in this turn. A cap below the floor, or not a
 * number at all, reads as the floor (1): the narrowest value, never "unlimited".
 */
export function evaluateToolCallsPerTurn(input: { cap: number; madeThisTurn: number }): ToolCallsPerTurnVerdict {
    const cap = Math.min(wholeAtLeast(input.cap, TOOL_CALLS_PER_TURN_MIN) ?? TOOL_CALLS_PER_TURN_MIN, TURN_CAP_MAX);
    // Floored at zero, so a counter that went wrong cannot buy headroom.
    const made = Math.max(0, Math.floor(input.madeThisTurn));
    return { allowed: made < cap, cap, madeThisTurn: made };
}

/** The refusal code a call past the cap is recorded with. */
export const TOOL_CALLS_PER_TURN_EXCEEDED = 'TOOL_CALLS_PER_TURN_EXCEEDED';

/**
 * What the model is told when a call is past the turn's cap.
 *
 * It reaches the MODEL, so it says what to do instead (carry on with the
 * results it has), or the refusal reads as transient and the model retries it.
 * It names the cap and the count and nothing else: no tool name, no tenant
 * content.
 */
export function toolCallsPerTurnRefusalMessage(verdict: ToolCallsPerTurnVerdict): string {
    return (
        `tool_calls_per_turn_exceeded: this turn has already made ${verdict.madeThisTurn} tool `
        + `call${verdict.madeThisTurn === 1 ? '' : 's'}, the most allowed in one turn `
        + `(${verdict.cap}). Continue with the results you have; a later turn may call tools again.`
    );
}
