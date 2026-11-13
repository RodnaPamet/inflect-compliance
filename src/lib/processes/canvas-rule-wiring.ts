/**
 * Which rule a step on an automation canvas configures.
 *
 * An automation flow reads left to right: a Trigger step, maybe some Condition
 * or SLA steps, and an Action or Agent step. Only the last OWNS a rule (one
 * `AutomationRule` per Action/Agent step, linked by `dataJson.ruleId`); the
 * steps before it describe parts of that rule. So a Trigger step's event is the
 * rule's `triggerEvent`, a Condition step's filter is its `triggerFilterJson`,
 * and an SLA step's window is its `slaWindowMinutes`.
 *
 * Until this module, nothing connected a feeding step to its rule. The
 * inspector asked the step for a `ruleId`, which only rule-owning steps ever
 * have, so a Trigger or Condition step could only say it was not synced.
 *
 * Pure and engine-free, so the tldraw selection adapter, the inspector and the
 * tests share one answer, and the server can share the set of owning kinds.
 */

/**
 * THE NODE KINDS THAT OWN A RULE (#3541).
 *
 * A SET, not a constant, and the set is the fix. This was
 * `const ACTION_KIND = 'action'` in two queries and one filter, so when #3471
 * added `agent` as a fifth automation kind — palette entry, taxonomy metadata,
 * canvas renderer — the bridge did not learn about it.
 *
 * `trigger`, `condition` and `slaGate` are deliberately absent. They FEED a
 * rule rather than owning one (see {@link FEEDING_KINDS}); widening this set to
 * them would create a rule per trigger step and break the model.
 */
export const RULE_OWNING_KINDS: ReadonlySet<string> = new Set(['action', 'agent']);

/**
 * The display-only fields `hydrateCanvasFromRules` merges into a step's
 * `dataJson` on load. They describe the rule as it was when the map was read,
 * so a save must not store them on the node, and the version diff must not
 * compare them: a stored version never carries them, so every linked step read
 * as "modified" (#5285). Here rather than in the server sync so the canvas can
 * import it.
 */
export const HYDRATED_DISPLAY_KEYS = ['ruleStatus', 'executionCount', 'ruleSubtitle'] as const;

/** `dataJson` without the hydrated display fields; anything else as given. */
export function withoutHydratedDisplay<T>(dataJson: T): T {
    if (!dataJson || typeof dataJson !== 'object' || Array.isArray(dataJson)) return dataJson;
    const copy = { ...(dataJson as Record<string, unknown>) };
    for (const k of HYDRATED_DISPLAY_KEYS) delete copy[k];
    return copy as T;
}

/** The kinds that configure the rule of the Action or Agent step they lead to. */
export const FEEDING_KINDS: ReadonlySet<string> = new Set(['trigger', 'condition', 'slaGate']);

export interface WiringNode {
    nodeKey: string;
    nodeType: string;
    /** `dataJson.ruleId`, for a rule-owning step that has one. */
    ruleId: string | null;
}

export interface WiringEdge {
    sourceKey: string;
    targetKey: string;
}

export interface FedRules {
    /** The rules this step configures, in the order they were reached. */
    ruleIds: string[];
    /**
     * Action/Agent steps it leads to that have no rule YET: the map has not
     * been saved since they were added. The inspector says "save the map"
     * rather than "connect this step".
     */
    unsavedOwners: number;
}

/**
 * The rules a feeding step configures: follow its outgoing connections through
 * other feeding steps until each path reaches an Action or Agent step.
 *
 * A path stops at a step of any other kind (a document step, a group, a note):
 * a Trigger wired to a plain process step configures nothing. Each step is
 * visited once, so a loop on the canvas cannot hang the inspector.
 */
export function fedRuleIds(startKey: string, nodes: WiringNode[], edges: WiringEdge[]): FedRules {
    const byKey = new Map(nodes.map((n) => [n.nodeKey, n]));
    const out = new Map<string, string[]>();
    for (const e of edges) {
        const list = out.get(e.sourceKey);
        if (list) list.push(e.targetKey);
        else out.set(e.sourceKey, [e.targetKey]);
    }
    const ruleIds: string[] = [];
    const seenRules = new Set<string>();
    let unsavedOwners = 0;
    const visited = new Set<string>([startKey]);
    const queue = [...(out.get(startKey) ?? [])];
    while (queue.length > 0) {
        const key = queue.shift()!;
        if (visited.has(key)) continue;
        visited.add(key);
        const node = byKey.get(key);
        if (!node) continue;
        if (RULE_OWNING_KINDS.has(node.nodeType)) {
            if (node.ruleId) {
                if (!seenRules.has(node.ruleId)) {
                    seenRules.add(node.ruleId);
                    ruleIds.push(node.ruleId);
                }
            } else {
                unsavedOwners++;
            }
            continue;
        }
        if (FEEDING_KINDS.has(node.nodeType)) queue.push(...(out.get(key) ?? []));
    }
    return { ruleIds, unsavedOwners };
}

/** `dataJson.ruleId`, when the step carries one. */
export function ruleIdOfDataJson(dataJson: unknown): string | null {
    if (!dataJson || typeof dataJson !== 'object') return null;
    const v = (dataJson as { ruleId?: unknown }).ruleId;
    return typeof v === 'string' && v.length > 0 ? v : null;
}
