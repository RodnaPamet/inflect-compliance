/**
 * HOW THE RUNS PAGE STARTS A WORKFLOW — one click, a small form, or not here
 * (#4472, owner decision 2026-10-29).
 *
 * `/agents/runs` lists every registered workflow, and used to start each one by
 * posting `{ workflowKey }` and nothing else. Seven definitions declare
 * `requiredInput`, and `assertRequiredInputPresent` refuses a run without it —
 * so seven of the ten Start buttons could never start a run. The owner's
 * decision was a form for each workflow that needs input, rather than hiding
 * it, built ONCE and driven by the definition's own declaration.
 *
 * ── THE DECLARATION IS `requiredInput`, AND THIS SAYS HOW TO COLLECT IT ────
 *
 * A definition names the keys it cannot run without; it does not say what a
 * key IS. `START_FIELDS` does, keyed on the input NAME rather than on the
 * workflow, so a key means one thing wherever it appears: `frameworkKey` is a
 * framework picked from the catalogue in both workflows that take it. A form is
 * the definition's `requiredInput`, in its order, mapped through this table.
 *
 * ── SOME INPUTS ARE NOT THIS PAGE'S TO COLLECT (owner decision 2026-10-29) ─
 *
 *   ad-hoc-question             `STARTED_ON_ANOTHER_PAGE`: the question is asked
 *                               on the Ask page, which binds the workspace's
 *                               designated agent and reads the question through
 *                               its own bounds; a run started here has no agent
 *                               to answer it. The runs page LINKS there, for a
 *                               person the Ask page admits.
 *   agent-recertification-pack  `NOT_STARTED_HERE`: its access review, page and
 *                               subject are set by an agent access review's pack
 *                               preparation, which also reads the run's steps
 *                               back; a run started by hand prepares nothing.
 *   sap-transaction-review      `NOT_STARTED_HERE`: its `facts` are SAP document
 *                               facts a connected host system supplies as
 *                               validated JSON.
 *
 * The two NOT_STARTED_HERE buttons stay on the page, disabled and explained —
 * the page's convention for a control the operator cannot use — rather than
 * enabled and certain to be refused.
 *
 * ── A PICKER IS OFFERED ONLY TO A CALLER WHO CAN READ ITS LIST ─────────────
 *
 * `discovered-agent-review` takes a discovered agent's internal id, picked from
 * `GET …/admin/agents/discovered`. That list has its own gate, so the field
 * kind names the ability it needs (`FIELD_NEEDS`) and the page says, from the
 * server, whether the caller has it (`StartAbilities`). Without it the plan is
 * `NOT_HERE: NEEDS_AGENT_INVENTORY`, never a picker that can only fail to load.
 *
 * ── FAILS CLOSED ON AN INPUT NOBODY CLASSIFIED ──────────────────────────────
 *
 * A definition that declares a key `START_FIELDS` does not know is
 * `NOT_HERE: UNCLASSIFIED_INPUT`, never a guessed text box. A free-text field
 * for an input that is really an id would invite exactly the request the
 * server will refuse. `tests/unit/agentic/workflow-start-plan.test.ts` walks the
 * registry so a new required input fails CI until somebody classifies it.
 *
 * ── THE SERVER STAYS THE AUTHORITY ──────────────────────────────────────────
 *
 * The form checks only what admission itself refuses — a blank value — plus a
 * format the run's own first step validates (`periodLabel`). Everything else is
 * the server's to refuse, and the page shows that refusal as it is given.
 *
 * Pure data and a pure function, with no imports: a client component calls it,
 * so nothing here may reach a server module or a Node built-in.
 */

/** How one required input is collected on the start form. */
export type StartFieldSpec =
    /** A framework, picked from the catalogue (`GET /frameworks`); the value is its key. */
    | { readonly kind: 'framework' }
    /**
     * A discovered agent, picked from `GET …/admin/agents/discovered`; the
     * value is its `DiscoveredAgent.id`. Needs `StartAbilities.discoveredAgents`.
     */
    | { readonly kind: 'discoveredAgent' }
    /**
     * Typed text. `pattern` is a regular expression SOURCE (a string, so the
     * spec can cross from a server component), checked before the request is
     * sent; the value is trimmed.
     */
    | { readonly kind: 'text'; readonly pattern?: string; readonly maxLength?: number };

/**
 * Every required-input key a start form can collect, by name.
 *
 * `periodLabel`'s pattern is the one `list_audit_workpapers` validates (the
 * audit narrative's first step), so a malformed period is caught before a run
 * row exists rather than failing that step. It is a copy because the source,
 * `PERIOD_LABEL` in `audit-workpaper.ts`, imports `node:crypto` and cannot be
 * reached from the browser; the unit test holds the two equal.
 */
export const START_FIELDS: Readonly<Record<string, StartFieldSpec>> = {
    frameworkKey: { kind: 'framework' },
    discoveredAgentId: { kind: 'discoveredAgent' },
    periodLabel: { kind: 'text', pattern: '^(\\d{4})-(0[1-9]|1[0-2]|Q[1-4])$', maxLength: 7 },
};

/**
 * What the CALLER may read, for the field kinds whose options come from a
 * gated list. Resolved on the server, from the same gates the list's route
 * applies, and handed to the client — never inferred there.
 */
export interface StartAbilities {
    /** May list discovered agents: the edge admits the role to the route AND the inventory key is held. */
    readonly discoveredAgents: boolean;
    /** May open the Ask page: its own gate, `controls.view`. */
    readonly askPage: boolean;
    /**
     * May list the framework catalogue: `frameworks.view`, the one check
     * `GET /frameworks` makes (`assertCanViewFrameworks`; the route has no
     * gate of its own). Every built-in role holds it; a custom role can switch
     * it off (#4533).
     */
    readonly frameworks: boolean;
}

