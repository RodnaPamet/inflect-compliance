/**
 * MINT THE TOKEN THE GRANT ENDPOINT AUTHENTICATES (#3330).
 *
 * ═══ WHY A MINT ACTION RATHER THAN A TEXT FIELD ═══
 *
 * #3323 made the endpoint authenticate `Bearer <connectionId>.<secret>`. The
 * provider declares `authorization` as free text, so wiring it by hand means:
 * create the connection with the field empty, find its id, invent a random
 * secret with no guidance on length or alphabet, concatenate the two, and edit
 * the connection again. Steps two and four are a chicken-and-egg the token
 * shape creates — the id does not exist until the row does — and the invented
 * secret is where a weak one enters, silently and permanently. **Nothing in
 * this system would notice a four-character secret.**
 *
 * That matters because this is the whole security boundary for a publicly
 * reachable origin. A boundary whose strength depends on an operator inventing
 * a random string by hand has an unmeasured weakest point.
 *
 * ═══ STORED RECOVERABLE, NOT HASHED, AND SAID PLAINLY ═══
 *
 * An API key in this repo is stored as a HASH and its plaintext is genuinely
 * unrecoverable. This is not that. The endpoint COMPARES against the value, so
 * the value must be recoverable — it is stored encrypted under the tenant DEK,
 * and anybody with the database and the KEK can read it back.
 *
 * Showing it once therefore reduces the number of COPIES; it does not make the
 * secret unrecoverable, and claiming otherwise in the UI would be a false
 * assurance. That is also why the comparison is constant-time: the stored value
 * is the thing being guessed at.
 *
 * ═══ NO PREVIOUS-VALUE WINDOW, AND WHY NONE IS NEEDED ═══
 *
 * `verifyPlatformApiKey` keeps `PLATFORM_ADMIN_API_KEY_PREVIOUS` valid for a
 * window so rotation has no gap, and #3330 asks whether to copy it. It is not
 * needed here, for a structural reason rather than a judgement:
 *
 *   there is only ONE copy of this secret. The dispatch reads
 *   `secrets.authorization` off the connection and sends it; the endpoint reads
 *   the same field off the same row and compares. Rotation is a single row
 *   update that changes both sides at the same instant.
 *
 * A previous-value window exists to cover the interval where one side has been
 * updated and the other has not. There is no such interval here, so the window
 * would add a second acceptable secret to the boundary and buy nothing.
 */
import { randomBytes } from 'node:crypto';

import { runInTenantContext } from '@/lib/db-context';
import { decryptField, encryptField } from '@/lib/security/encryption';
import { assertCanAdmin } from '../policies/common';
import { logEvent } from '@/app-layer/events/audit';
import { badRequest, notFound } from '@/lib/errors/types';
import { MCP_SERVER_PROVIDER_ID } from '@/app-layer/integrations/providers/mcp-server-provider';
import type { RequestContext } from '../types';

/**
 * 32 bytes, base64url.
 *
 * Declared as a constant and asserted by a test rather than inlined, because
 * "how long is the secret" is the one property of this boundary an operator
 * cannot inspect and a reviewer should not have to count characters for.
 */
export const GRANT_TOKEN_SECRET_BYTES = 32;

/** Why a mint was refused, each fixed by a different action. */
export type MintRefusal =
    | { readonly kind: 'not_found' }
    | { readonly kind: 'wrong_provider'; readonly provider: string }
    | { readonly kind: 'oauth_configured' };

export function describeMintRefusal(r: MintRefusal): string {
    switch (r.kind) {
        case 'not_found':
            return 'That connection does not exist in this workspace.';
        case 'wrong_provider':
            return (
                `That connection is a ${r.provider} connection, not an MCP server one. `
                + 'This token is only read by the MCP server grant endpoint.'
            );
        case 'oauth_configured':
            return (
                'This connection is configured for OAuth (tenantId, clientId, clientSecret and '
                + 'refreshToken), so the dispatch mints an access token and never sends the '
                + 'static Authorization secret. A token minted here would therefore never be '
                + 'presented, and every grant would be refused as a credential mismatch. '
                + 'Clear the OAuth fields to use a static token, or leave this connection on '
                + 'OAuth and do not mint one.'
            );
        default: {
            const unreachable: never = r;
            return unreachable;
        }
    }
}

