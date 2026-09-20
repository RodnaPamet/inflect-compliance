/**
 * Which engine executes an agent's run — and the two independent switches that
 * both have to agree before it is anything other than the one we wrote.
 *
 * ## The question this answers
 *
 * Every agentic run in this product is executed by code in this repository:
 * `workflow-registry.ts` walks a canned workflow, each step calls `runReadTool`
 * or a propose tool, and the register's controls sit in front of every one of
 * them. Running an agent on an EXTERNAL agent runtime means handing that walk to
 * something we did not write.
 *
 * That is not automatically worse — a real runtime does planning, retries and
 * tool-loop management far better than a hand-rolled walk — but it is only
 * acceptable while every control stays in front of it. So the driver is a SEAM
 * rather than a swap: the external engine is allowed to decide *what to try*,
 * and `runReadTool` still decides *what is permitted*, exactly as it does today.
 *
 * ## Two switches, ANDed, and neither can widen
 *
 *     effective = 'flue'  iff  AGENT_DRIVER_FLUE is on  AND  the tenant is set to FLUE
 *
 * Same shape as the autonomy ceiling, which is a MINIMUM over independent
 * narrowing terms so that no term can widen. Here the operator's process-wide
 * switch and the tenant's own setting each hold a veto:
 *
 *   • the ENV switch is the operator's. It is how a deployment that has not
 *     reviewed the runtime, or one mid-incident, turns the capability off for
 *     every tenant at once without a database write;
 *   • the TENANT switch is the customer's. A tenant that has not agreed to its
 *     agents being executed by third-party code does not get it because another
 *     tenant on the same deployment did.
 *
 * Neither is a default-on. `STATIC` is what you get from: the flag unset, the
 * flag set to anything this module does not recognise, the settings row absent,
 * the column NULL, the column holding a value from a future build, or the
 * column holding junk. **There is no input to this module that produces `flue`
 * by accident.**
 *
 * ## Why `static` is the fail-closed answer rather than an error
 *
 * Refusing to run at all would make an unreadable settings row an outage, and
 * would put the driver decision on the critical path of every agentic request
 * with a failure mode worse than the thing it is guarding. Falling back to the
 * engine we wrote is strictly safer than both alternatives: the run still
 * happens, under controls this repo owns end to end. The fallback is LOGGED at
 * the call site so a tenant silently dropping back to static is visible rather
 * than inferred from absence — the lesson the identity ladder's two
 * metric-only refusals paid for, where a tenant left at `DISABLED` looked
 * identical from inside the product to a dead worker.
 */

/** The engines a run can be executed by. */
export const AGENT_DRIVERS = ['static', 'flue'] as const;

export type AgentDriver = (typeof AGENT_DRIVERS)[number];

/**
 * The fail-closed answer, and the only one this module returns unless BOTH
 * switches explicitly say otherwise. Exported as a named constant so call sites
 * read `=== STATIC_DRIVER` rather than a bare string that a typo turns into a
 * silently different comparison.
 */
export const STATIC_DRIVER: AgentDriver = 'static';

/**
 * The stored per-tenant values. Mirrors the `AgentDriverMode` Prisma enum;
 * spelled here as well so this module has no server-side import and can be held
 * by a client component rendering the admin toggle — the same reason
 * `src/lib/identity/write-ladder.ts` carries the ladder itself.
 */
export const AGENT_DRIVER_MODES = ['STATIC', 'FLUE'] as const;

export type AgentDriverMode = (typeof AGENT_DRIVER_MODES)[number];

/** Narrowing membership test — the one place the mode list is widened to `string`. */
export function isAgentDriverMode(value: string): value is AgentDriverMode {
    return (AGENT_DRIVER_MODES as readonly string[]).includes(value);
}

/**
 * Read the operator's process-wide switch.
 *
 * OPT-IN, and deliberately stricter than the `AI_*_ENABLED` flags beside it in
 * `env.ts`, which default to `'true'` and are read as "not disabled". Those
 * govern features this repo implements; this one governs whether third-party
 * code executes an agent, so it is read as "not enabled" instead. Exactly `'1'`
 * and `'true'` (case-insensitive, trimmed) turn it on. Everything else —
 * including `'yes'`, `'on'`, `'TRUE '` with a stray character, an empty string
 * and an unset variable — leaves it off.
 */
export function flueEnvEnabled(raw: string | null | undefined): boolean {
    if (!raw) return false;
    const normalised = raw.trim().toLowerCase();
    return normalised === '1' || normalised === 'true';
}

/**
 * Coerce whatever the settings column actually holds into a mode.
 *
 * Applied at the READ boundary, before any comparison anywhere — the placement
 * `getIdentityWritePolicy` uses, and for the same reason: a value that reaches
 * a comparison uncoerced is a value some branch will treat as "not the one I am
 * looking for", and every such branch in a permission decision fails permissive.
 *
 * `hasOwnProperty`-style prototype hazards do not arise here because this is a
 * list membership test rather than a table lookup, but the contract is the
 * same — what comes out is a mode, whatever went in.
 */
