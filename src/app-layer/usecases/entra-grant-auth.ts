/**
 * AUTHENTICATE THE GRANT ENDPOINT'S ONE CLIENT, WHICH IS OUR OWN DISPATCH (#3323).
 *
 * ═══ WHY NOT `requirePermission`, WHICH THE FIRST VERSION USED ═══
 *
 * #3321 gated the grant endpoint on `admin.tenant_lifecycle` and had the
 * dispatch reach it with an `iflk_` API key. That cannot work, and
 * `scopesToPermissions` says so in as many words:
 *
 *     …they join `tenant_lifecycle` and `owner_management` — actions that need
 *     a real session and that no bearer token, however scoped, performs.
 *
 * Even a `*` key resolves to `getPermissionsForRole('ADMIN')`, and ADMIN
 * returns `tenant_lifecycle: false` explicitly. There is no scope that reaches
 * it, so the endpoint was callable by a human in a browser and by nothing else —
 * the exact inverse of its purpose.
 *
 * Lowering the gate to a key an API key CAN hold was the obvious repair and is
 * the wrong one: `admin.manage` is held by every `*` key in the tenant, and
 * OWNER-only is the property the external-write path was chosen for. Weakening
 * the gate to fit the credential is fitting the lock to the key.
 *
 * ═══ WHAT REPLACES IT ═══
 *
 * A per-connection token, compared in constant time, which does not go through
 * the permission system at all:
 *
 *     Authorization: Bearer <connectionId>.<secret>
 *
 * The CONNECTION identifies the tenant. That is the property the previous
 * design's tenant-in-the-path was protecting and it survives intact — the
 * tenant is still authenticated rather than asserted, because it comes from a
 * row found by a secret only we hold, not from a caller-supplied argument.
 *
 * Blast radius is narrower than the key design, not wider: a leaked token
 * reaches exactly one connection in one tenant, grants nothing else anywhere,
 * and is not a credential any human flow can present.
 *
 * ═══ WHAT IS LOST, STATED RATHER THAN GLOSSED ═══
 *
 * `requirePermission` writes a hash-chained `AUTHZ_DENIED` row on refusal, for
 * free. This does not get that for free and must not simply drop it: a refused
 * grant attempt is precisely the thing an operator wants in the audit trail.
 * So `auditableRefusal` below marks the refusals that CAN be attributed, and
 * the route writes the row.
 *
 * The ones that cannot are honest about it. A malformed token or an unknown
 * connection id identifies no tenant, and `AuditLog` is tenant-scoped — there
 * is no row to write and inventing one would mean guessing whose trail it
 * belongs in. Those are logged and counted, not audited, and the asymmetry is
 * recorded here so nobody later reads the gap as an oversight.
 */
import { timingSafeEqual } from 'node:crypto';

import { prisma } from '@/lib/prisma';
import { decryptField } from '@/lib/security/encryption';
import { logger } from '@/lib/observability/logger';

/**
 * The provider id an MCP-server connection carries.
 *
 * RE-EXPORTED from the provider rather than spelled again. It was a second
 * literal here until #3330, which is a drift risk in the one place that cannot
 * afford one: if the provider id ever changed, this comparison would silently
 * stop matching and every grant would refuse `wrong_provider` with nothing
 * failing in a test.
 */
export { MCP_SERVER_PROVIDER_ID as MCP_SERVER_PROVIDER } from '@/app-layer/integrations/providers/mcp-server-provider';
import { MCP_SERVER_PROVIDER_ID } from '@/app-layer/integrations/providers/mcp-server-provider';

/**
 * Why a caller was refused.
 *
 * `attributable` is the half that decides whether an audit row is possible: a
 * refusal that knows its tenant can be written to that tenant's hash-chained
 * trail, and one that does not cannot be written anywhere honestly.
 */
export type GrantAuthRefusal =
    /** No header, or not a Bearer. Nothing identified. */
    | { readonly kind: 'no_credential'; readonly attributable: false }
    /** Present but not `<connectionId>.<secret>`. Nothing identified. */
    | { readonly kind: 'malformed'; readonly attributable: false }
    /** The connection id is syntactically fine and names nothing. */
    | { readonly kind: 'unknown_connection'; readonly attributable: false }
    /** Found, but not an MCP-server connection — a token pointed at the wrong row. */
    | { readonly kind: 'wrong_provider'; readonly attributable: true; readonly tenantId: string }
    /** Found and disabled. An operator turned it off; the token still exists. */
    | { readonly kind: 'disabled'; readonly attributable: true; readonly tenantId: string }
    /** Found, enabled, and carries no token to compare against. */
    | { readonly kind: 'no_stored_token'; readonly attributable: true; readonly tenantId: string }
    /**
     * Found, enabled, and configured for OAuth — so the stored static secret
     * is NOT what the dispatch sends, and comparing against it is comparing
     * two unrelated credentials (#3340).
     */
    | {
          readonly kind: 'oauth_shadows_static';
          readonly attributable: true;
          readonly tenantId: string;
      }
    /** Found, enabled, token present, secret WRONG. The one that matters. */
    | { readonly kind: 'secret_mismatch'; readonly attributable: true; readonly tenantId: string };

