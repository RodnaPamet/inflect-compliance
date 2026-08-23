/**
 * Cross-domain discovery policies.
 *
 * Two surfaces fan a single request out across many entity domains at
 * once — unified search (`usecases/search.ts`) and the traceability
 * graph (`usecases/traceability-graph.ts`). Both used to open with
 *
 *     if (!ctx.role) throw forbidden('Authentication required');
 *
 * which is an AUTHENTICATION check wearing authorization's clothes:
 * `getTenantCtx` populates `ctx.role` on every path (session and API
 * key alike), so the branch was unreachable. The consequence was
 * concrete rather than theoretical — a `TenantCustomRole` carrying
 * `evidence: { view: false }` still got evidence titles back from
 * search, and could still read control/risk/asset labels off the
 * graph, while the corresponding LIST pages refused it.
 *
 * The shape of the fix is per-domain SKIPPING, not an all-or-nothing
 * refusal:
 *
 *   - It matches how the product already behaves. A role that cannot
 *     see evidence does not get an error on every page; it gets a
 *     product without evidence in it.
 *   - It REMOVES a query instead of adding a check. A denied domain
 *     is one fewer `WHERE … ILIKE` against a large table.
 *   - It degrades to something useful. Search still finds your
 *     controls when only evidence is denied.
 *
 * `assertAnyDomainViewable` covers the degenerate end of that scale:
 * a caller who can view NONE of the domains a surface reads is told
 * so, rather than being handed an empty payload that is
 * indistinguishable from "this tenant has no data". No built-in role
 * can reach it — OWNER / ADMIN / EDITOR / AUDITOR / READER all carry
 * `view: true` on every domain in `getPermissionsForRole` — so the
 * population it refuses is exactly the one that should be refused: a
 * custom role (or an API key whose scopes grant nothing here).
 */

import type { RequestContext } from '../types';
import type { PermissionSet } from '@/lib/permissions';
import { forbidden } from '@/lib/errors/types';

/**
 * The `PermissionSet` domains that back a discovery surface. Written as
 * an `Extract` over `keyof PermissionSet` rather than a bare string
 * union so renaming a domain in `permissions.ts` fails to compile here
 * instead of silently producing a never-true lookup.
 */
export type ViewableDomain = Extract<
    keyof PermissionSet,
    | 'controls'
    | 'risks'
    | 'policies'
    | 'evidence'
    | 'assets'
    | 'tasks'
    | 'tests'
    | 'frameworks'
>;

/** Can this caller see rows from `domain` at all? */
export function canViewDomain(ctx: RequestContext, domain: ViewableDomain): boolean {
    return ctx.appPermissions[domain].view === true;
}

/**
 * Refuse a discovery surface whose every domain is denied.
 *
 * The permission lookup is written INLINE in the condition rather than
 * delegated to `canViewDomain` above, and that is deliberate: the
 * layer-2 reachability guard
 * (`tests/guardrails/api-route-has-some-authorization.test.ts`) reads
 * the AST of the condition and only counts a decision as real
 * authorization when it can see a permission bag rooted at the request
 * context. `domains.some((d) => canViewDomain(ctx, d))` passes `ctx` as
 * a bare identifier, which reads to that guard as a role-presence check
 * — the exact classification this change exists to clear. Keep the
 * property access here even though it duplicates one line.
 */
export function assertAnyDomainViewable(
    ctx: RequestContext,
    domains: readonly ViewableDomain[],
    surface: string,
): void {
    if (!domains.some((domain) => ctx.appPermissions[domain].view === true)) {
        throw forbidden(`You do not have permission to view any ${surface}.`);
    }
}
