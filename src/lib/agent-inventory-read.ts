import type { PermissionSet } from '@/lib/permissions';

/**
 * The two agent read predicates (#3710), in a module of their own so the
 * sidebar can hold one without holding `permissions.ts`.
 *
 * `SidebarNav` renders on every tenant page. A value import from
 * `@/lib/permissions` would put that whole module — the role tables and
 * `PERMISSION_SCHEMA` — into every page's First Load JS, which is what took
 * the risk detail page past its bundle budget. This file imports only a type,
 * which is erased, so a client component pays for two one-line functions.
 * `permissions.ts` re-exports both, so every other caller imports them from
 * there as before.
 */

/**
 * May this permission set READ THE AGENT INVENTORY?
 *
 * The view key, OR the register key. The second term is not redundant: every
 * built-in role that holds `agent_registry` also holds the view key, but a
 * custom role saved before the view key existed carries `agent_registry` and
 * takes the view key from its BASE role — and on a READER or EDITOR base that
 * default is false. Reading the view key alone would take the inventory away
 * from exactly the people an OWNER delegated the register to.
 *
 * One definition, so the usecases, the pages, the sidebar and the views menu
 * cannot disagree about who may read the inventory.
 */
export function mayReadAgentInventory(
    admin: Pick<PermissionSet['admin'], 'agent_registry' | 'agent_registry_view'> | null | undefined,
): boolean {
    return admin?.agent_registry_view === true || admin?.agent_registry === true;
}

/**
 * May this permission set READ AGENT RUNS AND AGENT PROPOSALS?
 *
 * `admin.view`, which gated both pages and their two run routes before the view
 * key existed, OR the view key. Reading, and nothing else: approving or
 * rejecting a proposal and starting, resuming or aborting a run each assert the
 * role-tier write themselves, which the view key does not confer.
 */
export function mayReadAgentActivity(
    admin: Pick<PermissionSet['admin'], 'view' | 'agent_registry_view'> | null | undefined,
): boolean {
    return admin?.view === true || admin?.agent_registry_view === true;
}