export type GrantAuthResult =
    | {
          readonly ok: true;
          readonly tenantId: string;
          readonly connectionId: string;
          readonly connectionName: string;
      }
    | { readonly ok: false; readonly refusal: GrantAuthRefusal };

/**
 * Constant-time string comparison that does not return early on length.
 *
 * Lifted deliberately from `verifyPlatformApiKey`'s `constantTimeKeyMatch`
 * rather than imported: that one is private to platform-admin auth, and the
 * note in `entitlement.ts` about `graphErrorCode` applies — widening a private
 * helper's surface for a second caller is how a helper becomes a shared
 * dependency nobody owns. The eleven lines are cheaper than the coupling.
 *
 * `timingSafeEqual` requires equal-length buffers, and an early return on a
 * length difference leaks a length oracle, so a mismatch is folded into the
 * comparison by corrupting a byte instead.
 */
function constantTimeMatch(provided: string, expected: string): boolean {
    if (expected.length === 0) return false;
    const a = Buffer.alloc(expected.length);
    const b = Buffer.from(expected, 'utf8');
    a.write(provided, 'utf8');
    if (provided.length !== expected.length) {
        a[0] = a[0] ^ 0xff;
    }
    return timingSafeEqual(a, b);
}

/**
 * Split `Bearer <connectionId>.<secret>`.
 *
 * The id is the FIRST dot-separated field and the secret is everything after
 * the first dot, not the second field — a secret containing a dot must not
 * silently become a shorter secret. `split('.')` with a limit would do exactly
 * that, which is why this uses `indexOf`.
 */
function parseToken(header: string | null): { connectionId: string; secret: string } | null {
    if (!header) return null;
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!m) return null;
    const raw = m[1].trim();
    const dot = raw.indexOf('.');
    if (dot <= 0 || dot === raw.length - 1) return null;
    return { connectionId: raw.slice(0, dot), secret: raw.slice(dot + 1) };
}

/** The operator-facing sentence. Never names the correct token or its length. */
export function describeGrantAuthRefusal(r: GrantAuthRefusal): string {
    switch (r.kind) {
        case 'no_credential':
            return 'No bearer credential was presented.';
        case 'malformed':
            return 'The credential is not in the form <connectionId>.<secret>.';
        case 'unknown_connection':
            return 'The credential does not name a known connection.';
        case 'wrong_provider':
            return 'The credential names a connection that is not an MCP server connection.';
        case 'disabled':
            return 'That connection is disabled, so it cannot be written through.';
        case 'no_stored_token':
            return (
                'That connection has no authorization secret stored, so there is nothing to '
                + 'authenticate against. Set one on the connection.'
            );
        case 'oauth_shadows_static':
            return (
                'That connection is configured for OAuth, so the dispatch sends a minted '
                + 'access token rather than the stored authorization secret. There is nothing '
                + 'to compare. Remove the OAuth fields or the static secret, whichever this '
                + 'server does not use.'
            );
        case 'secret_mismatch':
            return 'The credential is not valid for that connection.';
        default: {
            // A new refusal kind is a compile error here rather than an empty
            // sentence in front of whoever is debugging a 401.
            const unreachable: never = r;
            return unreachable;
        }
    }
}

/**
 * Authenticate a grant-endpoint caller.
 *
 * GLOBAL PRISMA, and allowlisted for it in `tests/unit/no-direct-prisma.test.ts`
 * with this reason: the tenant is the OUTPUT of this function, so there is no
 * tenant context to read within. It is the same shape as `redeemOrgInvite`,
 * which is allowlisted because it operates pre-membership — a lookup whose
 * whole job is to establish which tenant the caller belongs to cannot be scoped
 * to a tenant it does not yet know.
 *
 * The read is by PRIMARY KEY and selects four columns. It cannot enumerate, it
 * cannot be widened by a caller, and a wrong id is indistinguishable in timing
 * from a wrong secret only insofar as the database makes it so — which is
 * accepted: an attacker who can guess a cuid has a cuid, and the secret is
 * still compared in constant time.
 */
