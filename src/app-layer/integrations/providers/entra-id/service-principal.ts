/**
 * READ AND DISABLE ONE ENTRA SERVICE PRINCIPAL — the only Graph code for this
 * write (#3671, step 2c of the agentic IAM roadmap).
 *
 * Two operations, both addressed by the principal's directory object id:
 *
 *   GET   /servicePrincipals/{id}?$select=…   the state the disable replaces
 *   PATCH /servicePrincipals/{id}              { "accountEnabled": false }
 *
 * ═══ WHO MAY CALL THIS, AND WHO DOES ═══
 *
 * Exactly one module imports it: `usecases/entra-service-principal-dispatch.ts`,
 * which backs the two tools of the OUTBOUND endpoint
 * `src/app/api/mcp/entra-service-principal/route.ts`. That endpoint's only
 * intended client is Inflect's own external-write dispatch, reached over HTTPS
 * through a connection whose rung, pairing and journal govern every call.
 * `tests/guards/service-principal-disable-graph-seam.test.ts` holds the import
 * graph to that shape, so a second caller — a job that "just disables it
 * directly" — fails CI rather than review.
 *
 * ═══ WHY THE DISABLE CAN REFUSE THE PRINCIPAL IT AUTHENTICATES AS ═══
 *
 * `writer.ts` explains why the user-disable writer never sets
 * `selfAccountIds`: it authenticates app-only, so its identity is a service
 * principal, and user-disable candidates are users — "setting
 * `selfAccountIds = [clientId]` would be cosmetic, it would never match".
 * Here it is not cosmetic. The candidates ARE service principals, so the
 * connection's own principal can be one, and disabling it would cut off every
 * Inflect call into this directory, the re-enable included. `disableRefusal`
 * compares the target's `appId` with the connection's `clientId` and refuses.
 *
 * It also refuses a principal whose application is owned by Microsoft's own
 * tenants. The target reaches this code from a scanner's reconciliation, and a
 * first-party principal (Microsoft Graph, Office 365 Exchange Online) is never
 * an agent a customer registered; disabling one breaks the tenant.
 *
 * ═══ THE PERMISSION IS THE OPERATOR'S CONSENT, AND IT IS NOT NARROW ═══
 *
 * Graph's update-servicePrincipal operation takes `Application.ReadWrite.OwnedBy`
 * (only principals the calling app owns) or `Application.ReadWrite.All` as an
 * application permission, and the read takes `Application.Read.All`. Nothing
 * here asks for a scope — a client-credentials token asks for `.default` — so
 * which of these the customer's administrator consents is the whole of the
 * authority, and `docs/implementation-notes/2026-10-18-service-principal-disable.md`
 * records which one is recommended and why that choice is the owner's.
 */
import { getEntraAccessToken } from './index';
import { assertEntraObjectId } from './writer';
import { resilientFetch } from '../../http-resilience';
import { graphHeaders } from '@/lib/http/graph-headers';

const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * The two tenants Microsoft's own first-party applications are registered in.
 *
 * `f8cdef31-…` is the "Microsoft Services" tenant that owns Microsoft Graph,
 * Exchange Online and the rest of the first-party estate; `72f988bf-…` is
 * Microsoft's corporate tenant, which owns some older first-party apps. A
 * principal whose `appOwnerOrganizationId` is either is not a customer agent.
 */
export const MICROSOFT_FIRST_PARTY_TENANT_IDS: ReadonlySet<string> = new Set([
    'f8cdef31-a31e-4b4a-93e4-5f571e91255a',
    '72f988bf-86f1-41af-91ab-2d7cd011db47',
]);

/** One principal as Graph reports it. Identifying fields only. */
export interface ServicePrincipalState {
    readonly id: string;
    readonly appId: string | null;
    readonly displayName: string | null;
    /** `null` when Graph did not say — never read as either value. */
    readonly accountEnabled: boolean | null;
    readonly servicePrincipalType: string | null;
    readonly appOwnerOrganizationId: string | null;
}

/**
 * Why this principal must not be disabled — or null when it may be.
 *
 * PURE and exported, so each refusal is testable without a network and the
 * usecase can explain one BEFORE any request. `clientId` is the connection's
 * own application id.
 */
export function disableRefusal(
    state: ServicePrincipalState,
    connection: { readonly clientId: string },
): string | null {
    if (state.accountEnabled === false) {
        // Refused rather than repeated. A PATCH to a principal that is already
        // disabled changes nothing at the far end, so the journal row would sit
        // ACCEPTED for ever: the reconcile promotes only on a change it can
        // observe, and there would be none. The cheapest place to stop that is
        // before the request goes out — the reasoning `revokeAccessAssignment`
        // gives for refusing to withdraw something nobody holds.
        return (
            'That service principal is already disabled, so there is nothing to disable and '
            + 'nothing was sent.'
        );
    }
    if (state.accountEnabled !== true) {
        return (
            'The directory did not report whether that service principal is enabled, so what a '
            + 'disable would replace cannot be recorded. Nothing was sent.'
        );
    }
    const self = connection.clientId.trim().toLowerCase();
    if (state.appId !== null && self !== '' && state.appId.toLowerCase() === self) {
        return (
            'That service principal is the one this connection authenticates as. Disabling it '
            + 'would cut off every Inflect call into this directory, including the one that '
            + 're-enables it. Nothing was sent.'
        );
    }
    if (
        state.appOwnerOrganizationId !== null
        && MICROSOFT_FIRST_PARTY_TENANT_IDS.has(state.appOwnerOrganizationId.toLowerCase())
    ) {
        return (
            'That service principal belongs to a Microsoft first-party application, which is '
            + 'never a registered agent. Disabling it would break the directory. Nothing was sent.'
        );
    }
    return null;
}