export function coerceStoredDriverMode(
    stored: string | null | undefined,
): AgentDriverMode {
    if (!stored) return 'STATIC';
    return isAgentDriverMode(stored) ? stored : 'STATIC';
}

/**
 * WHICH DRIVERS THIS BUILD CAN ACTUALLY EXECUTE.
 *
 * The same shape as `DIRECTION_IMPLEMENTED` in `src/lib/identity/write-ladder.ts`,
 * and for the same reason: a capability that is DECLARED and not BUILT must be
 * unreachable by configuration rather than reachable-and-broken. The identity
 * ladder refuses any widen of a direction whose flag is false — that is what
 * makes "the joiner is switched off" a different kind of nothing from "the
 * joiner does not exist".
 *
 * `flue` is false until the adapter lands. Until then both switches can be on
 * and the answer is still `static`, with `DRIVER_NOT_IMPLEMENTED` as the
 * reason — which is a far better state than a tenant flipping a toggle and
 * getting a run that half-executes on an engine that is not there.
 *
 * ONE LINE MOVES when the adapter ships, and it moves in the diff that makes it
 * true.
 */
export const DRIVER_IMPLEMENTED: Readonly<Record<AgentDriver, boolean>> = {
    static: true,
    flue: false,
};

/** The independent terms the decision is composed from. */
export interface AgentDriverTerms {
    /**
     * The operator's process-wide switch, already read through
     * `flueEnvEnabled`. A boolean rather than the raw string so a call site
     * cannot pass `'0'` and have it count as truthy — which is what a bare
     * `Boolean(process.env.AGENT_DRIVER_FLUE)` would do, and is the single most
     * likely way this gate would have been defeated.
     */
    readonly envEnabled: boolean;
    /**
     * The tenant's stored setting, exactly as it came out of the database —
     * `TenantSecuritySettings.agentDriver`, or `null`/`undefined` when the row
     * does not exist. Passed RAW on purpose: coercion happens here, so there is
     * one place it can be forgotten rather than one per caller.
     */
    readonly tenantSetting: string | null | undefined;
}

/**
 * Why a run is on the static driver.
 *
 * Carried BESIDE the decision rather than re-derived, because these are
 * different operator actions with different fixes and an operator reading
 * `static` with no reason cannot tell which lever to pull:
 *
 *   ENV_DISABLED            — the deployment has not turned the capability on.
 *   TENANT_NOT_OPTED_IN     — this customer has not asked for it. Not a fault.
 *   UNRECOGNISED_SETTING    — the column holds a value this build cannot read.
 *                             Reported separately from an honest opt-out even
 *                             though both coerce to STATIC: one is a choice,
 *                             the other is a row written by a build that knew a
 *                             mode this one does not — a downgrade mid-rolling-
 *                             deploy, and something an operator should see.
 *   DRIVER_NOT_IMPLEMENTED  — both switches say FLUE and this build cannot
 *                             execute it. The loudest of the four: it means
 *                             configuration is ahead of code.
 */
export type StaticDriverReason =
    | 'ENV_DISABLED'
    | 'TENANT_NOT_OPTED_IN'
    | 'UNRECOGNISED_SETTING'
    | 'DRIVER_NOT_IMPLEMENTED';

export interface AgentDriverDecision {
    readonly driver: AgentDriver;
    /** `null` only when `driver` is not `static` — no reason is owed for the affirmative case. */
    readonly reason: StaticDriverReason | null;
}

/**
 * Resolve the driver for one run. Total, never throws, and returns `'static'`
 * for every input except the one that names both switches on AND a driver this
 * build can execute.
 *
 * The decision and its reason are produced TOGETHER, in one pass. An earlier
 * shape had `resolveAgentDriver` and `staticDriverReason` as two exported
 * functions walking the same terms independently — which is the four-verbatim-
 * copies failure this repo has already paid for once in the identity ladder:
 * two functions over one set of rules drift, and the one that drifts is the
 * one nothing enforces, which is the log line.
 */
export function resolveAgentDriver(terms: AgentDriverTerms): AgentDriverDecision {
    if (!terms.envEnabled) {
        return { driver: STATIC_DRIVER, reason: 'ENV_DISABLED' };
    }

    const raw = terms.tenantSetting;
    if (coerceStoredDriverMode(raw) !== 'FLUE') {
        return {
            driver: STATIC_DRIVER,
            reason: raw && !isAgentDriverMode(raw) ? 'UNRECOGNISED_SETTING' : 'TENANT_NOT_OPTED_IN',
        };
    }

    if (!DRIVER_IMPLEMENTED.flue) {
        return { driver: STATIC_DRIVER, reason: 'DRIVER_NOT_IMPLEMENTED' };
    }

    return { driver: 'flue', reason: null };
}
