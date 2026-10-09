/**
 * RESOLVE A TENANT'S ENTRA ENTITLEMENT CLIENT, AND REFUSE NAMING THE REASON.
 *
 * The usecase half of the grant endpoint (#3297). The MCP route above it holds
 * no credentials and no database; this module resolves the connection, decrypts
 * its secrets and hands back a client — or a refusal an operator can act on.
 *
 * ═══ WHY THE REFUSALS ARE A DISCRIMINATED UNION AND NOT A NULL ═══
 *
 * Four things can be wrong and they are fixed by four different people. A null
 * collapses them into "it did not work", which is the shape
 * `resolveTargetPopulation`'s header rejects for its own five outcomes: *"every
 * one of these refuses, and they refuse for reasons an operator fixes
 * differently."* The same applies here, and the one that matters most is
 * `ambiguous`: two enabled Entra connections is not a configuration detail, it
 * is a question about WHICH directory a grant would be written to, and guessing
 * is the one thing this must not do.
 *
 * `resolveDirectoryWriter` already separates `NO_CONNECTION` from
 * `AMBIGUOUS_CONNECTION` for exactly that reason, and this mirrors its taxonomy
 * rather than inventing a second vocabulary for the same facts.
 *
 * ═══ WHY THIS DOES NOT TAKE THE JML WRITE-DIRECTION GATE ═══
 *
 * `directionWriteRefusal(connection, 'leaver' | 'joiner')` guards account
 * lifecycle writes, and an access-package assignment is neither — see
 * `entitlement.ts`'s header on why a grant is not a third `IdentityDirection`.
 * Reusing `writesEnabled` here would be worse than wrong: that flag's own copy
 * says *"Let leaver offboarding DISABLE accounts in this directory"*, so reading
 * it as consent to assign entitlements would grant an authority the checkbox
 * never described — the accidental consent `write-direction.ts` was written to
 * prevent, arriving through a different door.
 *
 * The consent for this path is the external-write rung on the connection
 * (`externalWriteMode`), which `external-write-dispatch` checks before it ever
 * reaches a tool. This module is therefore deliberately NOT a second gate: it
 * resolves and refuses on CONFIGURATION, never on authority. A second, weaker
 * authority check inside a usecase is how a route ends up looking protected
 * while granting more than it said — the shape `external-prior-state-read`'s
 * header names.
 */
import { decryptField } from '@/lib/security/encryption';
import { runInTenantContext } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';
import {
    createEntraEntitlementClient,
    expiryRefusal,
    MAX_GRANT_DAYS,
    type TimeBoundedGrantInput,
    type AssignmentReadResult,
} from '@/app-layer/integrations/providers/entra-id/entitlement';

import type { RequestContext } from '../types';

export const ENTRA_PROVIDER = 'entra-id';

/**
 * Re-exported so the ROUTE can quote the bound in a tool description without
 * importing from `integrations/providers/`.
 *
 * A route reaching into a provider directory is a layer inversion, and the tool
 * description has to carry the number — it is pinned material a human accepts,
 * so leaving the model to infer that a grant is temporary is the one thing the
 * description must not do. One re-export is cheaper than either a second
 * literal (which would drift from the refusal that enforces it) or a route that
 * imports a provider.
 */
export { MAX_GRANT_DAYS } from '@/app-layer/integrations/providers/entra-id/entitlement';

/** Why no client could be built. Four outcomes, four different fixes. */
export type EntraEntitlementRefusal =
    /** No enabled Entra connection in this workspace. */
    | { readonly kind: 'no_connection' }
    /**
     * More than one. REFUSED rather than resolved by recency or id order,
     * because the question "which directory does this grant write to" has no
     * safe default and an operator must answer it.
     */
    | { readonly kind: 'ambiguous'; readonly count: number }
    /** The connection exists but its secret is absent or will not decrypt. */
    | { readonly kind: 'secret_unavailable'; readonly detail: string }
    /** Present and decryptable, but missing a field the token exchange needs. */
    | { readonly kind: 'incomplete_config'; readonly missing: readonly string[] };

export type EntraEntitlementResolution =
    | { readonly state: 'ok'; readonly connection: Record<string, unknown> }
    | { readonly state: 'refused'; readonly refusal: EntraEntitlementRefusal };

/** The operator-facing sentence for a refusal. One place, so the route has none. */
export function describeEntitlementRefusal(r: EntraEntitlementRefusal): string {
    switch (r.kind) {
        case 'no_connection':
            return (
                'No enabled Entra ID connection in this workspace, so there is no directory to ' +
                'assign access in. Connect one under Admin -> Integrations.'
            );
        case 'ambiguous':
            return (
                `${r.count} enabled Entra ID connections are configured. A grant names a ` +
                'directory, and this refuses rather than choosing one — disable the connections ' +
                'that should not receive writes.'
            );
        case 'secret_unavailable':
            return (
                'The Entra connection\'s stored credentials are missing or could not be ' +
                `decrypted (${r.detail}). Re-enter the client secret on the connection.`
            );
        case 'incomplete_config':
            return (
                `The Entra connection is missing ${r.missing.join(', ')}, which the token ` +
                'exchange requires. Complete the connection configuration.'
            );
        default: {
            // A new refusal kind becomes a compile error here rather than an
            // empty sentence in front of an operator.
            const unreachable: never = r;
            return unreachable;
        }
    }
}

