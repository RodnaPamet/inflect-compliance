/**
 * DISCOVERY FOR THE GRANT COMPOSE FORM (#3329).
 *
 * ═══ WHY THIS IS NOT A THIRD TOOL ON THE GRANT ENDPOINT ═══
 *
 * `tests/unit/entra-grant-mcp-endpoint.test.ts` asserts the grant endpoint
 * advertises exactly TWO tools, and says why:
 *
 *     The count is the assertion. A third tool here reaches a privileged
 *     surface whose only intended client is our own dispatch, and checking the
 *     two by name would pass with a third beside them.
 *
 * Adding discovery there would turn that assertion red, and the right response
 * would be to fix the design rather than the number. The dispatch has no use
 * for discovery — it is handed a resolved package id by an approved template.
 *
 * The compose form is a DIFFERENT CALLER with a DIFFERENT AUTHORITY: a human
 * OWNER in a session, not a machine holding a connection token. So it gets a
 * human-facing route behind a human-facing gate, and the two-tool endpoint's
 * safety argument stays intact.
 *
 * ═══ WHAT IT READS, AND WHAT IT DELIBERATELY DOES NOT ═══
 *
 * Access packages, and the assignment policies for ONE package at a time. Not
 * catalogs — see `readAccessPackages` for why grouping by catalog needs an
 * `$expand` that was never measured live.
 */
import {
    createEntraEntitlementClient,
    policyBelongsToPackage,
    type AccessPackageSummary,
    type AssignmentPolicySummary,
    type DiscoveryPage,
} from '@/app-layer/integrations/providers/entra-id/entitlement';
import { logger } from '@/lib/observability/logger';

import {
    describeEntitlementRefusal,
    resolveEntraEntitlementConnection,
} from './entra-grant-dispatch';
import type { RequestContext } from '../types';

/**
 * The outcome shape, which carries the REFUSAL SENTENCE rather than a boolean.
 *
 * Same reasoning as `entra-grant-dispatch`'s four-case union: "no enabled
 * connection", "two enabled connections", "the secret will not decrypt" and
 * "the config is incomplete" are fixed by four different actions, and a form
 * that rendered "could not load" for all four tells an operator nothing.
 */
export type DiscoveryOutcome<T> =
    | { readonly ok: true; readonly page: DiscoveryPage<T> }
    | { readonly ok: false; readonly refused: string };

/** The access packages this tenant has. */
export async function listAccessPackages(
    ctx: RequestContext,
): Promise<DiscoveryOutcome<AccessPackageSummary>> {
    const resolved = await resolveEntraEntitlementConnection(ctx);
    if (resolved.state === 'refused') {
        return { ok: false, refused: describeEntitlementRefusal(resolved.refusal) };
    }
    const client = createEntraEntitlementClient({ connection: resolved.connection });
    const page = await client.readAccessPackages();
    if (page.truncated) {
        // Logged as well as returned. The form shows the operator a notice, but
        // a tenant large enough to truncate is a fact worth having in the log
        // when somebody asks why a package is missing from the list.
        logger.warn('entra discovery: access package list truncated', {
            component: 'entra-entitlement-discovery',
            tenantId: ctx.tenantId,
            returned: page.items.length,
        });
    }
    return { ok: true, page };
}

/**
 * The assignment policies valid for one package.
 *
 * FILTERS OUT a policy that does not belong to the requested package, rather
 * than trusting the server-side `$filter` alone. Two reasons:
 *
 *   1. it is the check that closes the undetectable-swap case — `accessPackageId`
 *      and `assignmentPolicyId` are both opaque GUIDs, so a form offering
 *      policies from the wrong package would compose a grant that Graph
 *      ACCEPTS and that grants the wrong thing;
 *   2. the filter is evaluated by the far end, and this is the one place that
 *      can verify the answer against what was asked.
 *
 * A policy whose `accessPackageId` came back null is dropped, because an absent
 * answer is not a yes.
 */
export async function listAssignmentPolicies(
    ctx: RequestContext,
    accessPackageId: string,
): Promise<DiscoveryOutcome<AssignmentPolicySummary>> {
    const resolved = await resolveEntraEntitlementConnection(ctx);
    if (resolved.state === 'refused') {
        return { ok: false, refused: describeEntitlementRefusal(resolved.refusal) };
    }
    const client = createEntraEntitlementClient({ connection: resolved.connection });
    const page = await client.readAssignmentPolicies(accessPackageId);
    const kept = page.items.filter((p) => policyBelongsToPackage(p, accessPackageId));
    if (kept.length !== page.items.length) {
        // Not silent. The far end answered a filtered question with rows that
        // do not satisfy the filter, which is worth knowing about the far end.
        logger.warn('entra discovery: dropped policies not belonging to the requested package', {
            component: 'entra-entitlement-discovery',
            tenantId: ctx.tenantId,
            returned: page.items.length,
            kept: kept.length,
        });
    }
    return { ok: true, page: { items: kept, truncated: page.truncated } };
}
