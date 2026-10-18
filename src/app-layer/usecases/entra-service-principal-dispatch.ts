/**
 * THE USECASE BEHIND THE SERVICE-PRINCIPAL ENDPOINT (#3671, agentic IAM 2c).
 *
 * The outbound endpoint `src/app/api/mcp/entra-service-principal/route.ts`
 * holds no credentials and no database; this module resolves the tenant's one
 * Entra connection, decrypts its secrets, and runs one of two operations
 * against one principal — or refuses, naming why.
 *
 * ═══ THIS IS NOT AN AUTHORITY GATE, AND MUST NOT GROW INTO ONE ═══
 *
 * The consent for a disable is the external-write rung on the CALLING
 * connection (`IntegrationConnection.externalWriteMode`), which
 * `external-write-dispatch` checks — with the pairing, the journal row and,
 * at `AUTOMATIC`, the template's bounds — before it ever opens a socket to this
 * endpoint. This module refuses on CONFIGURATION and on the principal's own
 * facts (already disabled, the connection's own principal, a Microsoft
 * first-party principal), never on who is asking. A second, weaker authority
 * check here is how an endpoint ends up looking protected while permitting
 * more than it said — the shape `entra-grant-dispatch.ts` names for the grant.
 *
 * ═══ AND IT DOES NOT TAKE THE JML WRITE-DIRECTION FLAG ═══
 *
 * `writesEnabled` on an Entra connection reads "Let leaver offboarding DISABLE
 * accounts in this directory". Its subject is a person's account. Reading it as
 * consent to disable an AGENT's principal would grant an authority the checkbox
 * never described; the grant endpoint refuses the same reuse for the same
 * reason. The rung on the outbound connection is the consent.
 *
 * ═══ THE READ RUNS BEFORE THE WRITE, HERE TOO ═══
 *
 * `external-write-dispatch` journals the paired read's answer before sending,
 * for the audit record. This module reads the principal again immediately
 * before the PATCH for a different reason: to refuse a write whose outcome
 * nobody could interpret — an already-disabled principal (the reconcile would
 * never observe a change) or the connection's own principal (a self-lockout).
 */
import { runInTenantContext } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';
import {
    isDirectoryObjectId,
    SERVICE_PRINCIPAL_ENDPOINT_PATH,
} from '@/lib/agentic/service-principal-disable';
import {
    createEntraServicePrincipalClient,
    disableRefusal,
    type ServicePrincipalState,
} from '@/app-layer/integrations/providers/entra-id/service-principal';

import type { RequestContext } from '../types';
import {
    resolveEntraEntitlementConnection,
    type EntraEntitlementRefusal,
} from './entra-grant-dispatch';

/**
 * The operator-facing sentence for a connection refusal.
 *
 * The RESOLUTION is shared with the grant endpoint — one enabled Entra
 * connection, `take: 2` so "the only one" and "the first of several" are
 * distinguishable, secrets decrypted, the three token fields checked by name —
 * because the question "which directory" has one answer per tenant. The
 * SENTENCES are not shared: the grant's copy says "there is no directory to
 * assign access in", which is the wrong thing to tell an operator whose
 * principal disable was refused.
 */
export function describeServicePrincipalConnectionRefusal(r: EntraEntitlementRefusal): string {
    switch (r.kind) {
        case 'no_connection':
            return (
                'No enabled Entra ID connection in this workspace, so there is no directory to '
                + 'disable a service principal in. Connect one under Admin -> Integrations.'
            );
        case 'ambiguous':
            return (
                `${r.count} enabled Entra ID connections are configured. A disable names one `
                + 'directory, and this refuses rather than choosing — disable the connections that '
                + 'should not receive writes.'
            );
        case 'secret_unavailable':
            return (
                'The Entra connection\'s stored credentials are missing or could not be decrypted. '
                + 'Re-enter the client secret on the connection.'
            );
        case 'incomplete_config':
            return (
                `The Entra connection is missing ${r.missing.join(', ')}, which the token exchange `
                + 'requires. Complete the connection configuration.'
            );
        default: {
            const unreachable: never = r;
            return unreachable;
        }
    }
}

const BAD_ID =
    'servicePrincipalId must be the principal\'s directory object id (a GUID). Nothing was sent.';
const NOT_FOUND =
    'The directory holds no service principal with that id, so there is nothing to read or '
    + 'disable. Nothing was sent.';

export type ServicePrincipalReadOutcome =
    | { readonly ok: true; readonly servicePrincipal: ServicePrincipalState }
    | { readonly ok: false; readonly refused: string };

