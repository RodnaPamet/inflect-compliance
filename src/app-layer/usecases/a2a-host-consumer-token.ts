import { env } from '@/env';
import { appendAuditEntryOrQueue } from '@/lib/audit/audit-outbox';
import {
    hostConsumerSecretMatches,
    hostConsumersAdmitted,
    mintHostConsumerToken,
    HOST_CONSUMER_TOKEN_TTL_SECONDS,
} from '@/lib/agentic/a2a/host-consumer';
import { runInTenantContext } from '@/lib/db-context';
import { runInGlobalContext } from '@/lib/db/rls-middleware';
import { buildSystemContext } from '@/app-layer/context-system';
import { logger } from '@/lib/observability/logger';

/**
 * The OAuth2 client-credentials token endpoint a host consumer calls (#3861).
 *
 * This exists because SAP's BTP destination, configured
 * `OAuth2ClientCredentials`, performs a token exchange before it calls the
 * agent: it posts the client id and secret to a token URL and uses the
 * `access_token` that comes back. Verified from SAP's own toolkit, which
 * documents the destination carrying `tokenServiceURL`.
 *
 * ── ONE REFUSAL OUTWARDS, THE REASON IN THE AUDIT ROW ───────────────────
 *
 * Every failure answers OAuth2's `invalid_client` with no detail. An unknown
 * client id and a wrong secret are deliberately indistinguishable to the
 * caller: telling them apart is a client-id oracle, and a host consumer's
 * client id is long-lived. The reason is recorded in the audit row instead,
 * which is the pattern the inbound endpoint already uses for the same reason.
 *
 * ── THE KILL SWITCH IS CHECKED HERE TOO ─────────────────────────────────
 *
 * Admission checks it on every request, so a killed consumer could not use a
 * token it already holds. Checking it again here means a killed consumer
 * cannot even OBTAIN one — so a kill does not leave a fifteen-minute window in
 * which new tokens are still being minted for a principal someone has stopped.
 */

export type HostConsumerTokenIssueRefusal =
    | 'UNKNOWN_TENANT'
    | 'HOST_CONSUMERS_DISABLED'
    | 'UNSUPPORTED_GRANT_TYPE'
    | 'MISSING_CLIENT_CREDENTIALS'
    | 'UNKNOWN_CLIENT'
    | 'BAD_CLIENT_SECRET'
    | 'HOST_CONSUMER_REVOKED'
    | 'HOST_CONSUMER_KILLED'
    | 'TOKEN_SECRET_NOT_CONFIGURED';

export type HostConsumerTokenIssueResult =
    | {
          readonly ok: true;
          readonly accessToken: string;
          readonly tokenType: 'Bearer';
          readonly expiresIn: number;
      }
    | { readonly ok: false; readonly reason: HostConsumerTokenIssueRefusal; readonly httpStatus: number };

