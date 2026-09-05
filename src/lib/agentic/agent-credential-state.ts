/**
 * Is the credential behind this request still live, RIGHT NOW?
 *
 * ## Why this is a separate read from authentication
 *
 * `verifyApiKey` answers this once, at the door. That is enough for a single
 * HTTP request and is not enough for a RUN: the workflow engine resolves one
 * `McpInvocation` and then executes many steps on it, so a key revoked while a
 * run is in flight would keep its authority until the run ended. Revoking a
 * credential has to mean the next TOOL CALL, not the next request — otherwise
 * the operator's one emergency lever does nothing for however long the current
 * run lasts, which is exactly the window an incident happens in.
 *
 * So the funnel re-asks, per tool call, and this is the question it asks.
 *
 * ## Uncached, deliberately
 *
 * The same reasoning as `listGrantedToolNames` next door, one notch stronger. A
 * cache here — even one scoped to a single execution — puts a TTL between an
 * operator revoking a key and the agent stopping, and the length of that TTL is
 * the length of the hole. One indexed primary-key lookup per tool call is the
 * price, and tool calls are already doing real database work inside a usecase.
 *
 * ## Why it lives in `agentic/` rather than in the MCP funnel that calls it
 *
 * `tests/guardrails/mcp-server-coverage.test.ts` refuses ANY Prisma import under
 * `src/lib/mcp/` — the rule that keeps every MCP read going through a usecase
 * that binds RLS. This read is not a tenant-data read (it is a credential
 * check, tenant-scoped by its own `where`), but the guard is deliberately blunt
 * and being blunt is most of its value: an exception carved for a good reason
 * is an exception the next reader has to evaluate. The read belongs beside the
 * other credential-shaped reads instead.
 */
import prisma from '@/lib/prisma';

/** Why a credential is no longer usable, or `null` when it still is. */
export type CredentialLivenessFailure =
    /** The row is gone. Treated as revoked — the fail direction for "the
     *  credential I was told about is not there" has to be refusal. */
    | 'missing'
    /** `revokedAt` is set. The deliberate act, and the one an operator wants
     *  confirmation of. */
    | 'revoked'
    /** `expiresAt` has passed. */
    | 'expired';

/**
 * Re-read one credential's live state.
 *
 * Scoped by `(id, tenantId)` rather than by id alone: this query decides whether
 * an agent goes on acting, and it does not get to rely on the caller having
 * already established which tenant the key belongs to.
 */
export async function checkCredentialLiveness(
    apiKeyId: string,
    tenantId: string,
    now: Date,
): Promise<CredentialLivenessFailure | null> {
    const row = await prisma.tenantApiKey.findFirst({
        where: { id: apiKeyId, tenantId },
        select: { revokedAt: true, expiresAt: true },
    });

    if (!row) return 'missing';
    if (row.revokedAt !== null) return 'revoked';
    if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return 'expired';
    return null;
}