/**
 * Find the one enabled Entra connection and merge its decrypted secrets.
 *
 * TENANT-SCOPED through `runInTenantContext`, never a global read — the claim is
 * "this workspace's directory", and a read outside a tenant context is one RLS
 * does not constrain.
 *
 * Reads `take: 2`, not `take: 1`. One row cannot distinguish "the only
 * connection" from "the first of several", and that distinction is the whole
 * point of the `ambiguous` refusal. Same reasoning as
 * `resolveTargetPopulation`'s `MAX_POPULATION_ROWS + 1`: ask for one more than
 * the answer needs, so reaching the bound is detectable.
 */
export async function resolveEntraEntitlementConnection(
    ctx: RequestContext,
): Promise<EntraEntitlementResolution> {
    const rows = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findMany({
            where: { tenantId: ctx.tenantId, provider: ENTRA_PROVIDER, isEnabled: true },
            select: { id: true, configJson: true, secretEncrypted: true },
            orderBy: { id: 'asc' },
            take: 2,
        }),
    );

    if (rows.length === 0) return { state: 'refused', refusal: { kind: 'no_connection' } };
    if (rows.length > 1) {
        return { state: 'refused', refusal: { kind: 'ambiguous', count: rows.length } };
    }

    const row = rows[0];
    let secrets: Record<string, unknown> = {};
    if (row.secretEncrypted) {
        try {
            secrets = JSON.parse(decryptField(row.secretEncrypted)) as Record<string, unknown>;
        } catch (err) {
            // The MESSAGE only. A decrypt failure's cause is useful; its
            // ciphertext is not, and this sentence reaches an operator.
            return {
                state: 'refused',
                refusal: {
                    kind: 'secret_unavailable',
                    detail: err instanceof Error ? err.message : 'unreadable',
                },
            };
        }
    }

    const connection = { ...((row.configJson ?? {}) as Record<string, unknown>), ...secrets };

    // Checked HERE rather than left to the token exchange, so the refusal names
    // the field instead of surfacing as a 401 from Microsoft that reads like
    // revoked credentials. `getEntraAccessToken` makes the same argument about
    // its own pre-flight: an empty client_secret returns 401 invalid_client,
    // which marks the connection credential-failed for what is our own
    // malformed request.
    const missing = (['tenantId', 'clientId', 'clientSecret'] as const).filter(
        (k) => !String(connection[k] ?? '').trim(),
    );
    if (missing.length > 0) {
        return { state: 'refused', refusal: { kind: 'incomplete_config', missing } };
    }

    return { state: 'ok', connection };
}

/** What the grant tool answers with. A refusal is a RESULT, never a throw. */
export type GrantOutcome =
    | { readonly ok: true; readonly requestId: string }
    | { readonly ok: false; readonly refused: string };

/**
 * Assign an access package until a named instant.
 *
 * The expiry refusal is re-checked HERE as well as inside the client, and that
 * is deliberate duplication rather than an oversight: this is the layer that can
 * refuse WITHOUT resolving a connection or decrypting a secret, so a grant with
 * no end date costs no database read and no key material. The client's copy
 * stays because it is the one that protects a direct caller.
 */
export async function grantTimeBoundedAccess(
    ctx: RequestContext,
    input: TimeBoundedGrantInput,
    now: Date = new Date(),
): Promise<GrantOutcome> {
    const bad = expiryRefusal(input, now);
    if (bad) return { ok: false, refused: bad };

    const resolved = await resolveEntraEntitlementConnection(ctx);
    if (resolved.state === 'refused') {
        return { ok: false, refused: describeEntitlementRefusal(resolved.refusal) };
    }

    const client = createEntraEntitlementClient({
        connection: resolved.connection,
        now: () => now,
    });
    const result = await client.requestTimeBoundedAssignment(input);
    if ('refused' in result) return { ok: false, refused: result.refused };

    // NO identifiers. The target's object id, the package id and the policy id
    // are all directory identifiers this subsystem keeps out of logs — the rule
    // `identity-log-identifier-scrub` enforces. The request id is ours to quote.
    logger.info('entra entitlement grant requested', {
        component: 'entra-grant-dispatch',
        tenantId: ctx.tenantId,
        requestId: result.requestId,
        maxGrantDays: MAX_GRANT_DAYS,
    });
    return { ok: true, requestId: result.requestId };
}

export type AssignmentReadOutcome =
    | { readonly ok: true; readonly assignments: AssignmentReadResult }
    | { readonly ok: false; readonly refused: string };

/**
 * The prior state: every assignment of this package to this subject, held or
 * lapsed, each one classified (#3326).
 *
 * The outcome carries `AssignmentReadResult` rather than an array on purpose.
 * An array here invited `assignments.length > 0` as the answer to "do they
 * already have it", which is FALSE for a subject whose assignment expired —
 * and false in the harmful direction, suppressing the grant that would have
 * restored their access.
 *
 * Separate from the grant and not folded into it, because
 * `external-write-dispatch` calls the paired read as its OWN tool call before
 * the write — `setPriorStateRead` requires both halves to be advertised tools on
 * one connection. A read that only existed inside the write would satisfy
 * nothing the pairing checks.
 */
export async function readAccessAssignments(
    ctx: RequestContext,
    args: { targetId: string; accessPackageId: string },
): Promise<AssignmentReadOutcome> {
    const resolved = await resolveEntraEntitlementConnection(ctx);
    if (resolved.state === 'refused') {
        return { ok: false, refused: describeEntitlementRefusal(resolved.refusal) };
    }
    const client = createEntraEntitlementClient({ connection: resolved.connection });
    const assignments = await client.readAssignments(args);
    return { ok: true, assignments };
}
