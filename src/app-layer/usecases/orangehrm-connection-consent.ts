/**
 * Start and complete the OrangeHRM OAuth2 consent flow for one connection.
 *
 * ═══ WHY THIS EXISTS AT ALL (#3594) ═══
 *
 * `providers/orangehrm` used to need no consent: it minted a token from the
 * stored client credentials on every run. OrangeHRM 5.x does not implement that
 * grant — it enables `AuthCodeGrant` and `RefreshTokenGrant` and nothing else —
 * so a human has to authorize the connection once, and the refresh token that
 * comes back is the credential every later run depends on.
 *
 * ═══ WHY IT IS A COPY OF `mcp-connection-consent` AND NOT A SHARED HELPER ═══
 *
 * The two flows agree on the shape and disagree on every detail that matters:
 * the authorize URL is built from a customer-supplied host through an allowlist
 * rather than from a fixed Microsoft endpoint, the exchange sends its client
 * credentials in the form body rather than a Basic header, and what is stored
 * is a THREE-field token pair rather than a lone refresh token. A shared helper
 * would be parameterised on all three and would read as neither flow. The
 * duplication is 60 lines; the abstraction would be a worse 60.
 *
 * The refresh token reaches exactly one place: the connection's encrypted
 * secret. It is never logged, never audited and never returned.
 *
 * @module usecases/orangehrm-connection-consent
 */
import { decryptField, encryptField } from '@/lib/security/encryption';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, notFound } from '@/lib/errors/types';
import {
    exchangeCodeForOrangeHrmToken,
    type OrangeHrmOAuthClient,
} from '@/app-layer/integrations/providers/orangehrm/token';
import { ORANGEHRM_PROVIDER_ID } from '@/app-layer/integrations/providers/orangehrm';

import { logEvent } from '../events/audit';
import { assertCanAdmin } from '../policies/common';
import type { RequestContext } from '../types';

interface ConnectionCredentials {
    client: OrangeHrmOAuthClient;
    /** Every stored secret, so the token write can MERGE rather than replace. */
    secrets: Record<string, unknown>;
    name: string;
}

/**
 * Load the OAuth half of a connection, refusing anything not ready to consent.
 *
 * The three fields are checked TOGETHER and before the admin is sent anywhere:
 * a half-configured connection that redirected to the instance would come back
 * with a code it cannot exchange, after the admin had already consented — a
 * confusing failure at the worst possible moment.
 */
async function orangeHrmCredentialsFor(
    ctx: RequestContext,
    connectionId: string,
): Promise<ConnectionCredentials> {
    const connection = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirst({
            where: { id: connectionId, tenantId: ctx.tenantId, provider: ORANGEHRM_PROVIDER_ID },
            select: { id: true, name: true, configJson: true, secretEncrypted: true },
        }),
    );
    if (!connection) throw notFound('OrangeHRM connection not found');

    const config = (connection.configJson ?? {}) as Record<string, unknown>;
    const secrets = connection.secretEncrypted
        ? (JSON.parse(decryptField(connection.secretEncrypted)) as Record<string, unknown>)
        : {};

    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
    const host = str(config.baseUrl);
    const clientId = str(config.clientId);
    const clientSecret = str(secrets.clientSecret);

    if (!host || !clientId || !clientSecret) {
        throw badRequest(
            'This connection is not ready to authorize. Set the OrangeHRM instance URL, the '
            + 'OAuth client id and the client secret on it first.',
        );
    }
    return { client: { host, clientId, clientSecret }, secrets, name: connection.name };
}

/**
 * The identifiers needed to build an authorize URL. Never the client secret.
 *
 * Returns the host as well as the client id, because unlike Entra the authorize
 * endpoint lives on the customer's own instance — and it is re-validated
 * through `assertOrangeHrmHost` when the URL is built, so a host that passed
 * config validation at save time is checked again at use time.
 */
export async function orangeHrmConsentTarget(
    ctx: RequestContext,
    connectionId: string,
): Promise<{ host: string; clientId: string }> {
    assertCanAdmin(ctx);
    const { client } = await orangeHrmCredentialsFor(ctx, connectionId);
    return { host: client.host, clientId: client.clientId };
}

/**
 * Exchange the authorization code and attach the token pair.
 *
 * Merged into the existing secrets rather than replacing them, so the
 * `clientSecret` already on file survives — replacing the blob wholesale would
 * silently drop it and break the connection this flow exists to complete, and
 * every later refresh needs it.
 */
export async function completeOrangeHrmConsent(
    ctx: RequestContext,
    input: { connectionId: string; code: string; redirectUri: string },
): Promise<{ connectionName: string }> {
    assertCanAdmin(ctx);
    if (!ctx.userId) throw badRequest('An authorizing user is required');

    const creds = await orangeHrmCredentialsFor(ctx, input.connectionId);

    const secret = await exchangeCodeForOrangeHrmToken({
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
            action: 'ORANGEHRM_CONNECTION_AUTHORIZED',
            details: `OAuth authorization completed for OrangeHRM connection "${creds.name}"`,
            detailsJson: {
                category: 'custom',
                event: 'orangehrm_connection_authorized',
                connectionId: input.connectionId,
                // The instance host and client id, which are not credentials.
                // NEVER the refresh token, the access token, the client secret
                // or the code — an audit trail carrying any of them would be a
                // second place to steal the connection from, and it streams to
                // a SIEM.
                instanceHost: creds.client.host,
                clientId: creds.client.clientId,
                // The expiry IS safe and is the one fact worth keeping: it is
                // what makes "the connection stopped working on the 14th"
                // answerable without reading a secret.
                accessTokenExpiresAt: secret.expiresAt,
                authorizedByUserId: ctx.userId,
            },
        });
    });

    return { connectionName: creds.name };
}