/**
 * Graph's error CODE, never its message — the message routinely embeds the
 * object id, which this subsystem keeps out of logs and refusal text.
 *
 * Duplicated from `entitlement.ts` rather than imported, on that file's own
 * reasoning: the helper is private there, and widening a private helper for a
 * second caller is how it becomes a dependency nobody owns.
 */
function graphErrorCode(status: number, text: string): string {
    try {
        const parsed = JSON.parse(text) as { error?: { code?: string } };
        return parsed.error?.code ?? String(status);
    } catch {
        return String(status);
    }
}

export interface ServicePrincipalClientOptions {
    /** Merged connection config and secrets, as the other Entra modules take it. */
    readonly connection: Record<string, unknown>;
    readonly doFetch?: typeof fetch;
}

export function createEntraServicePrincipalClient(options: ServicePrincipalClientOptions) {
    const connection = options.connection;
    const doFetch = options.doFetch ?? resilientFetch;

    let token: string | null = null;
    async function auth(): Promise<string> {
        if (token) return token;
        token = await getEntraAccessToken(connection, doFetch);
        return token;
    }

    async function graph(
        method: 'GET' | 'PATCH',
        path: string,
        body?: unknown,
    ): Promise<{ ok: boolean; status: number; text: string }> {
        const t = await auth();
        const res = await doFetch(`${GRAPH}${path}`, {
            method,
            headers: graphHeaders(t, {
                Accept: 'application/json',
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            }),
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = res.status === 204 ? '' : await res.text().catch(() => '');
        return { ok: res.ok, status: res.status, text };
    }

    return {
        /**
         * THE PRIOR STATE: one principal, or null when the directory holds no
         * principal with that id.
         *
         * `$select` is explicit and closed. The read is journalled as the state
         * the disable replaces, and an unbounded read would journal credentials
         * metadata, owners and app roles the write does not touch — a record of
         * everything is not a record of this write's before-state.
         *
         * No timestamp, no request id, nothing that differs between two reads of
         * an unchanged principal: the `PROPOSE_ONLY` dispatch compares this
         * answer, canonicalised, against the one a human approved, and a field
         * that always moves would refuse every approved write as drift.
         */
        async readServicePrincipal(servicePrincipalId: string): Promise<ServicePrincipalState | null> {
            const id = assertEntraObjectId(servicePrincipalId);
            const res = await graph(
                'GET',
                `/servicePrincipals/${encodeURIComponent(id)}`
                    + '?$select=id,appId,displayName,accountEnabled,servicePrincipalType,'
                    + 'appOwnerOrganizationId',
            );
            if (res.status === 404) return null;
            if (!res.ok) {
                throw new Error(
                    `Entra service principal read failed (${graphErrorCode(res.status, res.text)})`,
                );
            }
            const o = JSON.parse(res.text || '{}') as Record<string, unknown>;
            if (typeof o.id !== 'string' || o.id === '') {
                // A 200 with no id is not a principal we can describe.
                throw new Error('Entra service principal read returned no id');
            }
            const str = (v: unknown): string | null =>
                typeof v === 'string' && v !== '' ? v : null;
            return {
                id: o.id.toLowerCase(),
                appId: str(o.appId),
                displayName: str(o.displayName),
                accountEnabled: typeof o.accountEnabled === 'boolean' ? o.accountEnabled : null,
                servicePrincipalType: str(o.servicePrincipalType),
                appOwnerOrganizationId: str(o.appOwnerOrganizationId),
            };
        },

        /**
         * THE WRITE: `accountEnabled: false`, and nothing else.
         *
         * One field, on purpose. A disable that also cleared credentials or
         * removed owners would be a larger and irreversible act; this one is
         * undone by setting the same field back, which is what the journal's
         * captured prior state tells an operator to do.
         *
         * Graph answers 204 with no body. A 2xx is taken as "the directory took
         * the change" and NOTHING MORE: the dispatch settles the journal row
         * `ACCEPTED`, and only the reconcile pass, reading the principal back
         * through the paired read, may promote it to `APPLIED`.
         */
        async disableServicePrincipal(servicePrincipalId: string): Promise<void> {
            const id = assertEntraObjectId(servicePrincipalId);
            const res = await graph('PATCH', `/servicePrincipals/${encodeURIComponent(id)}`, {
                accountEnabled: false,
            });
            if (!res.ok) {
                throw new Error(
                    `Entra service principal disable failed (${graphErrorCode(res.status, res.text)})`,
                );
            }
        },
    };
}
