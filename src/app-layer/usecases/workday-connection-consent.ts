/**
 * Start and complete the Workday OAuth2 consent flow for one connection.
 *
 * ═══ WHY THIS EXISTS (#3595) ═══
 *
 * `providers/workday/token.ts` has had a complete authorization-code lifecycle
 * since it was written — `buildWorkdayAuthorizeUrl`,
 * `exchangeCodeForWorkdayToken`, `refreshWorkdayToken`,
 * `resolveWorkdayAccessToken` — and nothing called the first two. No connect
 * route, no callback, no UI: `grep -rln workday src/app` returned ZERO files
 * against 31 for SharePoint. So a Workday connection could never obtain its
 * first refresh token, and the only live path was the one that refreshes a
 * token the system had no way to acquire.
 *
 * The provider itself was never wrong about this. `validateConnection` already
 * answers "Workday is configured but not yet authorised — complete the OAuth
 * consent to connect", and `listEmployees` already throws the same. Both were
 * telling an operator to do something the product gave them no way to do.
 *
 * ═══ WHAT DIFFERS FROM THE ORANGEHRM PAIR ═══
 *
 * Three things, and each is why this is a sibling rather than a shared helper:
 *
 *  · Workday's endpoints are TENANT-SCOPED paths under the customer host, so
 *    the authorize URL needs `tenant` as well as `host`.
 *  · Workday accepts its client credentials in a Basic header and OrangeHRM
 *    does not (#3594), so the two exchanges differ in their transport.
 *  · Workday INVALIDATES the predecessor refresh token on rotation, which is
 *    why `exchangeCodeForWorkdayToken` refuses a response without one rather
 *    than carrying the old one forward.
 *
 * The refresh token reaches exactly one place: the connection's encrypted
 * secret. It is never logged, never audited and never returned.
 *
 * @module usecases/workday-connection-consent
 */
import { decryptField, encryptField } from '@/lib/security/encryption';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, notFound } from '@/lib/errors/types';
import {
    exchangeCodeForWorkdayToken,
    type WorkdayOAuthClient,
} from '@/app-layer/integrations/providers/workday/token';

import { logEvent } from '../events/audit';
import { assertCanAdmin } from '../policies/common';
import type { RequestContext } from '../types';

/** The provider id, spelled once. */
const WORKDAY_PROVIDER = 'workday';

interface ConnectionCredentials {
    client: WorkdayOAuthClient;
    /** Every stored secret, so the token write can MERGE rather than replace. */
    secrets: Record<string, unknown>;
    name: string;
}

/**
 * Load the OAuth half of a connection, refusing anything not ready to consent.
 *
 * All four fields are checked TOGETHER and before the admin is sent anywhere: a
 * half-configured connection that redirected to Workday would come back with a
 * code it cannot exchange, after the admin had already consented.
 */
async function workdayCredentialsFor(
    ctx: RequestContext,
    connectionId: string,
): Promise<ConnectionCredentials> {
    const connection = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirst({
            where: { id: connectionId, tenantId: ctx.tenantId, provider: WORKDAY_PROVIDER },
            select: { id: true, name: true, configJson: true, secretEncrypted: true },
        }),
    );
    if (!connection) throw notFound('Workday connection not found');

    const config = (connection.configJson ?? {}) as Record<string, unknown>;
    const secrets = connection.secretEncrypted
        ? (JSON.parse(decryptField(connection.secretEncrypted)) as Record<string, unknown>)
        : {};

    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
    const host = str(config.host);
    const tenant = str(config.tenant);
    const clientId = str(config.clientId);
    const clientSecret = str(secrets.clientSecret);

    if (!host || !tenant || !clientId || !clientSecret) {
        throw badRequest(
            'This connection is not ready to authorize. Set the Workday tenant host, the '
            + 'tenant name, the API client id and the client secret on it first.',
        );
    }
    return { client: { host, tenant, clientId, clientSecret }, secrets, name: connection.name };
}

/**
 * The identifiers needed to build an authorize URL. Never the client secret.
 *
 * Returns the host and tenant as well as the client id, because Workday's
 * authorize endpoint is a tenant-scoped path on the customer's own host — and
 * `buildWorkdayAuthorizeUrl` re-validates the host through `assertWorkdayHost`,
 * so a host that passed config validation at save time is checked again at the
 * moment a browser is about to be sent to it.
 */
export async function workdayConsentTarget(
    ctx: RequestContext,
    connectionId: string,
): Promise<{ host: string; tenant: string; clientId: string }> {
    assertCanAdmin(ctx);
    const { client } = await workdayCredentialsFor(ctx, connectionId);
    return { host: client.host, tenant: client.tenant, clientId: client.clientId };
}

/**
 * Exchange the authorization code and attach the token pair.
 *
 * Merged into the existing secrets rather than replacing them, so the
 * `clientSecret` already on file survives — every later refresh needs it, so
 * replacing the blob would not break the connection now but at the first
 * expiry, as an unrelated-looking failure hours later.
 */
export async function completeWorkdayConsent(
    ctx: RequestContext,
    input: { connectionId: string; code: string; redirectUri: string },
): Promise<{ connectionName: string }> {
    assertCanAdmin(ctx);
    if (!ctx.userId) throw badRequest('An authorizing user is required');

    const creds = await workdayCredentialsFor(ctx, input.connectionId);

    const secret = await exchangeCodeForWorkdayToken({
        client: creds.client,
        code: input.code,
        redirectUri: input.redirectUri,
    });

    await runInTenantContext(ctx, async (db) => {
        await db.integrationConnection.update({
            where: { id: input.connectionId },
            data: {
                secretEncrypted: encryptField(
                    JSON.stringify({
                        ...creds.secrets,
                        accessToken: secret.accessToken,
                        refreshToken: secret.refreshToken,
                        expiresAt: secret.expiresAt,
                    }),
                ),
            },
        });

        await logEvent(db, ctx, {
            entityType: 'IntegrationConnection',
            entityId: input.connectionId,
            action: 'WORKDAY_CONNECTION_AUTHORIZED',
            details: `OAuth authorization completed for Workday connection "${creds.name}"`,
            detailsJson: {
                category: 'custom',
                event: 'workday_connection_authorized',
                connectionId: input.connectionId,
                // The tenant identifiers and the client id, which are not
                // credentials. NEVER the refresh token, the access token, the
                // client secret or the code — an audit trail carrying any of
                // them would be a second place to steal the connection from,
                // and it streams to a SIEM.
                workdayHost: creds.client.host,
                workdayTenant: creds.client.tenant,
                clientId: creds.client.clientId,
                // The expiry IS safe and is the one fact worth keeping: it makes
                // "the connection stopped working on the 14th" answerable
                // without reading a secret.
                accessTokenExpiresAt: secret.expiresAt,
                authorizedByUserId: ctx.userId,
            },
        });
    });

    return { connectionName: creds.name };
}