/** The ability a field kind needs, and the reason given when the caller lacks it. */
const FIELD_NEEDS: Readonly<Partial<Record<StartFieldSpec['kind'], {
    readonly ability: keyof StartAbilities;
    readonly reason: NotStartedHereReason;
}>>> = {
    discoveredAgent: { ability: 'discoveredAgents', reason: 'NEEDS_AGENT_INVENTORY' },
    framework: { ability: 'frameworks', reason: 'NEEDS_FRAMEWORK_ACCESS' },
};

/** Why a workflow is not started from this page. Each has a sentence in `agents.runs.notHere`. */
export const NOT_STARTED_HERE_REASONS = [
    'ACCESS_REVIEW_PREPARATION',
    'HOST_SYSTEM_FACTS',
    'NEEDS_AGENT_INVENTORY',
    'NEEDS_ASK_ACCESS',
    'NEEDS_FRAMEWORK_ACCESS',
    'UNCLASSIFIED_INPUT',
] as const;

export type NotStartedHereReason = (typeof NOT_STARTED_HERE_REASONS)[number];

/** The workflows whose input this page does not collect — see the header for each. */
export const NOT_STARTED_HERE: Readonly<Record<string, NotStartedHereReason>> = {
    'agent-recertification-pack': 'ACCESS_REVIEW_PREPARATION',
    'sap-transaction-review': 'HOST_SYSTEM_FACTS',
};

/**
 * The workflows a person starts from ANOTHER page: that page's tenant path,
 * the ability its own gate asks, and the reason given without it. The runs
 * page links there instead of starting a run — and never links a person to a
 * page that would refuse them. The unit test holds each path to a `page.tsx`
 * that exists.
 */
export const STARTED_ON_ANOTHER_PAGE: Readonly<Record<string, {
    readonly path: string;
    readonly ability: keyof StartAbilities;
    readonly reason: NotStartedHereReason;
}>> = {
    'ad-hoc-question': { path: '/agents/ask', ability: 'askPage', reason: 'NEEDS_ASK_ACCESS' },
};

/**
 * The reasons that are about ANOTHER page's gate rather than about starting a
 * run here. The runs page tells a person without write access that first for a
 * run start; for these it does not, because no run is started from this page
 * and a write tier would not change the answer.
 */
export const OTHER_PAGE_REASONS: ReadonlySet<NotStartedHereReason> = new Set(
    Object.values(STARTED_ON_ANOTHER_PAGE).map((o) => o.reason),
);

export interface StartField {
    readonly key: string;
    readonly spec: StartFieldSpec;
}

export type StartPlan =
    | { readonly mode: 'ONE_CLICK' }
    | { readonly mode: 'FORM'; readonly fields: readonly StartField[] }
    | { readonly mode: 'ON_ANOTHER_PAGE'; readonly path: string }
    | { readonly mode: 'NOT_HERE'; readonly reason: NotStartedHereReason };

/**
 * How the runs page starts `def`, for a caller with `abilities`.
 *
 * No required input is one click, whatever else is true — the definition's own
 * statement that it needs nothing. Another page and `NOT_STARTED_HERE` are
 * asked next, so a workflow listed there is never offered a form even for keys
 * this table could collect. Then every declared key must be classified, and
 * every picker it needs readable by this caller.
 */
export function startPlanFor(
    def: { readonly key: string; readonly requiredInput?: readonly string[] },
    abilities: StartAbilities,
): StartPlan {
    const required = def.requiredInput ?? [];
    if (required.length === 0) return { mode: 'ONE_CLICK' };

    if (Object.hasOwn(STARTED_ON_ANOTHER_PAGE, def.key)) {
        const other = STARTED_ON_ANOTHER_PAGE[def.key];
        return abilities[other.ability] === true
            ? { mode: 'ON_ANOTHER_PAGE', path: other.path }
            : { mode: 'NOT_HERE', reason: other.reason };
    }
    if (Object.hasOwn(NOT_STARTED_HERE, def.key)) {
        return { mode: 'NOT_HERE', reason: NOT_STARTED_HERE[def.key] };
    }

    const fields: StartField[] = [];
    for (const key of required) {
        // `Object.hasOwn`, so an input named `toString` or `constructor` is
        // unclassified rather than resolved off the prototype.
        const spec = Object.hasOwn(START_FIELDS, key) ? START_FIELDS[key] : undefined;
        if (!spec) return { mode: 'NOT_HERE', reason: 'UNCLASSIFIED_INPUT' };
        fields.push({ key, spec });
    }
    for (const field of fields) {
        const need = FIELD_NEEDS[field.spec.kind];
        if (need && abilities[need.ability] !== true) return { mode: 'NOT_HERE', reason: need.reason };
    }
    return { mode: 'FORM', fields };
}

/** Why a value cannot be sent yet, or null when it may be. */
export type StartFieldProblem = 'REQUIRED' | 'FORMAT' | null;

/**
 * The form's own check of one value: blank is REQUIRED (what admission
 * refuses), and a `pattern` mismatch is FORMAT. Trimmed first, as the value
 * that is sent is.
 */
export function startFieldProblem(spec: StartFieldSpec, raw: string | undefined): StartFieldProblem {
    const value = (raw ?? '').trim();
    if (value === '') return 'REQUIRED';
    if (spec.kind === 'text' && spec.pattern && !new RegExp(spec.pattern).test(value)) return 'FORMAT';
    return null;
}
