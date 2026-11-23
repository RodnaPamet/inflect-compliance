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
