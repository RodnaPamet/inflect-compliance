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
 * ── SOME INPUTS ARE NOT THIS PAGE'S TO COLLECT ──────────────────────────────
 *
 * Four workflows declare input that a person on this page cannot sensibly give,
 * and `NOT_STARTED_HERE` names each with the reason. Their buttons stay on the
 * page, disabled and explained — the page's convention for a control the
 * operator cannot use — rather than enabled and certain to be refused:
 *
 *   ad-hoc-question             the question is asked on the Ask page, which
 *                               binds the workspace's designated agent and
 *                               reads the question through its own bounds; a
 *                               run started here has no agent to answer it.
 *   agent-recertification-pack  its access review, page and subject are set by
 *                               an agent access review's pack preparation,
 *                               which also reads the run's steps back; a run
 *                               started by hand prepares nothing.
 *   sap-transaction-review      its `facts` are SAP document facts a connected
 *                               host system supplies as validated JSON.
 *   discovered-agent-review     its input is a discovered agent's internal id,
 *                               and no list of discovered agents exists to pick
 *                               one from.
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
    periodLabel: { kind: 'text', pattern: '^(\\d{4})-(0[1-9]|1[0-2]|Q[1-4])$', maxLength: 7 },
};

/** Why a workflow is not started from this page. Each has a sentence in `agents.runs.notHere`. */
export const NOT_STARTED_HERE_REASONS = [
    'ASK_PAGE',
    'ACCESS_REVIEW_PREPARATION',
    'HOST_SYSTEM_FACTS',
    'NO_PICKER',
    'UNCLASSIFIED_INPUT',
] as const;

export type NotStartedHereReason = (typeof NOT_STARTED_HERE_REASONS)[number];

/** The workflows whose input this page does not collect — see the header for each. */
export const NOT_STARTED_HERE: Readonly<Record<string, NotStartedHereReason>> = {
    'ad-hoc-question': 'ASK_PAGE',
    'agent-recertification-pack': 'ACCESS_REVIEW_PREPARATION',
    'sap-transaction-review': 'HOST_SYSTEM_FACTS',
    'discovered-agent-review': 'NO_PICKER',
};

export interface StartField {
    readonly key: string;
    readonly spec: StartFieldSpec;
}

export type StartPlan =
    | { readonly mode: 'ONE_CLICK' }
    | { readonly mode: 'FORM'; readonly fields: readonly StartField[] }
    | { readonly mode: 'NOT_HERE'; readonly reason: NotStartedHereReason };

/**
 * How the runs page starts `def`.
 *
 * No required input is one click, whatever else is true — the definition's own
 * statement that it needs nothing. `NOT_STARTED_HERE` is asked next, so a
 * workflow listed there is never offered a form even for keys this table could
 * collect (`question` is text, and the Ask page is still where it is asked).
 */
export function startPlanFor(def: {
    readonly key: string;
    readonly requiredInput?: readonly string[];
}): StartPlan {
    const required = def.requiredInput ?? [];
    if (required.length === 0) return { mode: 'ONE_CLICK' };

    const elsewhere = NOT_STARTED_HERE[def.key];
    if (elsewhere) return { mode: 'NOT_HERE', reason: elsewhere };

    const fields: StartField[] = [];
    for (const key of required) {
        // `Object.hasOwn`, so an input named `toString` or `constructor` is
        // unclassified rather than resolved off the prototype.
        const spec = Object.hasOwn(START_FIELDS, key) ? START_FIELDS[key] : undefined;
        if (!spec) return { mode: 'NOT_HERE', reason: 'UNCLASSIFIED_INPUT' };
        fields.push({ key, spec });
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
