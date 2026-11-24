/**
 * A workflow's name and description in the reader's language.
 *
 * A `WorkflowDefinition` carries English `name` and `description` — they are
 * also what the agent card and the run record say. The page shows them from
 * `agentWorkflows.<key>.{name,description}`, keyed by the workflow key with
 * every character a message key cannot hold turned into `_`
 * (`access-posture` → `access_posture`). A key the catalog does not hold — a
 * workflow added without copy — shows the definition's own English.
 *
 * `tests/guards/bulgarian-ui-chrome-sources.test.ts` holds the English
 * catalog equal to the registry and refuses a registered workflow with no
 * entry. Client-safe.
 */

/** The catalog key of a workflow key. */
export function workflowMessageKey(workflowKey: string): string {
    return workflowKey.replace(/[^A-Za-z0-9_]/g, '_');
}

/** A translator rooted at `agentWorkflows`, with next-intl's optional `has`. */
export interface WorkflowTranslator {
    (key: string): string;
    has?: (key: string) => boolean;
}

function field(t: WorkflowTranslator, workflowKey: string, name: 'name' | 'description', stored: string): string {
    const key = `${workflowMessageKey(workflowKey)}.${name}`;
    return typeof t.has === 'function' && t.has(key) ? t(key) : stored;
}

export function localizedWorkflowName(workflowKey: string, storedName: string, t: WorkflowTranslator): string {
    return field(t, workflowKey, 'name', storedName);
}

export function localizedWorkflowDescription(workflowKey: string, stored: string, t: WorkflowTranslator): string {
    return field(t, workflowKey, 'description', stored);
}

/*
 * ─── A run's summary ───────────────────────────────────────────────────
 *
 * A run's `summary` is stored as the run wrote it, and it is the record: an
 * audit reads what the run said. Most summaries are the agent's own words.
 * The diagnostic workflow's is not: it is a fixed sentence the PRODUCT builds
 * from three counts, so it is the product's words, and a Bulgarian reader sees
 * it in Bulgarian (`agentWorkflows.diagnostic.summary`). It is recognised by
 * its exact shape, from the one builder that writes it, and re-worded from the
 * counts it carries; anything else is shown exactly as stored.
 */

/** The counts the diagnostic workflow's summary carries. */
export interface DiagnosticCounts {
    controls: number;
    risks: number;
    openTasks: number;
}

/** The stored (English) summary of a diagnostic run. The only writer of it. */
export function diagnosticSummaryText(c: DiagnosticCounts): string {
    return `Posture snapshot — ${c.controls} controls, ${c.risks} risks, ${c.openTasks} open tasks.`;
}

const DIAGNOSTIC_SUMMARY = /^Posture snapshot — (\d+) controls, (\d+) risks, (\d+) open tasks\.$/;

/** A translator rooted at `agentWorkflows` that fills `{name}` values. */
export interface WorkflowSummaryTranslator {
    (key: string, values: Record<string, number>): string;
}

/**
 * A run's summary in the reader's language: the diagnostic workflow's fixed
 * sentence re-worded from its counts, every other summary as stored.
 */
export function localizedRunSummary(
    workflowKey: string,
    summary: string | null,
    t: WorkflowSummaryTranslator,
): string | null {
    if (summary === null || workflowKey !== 'diagnostic') return summary;
    const m = DIAGNOSTIC_SUMMARY.exec(summary);
    if (!m) return summary;
    return t(`${workflowMessageKey(workflowKey)}.summary`, {
        controls: Number(m[1]),
        risks: Number(m[2]),
        openTasks: Number(m[3]),
    });
}
