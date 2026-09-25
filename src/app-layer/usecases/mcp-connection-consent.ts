/**
 * Authorizing this deployment against an external MCP server behind Entra.
 *
 * ## Why there is a flow at all, rather than a field to paste into
 *
 * The credential that keeps a connection alive is a REFRESH token, and a
 * refresh token cannot be typed — it exists only as the result of a human
 * signing in and consenting. The alternative shipped first and was worse: an
 * access token pasted into a field, which works through the test button and
 * dies an hour later as a 401 somebody has to diagnose.
 *
 * ## What the admin has already done
 *
 * The connection exists, carrying the server URL, the Entra tenant ID, the
 * client ID and the app registration's secret. What it lacks is the one thing
 * only a sign-in produces. So this flow ATTACHES a credential to an existing
 * connection; it never creates one, and it never edits the URL.
 *
 * ## What is never written down
 *
 * The refresh token reaches exactly one place: the connection's encrypted
 * secret blob. Not the audit row, not a log line, not the redirect URL. The
 * audit entry records THAT a named admin authorized this connection and when —
 * which is the accountable fact — and nothing that could be replayed.
 */
import { decryptField, encryptField } from '@/lib/security/encryption';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, notFound } from '@/lib/errors/types';
import { exchangeCodeForRefreshToken } from '@/app-layer/integrations/mcp/token';
import { MCP_SERVER_PROVIDER_ID } from '@/app-layer/integrations/providers/mcp-server-provider';

import { logEvent } from '../events/audit';
import { assertCanAdmin } from '../policies/common';
import type { RequestContext } from '../types';

interface ConnectionCredentials {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    secrets: Record<string, unknown>;
    name: string;
}

/**
 * Load the Entra half of a connection, refusing anything not ready to consent.
 *
 * The three fields are checked TOGETHER and before the admin is sent anywhere:
 * a half-configured connection that redirected to Microsoft would come back
 * with a code it cannot exchange, after the admin had already consented — a
 * confusing failure at the worst possible moment.
 */
async function entraCredentialsFor(
    ctx: RequestContext,
    connectionId: string,
): Promise<ConnectionCredentials> {
    const connection = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirst({
            where: { id: connectionId, tenantId: ctx.tenantId, provider: MCP_SERVER_PROVIDER_ID },
            select: { id: true, name: true, configJson: true, secretEncrypted: true },
        }),
    );
    if (!connection) throw notFound('MCP server connection not found');

    const config = (connection.configJson ?? {}) as Record<string, unknown>;
    const secrets = connection.secretEncrypted
        ? (JSON.parse(decryptField(connection.secretEncrypted)) as Record<string, unknown>)
        : {};

    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
    const tenantId = str(config.tenantId);
    const clientId = str(config.clientId);
    const clientSecret = str(secrets.clientSecret);

    if (!tenantId || !clientId || !clientSecret) {
        throw badRequest(
            'This connection is not ready to authorize. Set the Entra tenant ID, the ' +
                'application (client) ID and the client secret on it first.',
        );
    }
    return { tenantId, clientId, clientSecret, secrets, name: connection.name };
}

/** The Entra identifiers needed to build an authorize URL. Never the secret. */
export async function mcpConsentTarget(
    ctx: RequestContext,
    connectionId: string,
): Promise<{ tenantId: string; clientId: string }> {
    assertCanAdmin(ctx);
    const { tenantId, clientId } = await entraCredentialsFor(ctx, connectionId);
    return { tenantId, clientId };
}

/**
 * Exchange the authorization code and attach the refresh token.
 *
 * Merged into the existing secrets rather than replacing them, so a
 * `clientSecret` already on file survives — replacing the blob wholesale would
 * silently drop it and break the connection this flow exists to complete.
 */
export async function completeMcpConsent(
    ctx: RequestContext,
    input: { connectionId: string; code: string; redirectUri: string },
): Promise<{ connectionName: string }> {
    assertCanAdmin(ctx);
    if (!ctx.userId) throw badRequest('An authorizing user is required');

    const creds = await entraCredentialsFor(ctx, input.connectionId);

    const refreshToken = await exchangeCodeForRefreshToken({
        tenantId: creds.tenantId,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        code: input.code,
        redirectUri: input.redirectUri,
    });

    await runInTenantContext(ctx, async (db) => {
        await db.integrationConnection.update({
            where: { id: input.connectionId },
            data: {
                secretEncrypted: encryptField(
                    JSON.stringify({ ...creds.secrets, refreshToken }),
                ),
            },
        });

        await logEvent(db, ctx, {
            entityType: 'IntegrationConnection',
            entityId: input.connectionId,
            action: 'MCP_CONNECTION_AUTHORIZED',
            details: `Entra authorization completed for MCP connection "${creds.name}"`,
            detailsJson: {
                category: 'custom',
                event: 'mcp_connection_authorized',
                connectionId: input.connectionId,
                // The Entra identifiers, which are not credentials. NEVER the
                // refresh token, the client secret or the code — an audit trail
                // that carried any of them would be a second place to steal the
                // connection from, and it streams to a SIEM.
                entraTenantId: creds.tenantId,
                clientId: creds.clientId,
                authorizedByUserId: ctx.userId,
            },
        });
    });

    return { connectionName: creds.name };
}
