/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles mirroring a
 * Prisma client. Per-line typing has poor cost/benefit in test doubles; the
 * file-level disable is this repo's standard for the shape. */
/**
 * Audience-scoped tokens and per-call credential liveness — the two properties
 * that a status code cannot distinguish from their broken versions.
 *
 * ## What is under test, and why each needs a test rather than a reading
 *
 *   1. A TOKEN MINTED FOR TOOL X IS REFUSED AT TOOL Y. Not merely recorded, not
 *      merely logged — the funnel refuses the call. The audience lives inside a
 *      signed payload, so the interesting cases are the ones where the holder
 *      edits it: a swapped audience must fail the SIGNATURE, not just the
 *      comparison, or the check is advisory.
 *
 *   2. AN EXPIRED TOKEN IS REFUSED, ON AN INJECTED CLOCK. Every expiry in this
 *      subsystem reads a `now()` the caller supplies. A test that cannot control
 *      the clock cannot prove an expiry inside a 300-second window without
 *      sleeping — so in practice it stops testing the expiry at all, and the
 *      first thing to break is the thing nobody is watching.
 *
 *   3. A REVOKED KEY IS REFUSED ON THE VERY NEXT INVOCATION. The invocation is
 *      built ONCE and reused, exactly as the workflow engine reuses it across a
 *      run's steps. The same object authorizes a call, the key is revoked
 *      underneath it, and the SECOND call on that SAME object must refuse. That
 *      is the difference between checking at the boundary and checking at
 *      dispatch, and it is invisible to any assertion about a single request.
 *
 * The database is mocked to ONE table read — `TenantApiKey` liveness — because
 * that is the only query the funnel makes on this path. Everything else here is
 * pure: the signature, the clock arithmetic, the audience comparison and the
 * ceiling algebra all run for real.
 */

jest.mock('@/lib/prisma', () => {
    const tenantApiKey = { findFirst: jest.fn() };
    return { __esModule: true, default: { tenantApiKey }, prisma: { tenantApiKey } };
});

jest.mock('@/lib/audit', () => ({
    appendAuditEntry: jest.fn().mockResolvedValue(undefined),
}));

import prisma from '@/lib/prisma';
import { appendAuditEntry } from '@/lib/audit';
import { authorizeToolCall, type McpInvocation } from '@/lib/mcp/authorize';
import {
    DEFAULT_TOKEN_TTL_SECONDS,
    MAX_TOKEN_TTL_SECONDS,
    MCP_EXCHANGED_TOKEN_PREFIX,
    MCP_RESOURCES_AUDIENCE,
    isExchangedToken,
    mintExchangedToken,
    verifyExchangedToken,
} from '@/lib/mcp/token-exchange';
import { getPermissionsForRole } from '@/lib/permissions';
import { makeRequestContext } from '../helpers/make-context';

const findFirst = (prisma as any).tenantApiKey.findFirst as jest.Mock;
const auditRows = appendAuditEntry as unknown as jest.Mock;

const API_KEY_ID = 'key-1';
const TENANT = 'tenant-1';

