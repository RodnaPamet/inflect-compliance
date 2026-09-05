/**
 * The live tool DEFINITIONS this build carries, as one list.
 *
 * `tool-catalogue.ts` is the leaf list of tool NAMES and stays that way — its
 * whole reason for existing is that an admin route granting a tool should not
 * drag the dashboard cache and the proposal queue in behind it. This module is
 * the opposite trade, made once and deliberately: the manifest-approval surface
 * needs the DESCRIPTIONS and the SCHEMAS, which only the registries hold, so it
 * pays the import cost that the name list refuses.
 *
 * Nothing on the hot path imports this. The MCP funnel already has the tool
 * object in hand, and the boundary store works from hashes; this is read by the
 * admin usecase, once per request, on a route a person clicks.
 */
import { READ_TOOLS } from './tools/registry';
import { PROPOSE_TOOLS } from './tools/propose-tools';
import type { ToolDefinition } from './tool-manifest';

/**
 * Every tool `tools/list` can advertise, read and propose alike, in catalogue
 * order. Derived from the registries rather than restated, so a tool cannot be
 * added to the server and left out of the approval surface — which would leave
 * it permanently unpinnable, i.e. permanently unmonitored, with no symptom.
 */
export function allToolDefinitions(): ToolDefinition[] {
    return [
        ...READ_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        })),
        ...PROPOSE_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        })),
    ];
}

/** One tool's live definition, or `null` when this build does not define it. */
export function toolDefinitionByName(name: string): ToolDefinition | null {
    return allToolDefinitions().find((d) => d.name === name) ?? null;
}