export async function issueHostConsumerToken(input: {
    readonly tenantSlug: string;
    readonly grantType: string | null | undefined;
    readonly clientId: string | null | undefined;
    readonly clientSecret: string | null | undefined;
    readonly now?: Date;
}): Promise<HostConsumerTokenIssueResult> {
    const tenant = await runInGlobalContext((db) =>
        db.tenant.findFirst({ where: { slug: input.tenantSlug, deletedAt: null }, select: { id: true, slug: true } }),
    );
    if (!tenant) {
        logger.warn('host-consumer token refused an unattributable caller', {
            component: 'a2a-host-consumer-token',
            reason: 'UNKNOWN_TENANT',
        });
        return { ok: false, reason: 'UNKNOWN_TENANT', httpStatus: 400 };
    }

    const sys = buildSystemContext({ tenantId: tenant.id, tenantSlug: tenant.slug, job: 'a2a-host-consumer-token' });
    const deny = async (reason: HostConsumerTokenIssueRefusal, httpStatus = 400): Promise<HostConsumerTokenIssueResult> => {
        await appendAuditEntryOrQueue({
            tenantId: tenant.id,
            userId: null,
            actorType: 'SYSTEM',
            entity: 'HostConsumer',
            entityId: tenant.id,
            action: 'AUTHZ_DENIED',
            requestId: sys.requestId,
            detailsJson: {
                category: 'access',
                endpoint: 'a2a-host-consumer-token',
                reason,
                // The client id PRESENTED, not one we confirmed exists — so a
                // reader can tell a typo from an attack without this row
                // implying the id was valid.
                presentedClientId: input.clientId ?? null,
            },
        }).catch(() => undefined);
        return { ok: false, reason, httpStatus };
    };

    const settings = await runInTenantContext(sys, (db) =>
        db.tenantSecuritySettings.findFirst({
            where: { tenantId: tenant.id },
            select: { a2aHostConsumersEnabled: true },
        }),
    );
    if (!hostConsumersAdmitted({ envValue: env.A2A_HOST_CONSUMERS, tenantEnabled: settings?.a2aHostConsumersEnabled })) {
        return deny('HOST_CONSUMERS_DISABLED', 403);
    }

    // The only grant this endpoint implements. Named rather than ignored: a
    // destination misconfigured for `password` or `authorization_code` should
    // learn that, not be told its client is invalid.
    if (input.grantType !== 'client_credentials') return deny('UNSUPPORTED_GRANT_TYPE');
    if (!input.clientId || !input.clientSecret) return deny('MISSING_CLIENT_CREDENTIALS');

    const row = await runInTenantContext(sys, (db) =>
        db.hostConsumer.findFirst({
            where: { tenantId: tenant.id, clientId: input.clientId as string },
            select: {
                id: true,
                clientSecretHash: true,
                ownerUserId: true,
                receivingAgentId: true,
                workflowKeys: true,
                status: true,
                revokedAt: true,
            },
        }),
    );
    if (!row) return deny('UNKNOWN_CLIENT', 401);
    // Constant time, and AFTER the row was found — so the comparison happens
    // for a real stored hash rather than against a placeholder.
    if (!hostConsumerSecretMatches(input.clientSecret, row.clientSecretHash)) {
        return deny('BAD_CLIENT_SECRET', 401);
    }
    if (row.revokedAt !== null || row.status !== 'ACTIVE') return deny('HOST_CONSUMER_REVOKED', 403);

    const killed = await runInTenantContext(sys, (db) =>
        db.hostConsumerKillSwitch.findFirst({
            where: { tenantId: tenant.id, hostConsumerId: row.id, liftedAt: null },
            select: { id: true },
        }),
    );
    if (killed) return deny('HOST_CONSUMER_KILLED', 403);

    const minted = mintHostConsumerToken(
        {
            tenantId: tenant.id,
            hostConsumerId: row.id,
            receivingAgentId: row.receivingAgentId,
            workflowKeys: row.workflowKeys,
        },
        { secret: env.A2A_HOST_CONSUMER_TOKEN_SECRET, nowMs: input.now?.getTime() },
    );
    if (!minted.ok) return deny('TOKEN_SECRET_NOT_CONFIGURED', 503);

    await appendAuditEntryOrQueue({
        tenantId: tenant.id,
        userId: row.ownerUserId,
        actorType: 'SYSTEM',
        entity: 'HostConsumer',
        entityId: row.id,
        action: 'HOST_CONSUMER_TOKEN_ISSUED',
        requestId: sys.requestId,
        detailsJson: {
            category: 'access',
            hostConsumerId: row.id,
            // The jti, so a token can be tied to the request that used it —
            // every `HostConsumerMessage` carries the same value.
            jti: minted.jti,
            expiresInSeconds: minted.expiresInSeconds,
        },
    }).catch(() => undefined);

    return {
        ok: true,
        accessToken: minted.token,
        tokenType: 'Bearer',
        expiresIn: HOST_CONSUMER_TOKEN_TTL_SECONDS,
    };
}