export async function authenticateGrantCaller(
    authorizationHeader: string | null,
): Promise<GrantAuthResult> {
    const parsed = parseToken(authorizationHeader);
    if (!authorizationHeader) {
        return { ok: false, refusal: { kind: 'no_credential', attributable: false } };
    }
    if (!parsed) {
        return { ok: false, refusal: { kind: 'malformed', attributable: false } };
    }

    const row = await prisma.integrationConnection.findUnique({
        where: { id: parsed.connectionId },
        select: {
            id: true,
            tenantId: true,
            name: true,
            provider: true,
            isEnabled: true,
            configJson: true,
            secretEncrypted: true,
        },
    });
    if (!row) {
        return { ok: false, refusal: { kind: 'unknown_connection', attributable: false } };
    }
    if (row.provider !== MCP_SERVER_PROVIDER_ID) {
        return {
            ok: false,
            refusal: { kind: 'wrong_provider', attributable: true, tenantId: row.tenantId },
        };
    }
    if (!row.isEnabled) {
        return {
            ok: false,
            refusal: { kind: 'disabled', attributable: true, tenantId: row.tenantId },
        };
    }

    let secrets: Record<string, unknown> = {};
    if (row.secretEncrypted) {
        try {
            secrets = JSON.parse(decryptField(row.secretEncrypted)) as Record<string, unknown>;
        } catch (err) {
            // A decrypt failure is NOT a mismatch. Reporting it as one would
            // tell an operator their token is wrong when their key is.
            logger.warn('grant endpoint: connection secret would not decrypt', {
                component: 'entra-grant-auth',
                tenantId: row.tenantId,
                connectionId: row.id,
                detail: err instanceof Error ? err.message : 'unreadable',
            });
            return {
                ok: false,
                refusal: { kind: 'no_stored_token', attributable: true, tenantId: row.tenantId },
            };
        }
    }

    // ── Is this connection even sending the secret we are about to compare? (#3340)
    //
    // `authorizationFor` takes its OAuth branch if ANY of four fields is set
    // and then never reads `secrets.authorization`. So for such a connection
    // the dispatch sends a minted access token while this function compares
    // the stored static value: two unrelated credentials, each side correct,
    // `secret_mismatch` written to the audit trail, and nothing anywhere
    // naming the cause. #3330's mint refuses to create this state and
    // `mcp-server-provider.validateConnection` now refuses to save it, but
    // neither repairs a row that already has both — and this is the point
    // where that row stops being diagnosable, so it is named here.
    //
    // All FOUR fields are checked, across BOTH sources: `tenantId` and
    // `clientId` live on `configJson` and only `clientSecret` and
    // `refreshToken` are secrets. An earlier version of this check looked at
    // secrets alone and missed the one real connection that had the other
    // shape.
    const config =
        typeof row.configJson === 'object' && row.configJson !== null
        && !Array.isArray(row.configJson)
            ? (row.configJson as Record<string, unknown>)
            : {};
    const filled = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';
    if (
        filled(config.tenantId)
        || filled(config.clientId)
        || filled(secrets.clientSecret)
        || filled(secrets.refreshToken)
    ) {
        return {
            ok: false,
            refusal: {
                kind: 'oauth_shadows_static',
                attributable: true,
                tenantId: row.tenantId,
            },
        };
    }

    // The SAME field the dispatch sends as its Authorization header, so one
    // value is configured once and both sides read it. A second field would be
    // two chances to disagree about the same secret.
    const rawStored = secrets.authorization;
    const stored =
        typeof rawStored === 'string' ? rawStored.replace(/^Bearer\s+/i, '').trim() : '';
    if (stored === '') {
        return {
            ok: false,
            refusal: { kind: 'no_stored_token', attributable: true, tenantId: row.tenantId },
        };
    }

    // The stored value is the WHOLE token (`<connectionId>.<secret>`), because
    // that is what the dispatch sends verbatim. Compare the secret halves.
    const dot = stored.indexOf('.');
    const storedSecret = dot > 0 ? stored.slice(dot + 1) : stored;
    if (!constantTimeMatch(parsed.secret, storedSecret)) {
        return {
            ok: false,
            refusal: { kind: 'secret_mismatch', attributable: true, tenantId: row.tenantId },
        };
    }

    return {
        ok: true,
        tenantId: row.tenantId,
        connectionId: row.id,
        connectionName: row.name,
    };
}