export type MintOutcome =
    /** The plaintext, returned ONCE. Never read back from storage afterwards. */
    | { readonly ok: true; readonly token: string; readonly rotated: boolean }
    | { readonly ok: false; readonly refusal: MintRefusal };

/**
 * Generate, store and return the connection's grant token.
 *
 * Running it twice is the rotation path: the second call overwrites the first
 * and the old value stops working the moment the row is written — see the
 * header for why that needs no overlap window.
 */
export async function mintMcpServerToken(
    ctx: RequestContext,
    connectionId: string,
): Promise<MintOutcome> {
    assertCanAdmin(ctx);

    const row = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirst({
            where: { id: connectionId, tenantId: ctx.tenantId },
            select: { id: true, provider: true, secretEncrypted: true },
        }),
    );
    if (!row) return { ok: false, refusal: { kind: 'not_found' } };
    if (row.provider !== MCP_SERVER_PROVIDER_ID) {
        return { ok: false, refusal: { kind: 'wrong_provider', provider: row.provider } };
    }

    // MERGE, never replace. A connection's secrets are one JSON blob and this
    // field is one key in it; writing a fresh object would silently drop
    // whatever else is stored there.
    let secrets: Record<string, unknown> = {};
    if (row.secretEncrypted) {
        try {
            secrets = JSON.parse(decryptField(row.secretEncrypted)) as Record<string, unknown>;
        } catch {
            // A secret blob that will not decrypt must NOT be overwritten with a
            // fresh one: that would destroy whatever it holds in order to add a
            // field. The operator needs to fix the key, not lose the row.
            throw badRequest(
                'This connection\'s stored secrets could not be decrypted, so a token cannot be '
                    + 'added without discarding them. Check DATA_ENCRYPTION_KEY before retrying.',
            );
        }
    }

    // REFUSED, not warned. `authorizationFor` returns the static header ONLY
    // when no OAuth field is present — if any of the four is set it mints an
    // access token instead and `secrets.authorization` is never read. So a
    // token minted onto an OAuth connection is a credential that is stored,
    // compared against, and never sent: every grant would fail as a mismatch,
    // and the cause would be invisible from either side.
    const oauthField = ['clientSecret', 'refreshToken'].some(
        (k) => typeof secrets[k] === 'string' && (secrets[k] as string).trim() !== '',
    );
    if (oauthField) return { ok: false, refusal: { kind: 'oauth_configured' } };

    const rotated = typeof secrets.authorization === 'string' && secrets.authorization !== '';
    // The CONNECTION ID is part of the token because it is what the endpoint
    // looks the row up by; the secret half is what it compares. Composed here
    // so the operator never has to concatenate anything.
    const token = `${row.id}.${randomBytes(GRANT_TOKEN_SECRET_BYTES).toString('base64url')}`;

    await runInTenantContext(ctx, async (db) => {
        await db.integrationConnection.update({
            where: { id: row.id },
            data: {
                secretEncrypted: encryptField(
                    JSON.stringify({ ...secrets, authorization: token }),
                ),
            },
        });
        // The EVENT, never the value. An audit row quoting the token would put a
        // second permanent copy of it in a table built never to be deleted —
        // and `AuditLog` outlives the connection, so rotating would not remove
        // it.
        await logEvent(db, ctx, {
            action: rotated ? 'MCP_GRANT_TOKEN_ROTATED' : 'MCP_GRANT_TOKEN_MINTED',
            entityType: 'IntegrationConnection',
            entityId: row.id,
            detailsJson: {
                provider: row.provider,
                // The LENGTH, which is a property of the policy rather than of
                // the secret, so an auditor can see a weak one was not accepted.
                secretBytes: GRANT_TOKEN_SECRET_BYTES,
                rotated,
            },
        });
    });

    return { ok: true, token, rotated };
}
