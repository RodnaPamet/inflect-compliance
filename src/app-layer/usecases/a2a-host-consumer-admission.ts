import { env } from '@/env';
import {
    hostConsumersAdmitted,
    verifyHostConsumerToken,
    type HostConsumerTokenClaims,
} from '@/lib/agentic/a2a/host-consumer';
import { runInTenantContext } from '@/lib/db-context';

import type { RequestContext } from '@/app-layer/types';

/**
 * Admission for a HOST CONSUMER — a host that calls Inflect as a client
 * (#3861, ADR 0003).
 *
 * Runs BEFORE the peer path and never falls through to it once it has
 * recognised a host-consumer token. The peer path is untouched: a peer still
 * needs its `iflp_` credential, its signed receipt and a current card pin, and
 * nothing here can waive any of them.
 *
 * ── WHY THE TOKEN IS NOT TRUSTED FOR AUTHORIZATION ──────────────────────
 *
 * The token carries `receivingAgentId` and `workflowKeys`, and this function
 * ignores both for the decision. It uses the token for ONE thing — which
 * consumer is calling — and re-reads everything else from the row.
 *
 * That is deliberate. A token lives fifteen minutes; an allowlist narrowed or
 * an agent re-pointed inside that window would otherwise keep taking effect
 * from a stale claim until the token expired. Reading the row means a narrowing
 * applies at once, and it is also what makes the stateless token acceptable at
 * all (threat-model R26): the status, the revocation and the kill switch are
 * read UNCACHED on EVERY request, so revoking or killing a consumer stops its
 * live tokens immediately.
 *
 * **Caching any of those three reads would silently turn R26 from closed back
 * to open.** If this ever needs to be fast, the answer is a shorter token life,
 * not a cache.
 */

/** Why a recognised host-consumer call was refused. Each is distinct. */
export type HostConsumerRefusalReason =
    | 'HOST_CONSUMERS_DISABLED'
    | 'TOKEN_SECRET_NOT_CONFIGURED'
    | 'TOKEN_MALFORMED'
    | 'TOKEN_EXPIRED'
    | 'TOKEN_BAD_SIGNATURE'
    | 'TOKEN_WRONG_ISSUER'
    | 'TOKEN_CLAIMS_INCOMPLETE'
    | 'UNKNOWN_HOST_CONSUMER'
    | 'HOST_CONSUMER_REVOKED'
    | 'HOST_CONSUMER_KILLED'
    | 'HOST_CONSUMER_QUOTA';

/** What the row says, which is what the decision is made on. */
export interface AdmittedHostConsumer {
    readonly id: string;
    readonly clientId: string;
    /** The accountable person whose authority a run this consumer starts carries. */
    readonly ownerUserId: string;
    readonly receivingAgentId: string;
    readonly workflowKeys: readonly string[];
    readonly inboundMessagesPerHour: number;
}

export type HostConsumerAdmission =
    /** Not a host-consumer bearer at all — the peer path should look at it. */
    | { readonly kind: 'NOT_A_HOST_TOKEN' }
    | { readonly kind: 'REFUSED'; readonly reason: HostConsumerRefusalReason; readonly httpStatus: number }
    | {
          readonly kind: 'ADMITTED';
          readonly consumer: AdmittedHostConsumer;
          readonly claims: HostConsumerTokenClaims;
      };

/**
 * Does this bearer even look like one of our tokens?
 *
 * Three dot-separated segments. This check is load-bearing for the PEER path,
 * not for this one: without it, a deployment with the flag on but no token
 * secret would answer `TOKEN_SECRET_NOT_CONFIGURED` to every bearer — a peer's
 * `iflp_` credential included — and break peer traffic that has nothing to do
 * with host consumers.
 */
function looksLikeAToken(bearer: string): boolean {
    const parts = bearer.split('.');
    return parts.length === 3 && parts[0].length > 0 && parts[1].length > 0;
}

/** The bearer, if the header carries one. */
export function bearerFrom(authorization: string | null | undefined): string | null {
    if (!authorization) return null;
    const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    return m ? m[1].trim() : null;
}