/** A fixed instant, so nothing in this file depends on when it runs. */
const T0 = new Date('2026-09-05T12:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

/**
 * A tool descriptor with NO permission keys and no policy, so every assertion
 * below is about the credential terms alone. A tool that also failed the
 * permission gate would pass these tests for the wrong reason.
 */
const TOOL_X = {
    name: 'list_risks',
    authorize: { basis: 'effective' as const, mirrors: 'GET /api/t/:slug/risks' },
    resourceScope: { resource: 'risks', action: 'read' as const },
    capabilityClass: 'read' as const,
};
const TOOL_Y = { ...TOOL_X, name: 'list_controls', resourceScope: { resource: 'controls', action: 'read' as const } };

function invocationFor(
    audience: readonly string[] | null,
    overrides: Partial<McpInvocation> = {},
): McpInvocation {
    const ctx = makeRequestContext('EDITOR', {
        tenantId: TENANT,
        userId: 'user-1',
        apiKeyId: API_KEY_ID,
        // Wide enough that the SCOPE step is never what refuses — the
        // assertions here are about audience, liveness and the ceiling.
        apiKeyScopes: ['mcp:read', 'risks:read', 'controls:read', 'frameworks:read'],
    });
    return {
        ctx,
        principal: {
            userId: 'user-1',
            role: 'EDITOR',
            appPermissions: getPermissionsForRole('EDITOR'),
            permissions: ctx.permissions,
        },
        agentId: 'agent-1',
        grantedTools: new Set(['list_risks', 'list_controls']),
        audience,
        autonomyCeiling: 6,
        // A scored agent, so the tier term is never what refuses here — these
        // assertions are about audience, liveness and the ceiling arithmetic.
        riskTier: 'LOW' as const,
        credential: { apiKeyId: API_KEY_ID, tokenExpiresAt: null },
        now: () => T0,
        ...overrides,
    };
}

/** The refusal, or `null` when the call was allowed. */
async function refusalOf(fn: () => Promise<unknown>): Promise<string | null> {
    try {
        await fn();
        return null;
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
}

beforeEach(() => {
    jest.clearAllMocks();
    findFirst.mockResolvedValue({ revokedAt: null, expiresAt: null });
});

describe('a token minted for one tool is not a token for another', () => {
    it('the funnel allows the tool the token names', async () => {
        const inv = invocationFor(['list_risks']);
        expect(await refusalOf(() => authorizeToolCall(inv, TOOL_X))).toBeNull();
    });

    it('and REFUSES the tool it does not name', async () => {
        const inv = invocationFor(['list_risks']);
        const refusal = await refusalOf(() => authorizeToolCall(inv, TOOL_Y));
        expect(refusal).toContain('list_controls');
        // The refusal is enforcement, not a note: it also lands one
        // hash-chained row naming the audience the token actually held.
        expect(auditRows).toHaveBeenCalledTimes(1);
        expect(auditRows.mock.calls[0][0].detailsJson).toMatchObject({
            event: 'authz_denied',
            reason: 'audience_denied',
            requested: 'list_controls',
            tokenAudience: ['list_risks'],
        });
    });

    it('a token for the resources surface cannot call a tool, and vice versa', async () => {
        const resourcesOnly = invocationFor([MCP_RESOURCES_AUDIENCE]);
        expect(await refusalOf(() => authorizeToolCall(resourcesOnly, TOOL_X))).toContain(
            'list_risks',
        );

        // And the mirror: a tool token does not cover resources. Proved through
        // the audience predicate the resources gate uses, with the same claims.
        const toolToken = mintExchangedToken({
            tenantId: TENANT,
            apiKeyId: API_KEY_ID,
            agentId: 'agent-1',
            audience: ['list_risks'],
            now: () => T0,
        });
        const claims = verifyExchangedToken(toolToken.token, { now: () => T0 });
        expect(claims.audience).not.toContain(MCP_RESOURCES_AUDIENCE);
    });

    it('a caller holding the raw API key has no audience and is not narrowed', async () => {
        // `null` is not `[]`. This is the pre-exchange behaviour every existing
        // integration relies on, and collapsing the two states would either
        // break every key or make the audience a formality.
        const inv = invocationFor(null);
        expect(await refusalOf(() => authorizeToolCall(inv, TOOL_X))).toBeNull();
        expect(await refusalOf(() => authorizeToolCall(inv, TOOL_Y))).toBeNull();
    });

    it('editing the audience inside the token fails the SIGNATURE, not just the comparison', async () => {
        const minted = mintExchangedToken({
            tenantId: TENANT,
            apiKeyId: API_KEY_ID,
            agentId: 'agent-1',
            audience: ['list_risks'],
            now: () => T0,
        });
        const [payload, signature] = minted.token
            .slice(MCP_EXCHANGED_TOKEN_PREFIX.length)
            .split('.');
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        decoded.aud = ['list_controls'];
        const forgedPayload = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');

        // Same signature, widened audience — the shape an attacker actually has.
        const forged = `${MCP_EXCHANGED_TOKEN_PREFIX}${forgedPayload}.${signature}`;
        expect(() => verifyExchangedToken(forged, { now: () => T0 })).toThrow(
            /invalid or has expired/,
        );
    });

    it('the minted token contains no trace of the credential it was exchanged from', async () => {
        // "Never forward an upstream token downstream", made checkable. The
        // minter takes IDS, so there is no subject token in scope for it to
        // embed — this asserts the consequence rather than the intention.
        const minted = mintExchangedToken({
            tenantId: TENANT,
            apiKeyId: API_KEY_ID,
            agentId: 'agent-1',
            audience: ['list_risks'],
            now: () => T0,
        });
        expect(minted.token).not.toContain('iflk_');
        const payload = minted.token.slice(MCP_EXCHANGED_TOKEN_PREFIX.length).split('.')[0];
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        expect(Object.values(decoded).join('|')).not.toContain('iflk_');
        expect(decoded.kid).toBe(API_KEY_ID);
    });
});

describe('a token is short-lived, on an injected clock', () => {
    it('verifies inside its window and is refused one second past it', () => {
        const minted = mintExchangedToken({
            tenantId: TENANT,
            apiKeyId: API_KEY_ID,
            agentId: 'agent-1',
            audience: ['list_risks'],
            now: () => T0,
        });
        expect(minted.expiresInSeconds).toBe(DEFAULT_TOKEN_TTL_SECONDS);

        const justInside = at(DEFAULT_TOKEN_TTL_SECONDS - 1);
        expect(verifyExchangedToken(minted.token, { now: () => justInside }).apiKeyId).toBe(
            API_KEY_ID,
        );

        // Exclusive at the boundary: a token whose `exp` equals now is spent.
        const exactly = at(DEFAULT_TOKEN_TTL_SECONDS);
        expect(() => verifyExchangedToken(minted.token, { now: () => exactly })).toThrow();
        const past = at(DEFAULT_TOKEN_TTL_SECONDS + 1);
        expect(() => verifyExchangedToken(minted.token, { now: () => past })).toThrow();
    });

    it('refuses a lifetime beyond the server maximum rather than silently clamping it', () => {
        expect(() =>
            mintExchangedToken({
                tenantId: TENANT,
                apiKeyId: API_KEY_ID,
                agentId: null,
                audience: ['list_risks'],
                ttlSeconds: MAX_TOKEN_TTL_SECONDS + 1,
                now: () => T0,
            }),
        ).toThrow(/lifetime/);
    });

    it('refuses to mint a token that names nothing', () => {
        // An empty audience would be indistinguishable downstream from the
        // `null` a raw key carries, which is "no narrowing at all".
        expect(() =>
            mintExchangedToken({
                tenantId: TENANT,
                apiKeyId: API_KEY_ID,
                agentId: null,
                audience: [],
                now: () => T0,
            }),
        ).toThrow(/at least one audience/);
    });

    it('the funnel re-checks the token expiry at the tool boundary, not only at auth', async () => {
        // Authentication happened at T0 with a live token; the run is still
        // going at T0+301. The invocation object is the SAME one.
        const inv = invocationFor(['list_risks'], {
            credential: { apiKeyId: API_KEY_ID, tokenExpiresAt: at(DEFAULT_TOKEN_TTL_SECONDS) },
            now: () => at(DEFAULT_TOKEN_TTL_SECONDS + 1),
        });
        const refusal = await refusalOf(() => authorizeToolCall(inv, TOOL_X));
        expect(refusal).toContain('expired');
        expect(auditRows.mock.calls[0][0].detailsJson).toMatchObject({
            reason: 'credential_expired',
            basis: 'exchanged_token',
        });
        // And it refused BEFORE touching the database, because a spent token
        // should not cost a round trip.
        expect(findFirst).not.toHaveBeenCalled();
    });

    it('recognises its own tokens and nothing else', () => {
        expect(isExchangedToken(`${MCP_EXCHANGED_TOKEN_PREFIX}abc.def`)).toBe(true);
        expect(isExchangedToken('iflk_0123456789abcdef')).toBe(false);
        expect(isExchangedToken('')).toBe(false);
    });
});

describe('a revoked key is refused on the very next invocation', () => {
    it('the SAME invocation object allows a call, then refuses after the revoke', async () => {
        // This is the whole of subpoint 6. One `McpInvocation`, built once —
        // which is exactly what a workflow run holds across its steps.
        const inv = invocationFor(['list_risks', 'list_controls']);

        findFirst.mockResolvedValueOnce({ revokedAt: null, expiresAt: null });
        expect(await refusalOf(() => authorizeToolCall(inv, TOOL_X))).toBeNull();

        // The operator revokes. Nothing about `inv` changes.
        findFirst.mockResolvedValueOnce({ revokedAt: at(1), expiresAt: null });
        const refusal = await refusalOf(() => authorizeToolCall(inv, TOOL_Y));
        expect(refusal).toContain('revoked');

        // Re-read per call, uncached: two calls, two reads. A cache here — even
        // one scoped to a single execution — reopens the window.
        expect(findFirst).toHaveBeenCalledTimes(2);
        expect(findFirst.mock.calls[1][0].where).toEqual({ id: API_KEY_ID, tenantId: TENANT });
    });

    it('a key that has vanished is treated as revoked, not as absent', async () => {
        findFirst.mockResolvedValueOnce(null);
        const inv = invocationFor(null);
        expect(await refusalOf(() => authorizeToolCall(inv, TOOL_X))).toContain('revoked');
        expect(auditRows.mock.calls[0][0].detailsJson).toMatchObject({
            reason: 'credential_revoked',
            basis: 'missing',
        });
    });

    it('an expired API key is refused with its own basis, so the two are told apart', async () => {
        findFirst.mockResolvedValueOnce({ revokedAt: null, expiresAt: at(-1) });
        const inv = invocationFor(null);
        expect(await refusalOf(() => authorizeToolCall(inv, TOOL_X))).toContain('expired');
        expect(auditRows.mock.calls[0][0].detailsJson).toMatchObject({
            reason: 'credential_expired',
            basis: 'api_key',
        });
    });

    it('a session-authenticated caller has no key to re-read and is not refused', async () => {
        // The workflow engine started by a signed-in human. Its session was
        // checked upstream; there is no bearer credential to revoke.
        const inv = invocationFor(null, {
            credential: { apiKeyId: null, tokenExpiresAt: null },
        });
        expect(await refusalOf(() => authorizeToolCall(inv, TOOL_X))).toBeNull();
        expect(findFirst).not.toHaveBeenCalled();
    });

    it('liveness is checked BEFORE exposure, so a revoked key learns nothing about grants', async () => {
        findFirst.mockResolvedValueOnce({ revokedAt: at(1), expiresAt: null });
        const inv = invocationFor(null, { grantedTools: new Set<string>() });
        const refusal = await refusalOf(() => authorizeToolCall(inv, TOOL_X));
        expect(refusal).toContain('revoked');
        expect(refusal).not.toContain('not granted');
    });
});