export type ServicePrincipalDisableOutcome =
    | { readonly ok: true }
    | { readonly ok: false; readonly refused: string };

/**
 * THE PRIOR STATE: one principal's identifying facts and whether it is enabled.
 *
 * The answer is what `external-write-dispatch` journals as `priorStateJson`
 * and what the reconcile reads back to decide whether the disable landed, so
 * its shape is parsed in exactly one place, `servicePrincipalFactsOf`.
 */
export async function readServicePrincipalState(
    ctx: RequestContext,
    args: { servicePrincipalId: string },
): Promise<ServicePrincipalReadOutcome> {
    // Shape first, so a bad argument costs no database read and no key material.
    if (!isDirectoryObjectId(args.servicePrincipalId)) return { ok: false, refused: BAD_ID };

    const resolved = await resolveEntraEntitlementConnection(ctx);
    if (resolved.state === 'refused') {
        return { ok: false, refused: describeServicePrincipalConnectionRefusal(resolved.refusal) };
    }
    const client = createEntraServicePrincipalClient({ connection: resolved.connection });
    const state = await client.readServicePrincipal(args.servicePrincipalId);
    if (state === null) return { ok: false, refused: NOT_FOUND };
    return { ok: true, servicePrincipal: state };
}

/**
 * THE WRITE: disable one principal, after refusing every case whose outcome no
 * one could interpret.
 *
 * Graph failures THROW past this function, deliberately. The route turns a
 * throw into a protocol error, `callTool` raises it, and the dispatch settles
 * the row `INDETERMINATE` — the honest claim for a request that may have
 * reached the directory. Returning a refusal instead would read as "nothing
 * changed" about a PATCH whose fate is unknown.
 */
export async function disableServicePrincipal(
    ctx: RequestContext,
    args: { servicePrincipalId: string },
): Promise<ServicePrincipalDisableOutcome> {
    if (!isDirectoryObjectId(args.servicePrincipalId)) return { ok: false, refused: BAD_ID };

    const resolved = await resolveEntraEntitlementConnection(ctx);
    if (resolved.state === 'refused') {
        return { ok: false, refused: describeServicePrincipalConnectionRefusal(resolved.refusal) };
    }
    const client = createEntraServicePrincipalClient({ connection: resolved.connection });

    const state = await client.readServicePrincipal(args.servicePrincipalId);
    if (state === null) return { ok: false, refused: NOT_FOUND };

    const refused = disableRefusal(state, {
        clientId: String(resolved.connection.clientId ?? ''),
    });
    if (refused) return { ok: false, refused };

    await client.disableServicePrincipal(args.servicePrincipalId);

    // NO identifiers: the principal's object id and app id are directory
    // identifiers this subsystem keeps out of logs
    // (`identity-log-identifier-scrub`). The journal row, encrypted, holds them.
    logger.info('entra service principal disable requested', {
        component: 'entra-service-principal-dispatch',
        tenantId: ctx.tenantId,
    });
    return { ok: true };
}

/**
 * Does the authenticating connection name THIS endpoint? Null when it does.
 *
 * `authenticateGrantCaller` proves the token belongs to an enabled `mcp-server`
 * connection in a known tenant. It does not say which endpoint that connection
 * was configured to call, so without this check a token minted for the GRANT
 * endpoint's connection would also reach the disable — and the connection the
 * dispatch wrote the rung on would not be the connection whose authority was
 * used. Each endpoint gets its own connection, so each gets its own rung, its
 * own dwell and its own evidence; this check is what makes that true at the
 * endpoint rather than merely by convention.
 *
 * Compared on the PATH only. The host differs by deployment and is not ours to
 * pin here; the path is ours and fixed.
 */
export async function endpointBindingRefusal(
    ctx: RequestContext,
    connectionId: string,
): Promise<string | null> {
    const row = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirst({
            where: { id: connectionId, tenantId: ctx.tenantId },
            select: { configJson: true },
        }),
    );
    const url = ((row?.configJson ?? {}) as { url?: unknown }).url;
    let path: string | null = null;
    if (typeof url === 'string') {
        try {
            path = new URL(url.trim()).pathname.replace(/\/+$/, '');
        } catch {
            path = null;
        }
    }
    if (path === SERVICE_PRINCIPAL_ENDPOINT_PATH) return null;
    return (
        'That connection is not configured to call this endpoint, so its credential is not '
        + 'accepted here. Each outbound endpoint is reached through its own connection.'
    );
}