export async function tryAdmitHostConsumer(
    sys: RequestContext,
    opts: { readonly authorization: string | null | undefined; readonly now?: Date },
): Promise<HostConsumerAdmission> {
    const bearer = bearerFrom(opts.authorization);
    if (!bearer || !looksLikeAToken(bearer)) return { kind: 'NOT_A_HOST_TOKEN' };

    // The tenant's half of the gate, read before anything else is spent.
    const settings = await runInTenantContext(sys, (db) =>
        db.tenantSecuritySettings.findFirst({
            where: { tenantId: sys.tenantId },
            select: { a2aHostConsumersEnabled: true },
        }),
    );
    if (!hostConsumersAdmitted({ envValue: env.A2A_HOST_CONSUMERS, tenantEnabled: settings?.a2aHostConsumersEnabled })) {
        // A token-shaped bearer arriving at a tenant that does not admit host
        // consumers is REFUSED rather than passed to the peer path: it cannot
        // be a peer credential, and falling through would answer with the peer
        // path's reason, which says something different about why.
        return { kind: 'REFUSED', reason: 'HOST_CONSUMERS_DISABLED', httpStatus: 403 };
    }

    const verdict = verifyHostConsumerToken(bearer, {
        secret: env.A2A_HOST_CONSUMER_TOKEN_SECRET,
        nowMs: opts.now?.getTime(),
    });
    if (!verdict.ok) return { kind: 'REFUSED', reason: verdict.reason, httpStatus: 401 };

    // Cross-tenant: a token minted for another tenant names this one nowhere,
    // and the row read below is tenant-scoped anyway. Checked explicitly so the
    // refusal is attributable rather than arriving as UNKNOWN_HOST_CONSUMER.
    if (verdict.claims.tenantId !== sys.tenantId) {
        return { kind: 'REFUSED', reason: 'UNKNOWN_HOST_CONSUMER', httpStatus: 401 };
    }

    const row = await runInTenantContext(sys, (db) =>
        db.hostConsumer.findFirst({
            where: { id: verdict.claims.hostConsumerId, tenantId: sys.tenantId },
            select: {
                id: true,
                clientId: true,
                ownerUserId: true,
                receivingAgentId: true,
                workflowKeys: true,
                inboundMessagesPerHour: true,
                status: true,
                revokedAt: true,
            },
        }),
    );
    if (!row) return { kind: 'REFUSED', reason: 'UNKNOWN_HOST_CONSUMER', httpStatus: 401 };
    if (row.revokedAt !== null || row.status !== 'ACTIVE') {
        return { kind: 'REFUSED', reason: 'HOST_CONSUMER_REVOKED', httpStatus: 403 };
    }

    // UNCACHED, every request. See the docblock: this is what makes a stateless
    // token revocable at all.
    const killed = await runInTenantContext(sys, (db) =>
        db.hostConsumerKillSwitch.findFirst({
            where: { tenantId: sys.tenantId, hostConsumerId: row.id, liftedAt: null },
            select: { id: true },
        }),
    );
    if (killed) return { kind: 'REFUSED', reason: 'HOST_CONSUMER_KILLED', httpStatus: 403 };

    const since = new Date((opts.now ?? new Date()).getTime() - 60 * 60 * 1000);
    const used = await runInTenantContext(sys, (db) =>
        db.hostConsumerMessage.count({
            where: { tenantId: sys.tenantId, hostConsumerId: row.id, createdAt: { gte: since } },
        }),
    );
    if (used >= row.inboundMessagesPerHour) {
        return { kind: 'REFUSED', reason: 'HOST_CONSUMER_QUOTA', httpStatus: 429 };
    }

    return {
        kind: 'ADMITTED',
        // The ROW's agent and allowlist, never the token's.
        consumer: {
            id: row.id,
            clientId: row.clientId,
            ownerUserId: row.ownerUserId,
            receivingAgentId: row.receivingAgentId,
            workflowKeys: row.workflowKeys,
            inboundMessagesPerHour: row.inboundMessagesPerHour,
        },
        claims: verdict.claims,
    };
}
