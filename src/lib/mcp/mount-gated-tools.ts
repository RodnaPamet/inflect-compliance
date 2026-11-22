/**
 * READ TOOLS BEHIND A MOUNT GATE — offered only once an evaluation record shows
 * they work (G11 of the AI architecture roadmap: no record, no tool).
 *
 * One tool today: `search_knowledge`, offered only while a passing RAG
 * evaluation record exists for the deployment's retriever revision (vector
 * store Phase 3.5, `app-layer/services/knowledge-search-mount.ts`).
 *
 * A gate answers in three states, and the difference matters to what a run
 * records:
 *
 *   MOUNTED    the tool is in the catalogue like any other read tool.
 *   UNMOUNTED  the feature is configured and nothing has shown it works: the
 *              tool is in no catalogue, and a run that would have been offered
 *              it records `RETRIEVER_NOT_EVALUATED` (`unmountedReadTools`).
 *   ABSENT     the feature is not configured in this deployment at all: the
 *              tool is in no catalogue, and no run records anything about it.
 *
 * It holds each tool's NAME and KEYS (`knowledge-search-descriptor.ts`), never
 * the tool: importing the tool would pull its usecase and the database layer
 * into every engine's offer.
 *
 * A module of its own rather than part of `tools/registry.ts`, and outside
 * `tools/` (whose files the read-suite guardrails treat as tool definitions):
 * the engines' offer (`engine-tools/offer-tools.ts`) asks it on every run, and
 * suites that replace the registry with a few functions must not lose the offer
 * by doing so.
 */
import { getKnowledgeSearchMount } from '@/app-layer/services/knowledge-search-mount';

import { isToolLoadable, type McpInvocation } from './authorize';
import { SEARCH_KNOWLEDGE_KEYS, SEARCH_KNOWLEDGE_TOOL } from './knowledge-search-descriptor';
import { canSee } from './tool-visibility';

export type MountGateState = 'MOUNTED' | 'UNMOUNTED' | 'ABSENT';

/** A gated read tool as the offer needs it: its name, its keys and its gate. Never the tool itself (see the header). */
interface MountGatedReadTool {
    readonly name: string;
    readonly keys: readonly string[];
    readonly state: () => MountGateState;
}

const MOUNT_GATED_READ_TOOLS: readonly MountGatedReadTool[] = [
    { name: SEARCH_KNOWLEDGE_TOOL, keys: SEARCH_KNOWLEDGE_KEYS, state: () => getKnowledgeSearchMount().state },
];

function gateOf(name: string): (() => MountGateState) | undefined {
    return MOUNT_GATED_READ_TOOLS.find((g) => g.name === name)?.state;
}

/** Is this read tool offered — its gate open, or no gate at all? */
export function readToolMounted(name: string): boolean {
    const state = gateOf(name);
    return state === undefined || state() === 'MOUNTED';
}

/**
 * The gated read tools this invocation WOULD load but for an UNMOUNTED gate —
 * exposed, granted, permitted by the card and visible to the acting context,
 * and withheld only because nothing has shown they work. The engines record
 * each as an omission, so a run that was granted the tool says why it was not
 * offered rather than looking as if the grant were missing. A tool whose
 * feature is ABSENT is not listed: the deployment does not have it.
 */
export function unmountedReadTools(inv: McpInvocation): ReadonlyArray<{ readonly name: string }> {
    return MOUNT_GATED_READ_TOOLS.filter((g) => g.state() === 'UNMOUNTED')
        .filter((g) => isToolLoadable(inv, g.name))
        .filter((g) => canSee(inv, g.keys))
        .map((g) => ({ name: g.name }));
}

/** Every gated tool that is not offered now, whatever the reason. */
export function withheldReadToolNames(): string[] {
    return MOUNT_GATED_READ_TOOLS.filter((g) => g.state() !== 'MOUNTED').map((g) => g.name);
}
