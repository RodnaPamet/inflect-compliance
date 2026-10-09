/**
 * #3330 — minting the token that IS the grant endpoint's security boundary.
 *
 * WHAT IS BEING PROTECTED
 * ───────────────────────
 * Three things, and the second is the one that would have shipped broken.
 *
 *   1. THE SECRET'S STRENGTH IS NOT OPERATOR-CHOSEN. Nothing else in this
 *      system would notice a four-character secret, so the length is a declared
 *      constant and asserted here. A boundary whose weakest point is somebody's
 *      imagination is a boundary with an unmeasured weakest point.
 *
 *   2. A TOKEN MINTED ONTO AN OAUTH CONNECTION WOULD NEVER BE SENT.
 *      `authorizationFor` returns the static `secrets.authorization` header ONLY
 *      when no OAuth field is set; if `clientSecret`/`refreshToken` are present
 *      it mints an access token instead and the static value is never read. So
 *      the endpoint would compare against a credential the dispatch does not
 *      present, every grant would refuse as a mismatch, and the cause would be
 *      invisible from either side. Refused at mint time, which is the one moment
 *      somebody is looking.
 *
 *   3. THE OTHER SECRETS SURVIVE. A connection's secrets are one JSON blob and
 *      this is one key in it. Writing a fresh object would silently drop
 *      whatever else is there.
 */
const updateMock = jest.fn(async () => ({}));
const findFirstMock = jest.fn();
const logEventMock = jest.fn(async () => undefined);
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_c: unknown, fn: (db: unknown) => unknown) =>
        fn({ integrationConnection: { findFirst: findFirstMock, update: updateMock } }),
}));
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: (...a: unknown[]) => logEventMock(...(a as [])),
}));
// Identity crypto, so the stored blob is readable in the assertions. The real
// encryption is covered by its own suite; what matters here is WHAT is written.
jest.mock('@/lib/security/encryption', () => ({
    encryptField: (v: string) => v,
    decryptField: (v: string) => v,
}));

import {
    describeMintRefusal,
    GRANT_TOKEN_SECRET_BYTES,
    mintMcpServerToken,
} from '@/app-layer/usecases/mcp-server-token';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('OWNER', { tenantId: 'tenant-A' });
const CONN = 'ckz1abc234def';

const row = (over: Record<string, unknown> = {}) => ({
    id: CONN,
    provider: 'mcp-server',
    secretEncrypted: null,
    configJson: {},
    ...over,
});

/** What was written to `secretEncrypted`, parsed. */
const stored = () => {
    const c = updateMock.mock.calls[0] as unknown as [{ data: { secretEncrypted: string } }];
    return JSON.parse(c[0].data.secretEncrypted) as Record<string, unknown>;
};

beforeEach(() => {
    jest.clearAllMocks();
    findFirstMock.mockResolvedValue(row());
});

describe('the token is composed and strong, not typed by hand', () => {
    it('is <connectionId>.<secret>, so nobody concatenates anything', async () => {
        const out = await mintMcpServerToken(ctx, CONN);
        expect(out.ok).toBe(true);
        const token = out.ok ? out.token : '';
        expect(token.startsWith(`${CONN}.`)).toBe(true);
    });

    it('carries a secret of the DECLARED length, which no operator picks', async () => {
        const out = await mintMcpServerToken(ctx, CONN);
        const secret = (out.ok ? out.token : '').slice(CONN.length + 1);
        // base64url of N bytes is ceil(4N/3) chars with no padding.
        const expected = Math.ceil((GRANT_TOKEN_SECRET_BYTES * 4) / 3);
        expect(secret).toHaveLength(expected);
        // And the constant is not quietly small. 16 bytes would still pass the
        // length check above, so the floor is asserted separately.
        expect(GRANT_TOKEN_SECRET_BYTES).toBeGreaterThanOrEqual(32);
        expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('two mints do not produce the same secret', async () => {
        const a = await mintMcpServerToken(ctx, CONN);
        const b = await mintMcpServerToken(ctx, CONN);
        expect(a.ok && b.ok && a.token === b.token).toBe(false);
    });

    it('stores it under the field the dispatch sends and the endpoint compares', async () => {
        const out = await mintMcpServerToken(ctx, CONN);
        expect(stored().authorization).toBe(out.ok ? out.token : 'MISMATCH');
    });
});

describe('the rest of the connection survives', () => {
    it('MERGES into existing secrets rather than replacing the blob', async () => {
        findFirstMock.mockResolvedValue(
            row({ secretEncrypted: JSON.stringify({ somethingElse: 'keep-me' }) }),
        );
        await mintMcpServerToken(ctx, CONN);
        expect(stored().somethingElse).toBe('keep-me');
        expect(typeof stored().authorization).toBe('string');
    });

    it('REFUSES rather than overwrite secrets that will not decrypt', async () => {
        // Replacing an unreadable blob with a fresh one destroys whatever it
        // holds in order to add a field. The operator needs the key fixed, not
        // the row emptied.
        findFirstMock.mockResolvedValue(row({ secretEncrypted: 'not-json' }));
        await expect(mintMcpServerToken(ctx, CONN)).rejects.toThrow(/could not be decrypted/);
        expect(updateMock).not.toHaveBeenCalled();
    });
});

describe('a token that would never be sent is refused at mint time', () => {
    /**
     * ALL FOUR OF `authorizationFor`'s TRIGGER FIELDS, and two of them are on
     * `configJson` rather than in the secret blob:
     *
     *     const tenantId     = str(config.tenantId);
     *     const clientId     = str(config.clientId);
     *     const clientSecret = str(secrets.clientSecret);
     *     const refreshToken = str(secrets.refreshToken);
     *     if (tenantId || clientId || clientSecret || refreshToken) { …OAuth… }
     *
     * The first version of this test covered only the secrets, which is the
     * shape the ONE REAL `mcp-server` connection in production does NOT have —
     * it carries `clientId` and `tenantId` in its config. So the check passed a
     * connection it had to refuse, and the table below is split by WHERE the
     * field lives precisely so a future reader cannot lose that again.
     */
    it.each([
        ['secrets', 'clientSecret'],
        ['secrets', 'refreshToken'],
        ['config', 'tenantId'],
        ['config', 'clientId'],
    ])(
        'refuses when %s.%s is set — the dispatch would send an OAuth bearer instead',
        async (where, field) => {
            findFirstMock.mockResolvedValue(
                where === 'secrets'
                    ? row({ secretEncrypted: JSON.stringify({ [field]: 'x' }) })
                    : row({ configJson: { [field]: 'x' } }),
            );
            const out = await mintMcpServerToken(ctx, CONN);
            expect(out.ok).toBe(false);
            expect(out.ok === false && out.refusal.kind).toBe('oauth_configured');
            // Nothing written: the refusal is the deliverable.
            expect(updateMock).not.toHaveBeenCalled();
        },
    );

    it('refuses the shape the REAL production connection has', async () => {
        // Not a hypothetical. The one `mcp-server` connection in production
        // points at Microsoft's own server with `clientId` and `tenantId` in
        // config and no OAuth secrets — the exact combination the first version
        // of this check waved through.
        findFirstMock.mockResolvedValue(
            row({
                configJson: {
                    url: 'https://mcp.svc.cloud.microsoft/enterprise',
                    clientId: '186cef0d-3fbf-4ce0-9811-7d310aeb2401',
                    tenantId: '0fc6f345-0eee-4408-89a9-96fdd1b6439d',
                },
            }),
        );
        const out = await mintMcpServerToken(ctx, CONN);
        expect(out.ok === false && out.refusal.kind).toBe('oauth_configured');
    });

    it('the sentence says what to DO about it, not just that it failed', async () => {
        const text = describeMintRefusal({ kind: 'oauth_configured' });
        expect(text).toContain('never sends the static Authorization secret');
        expect(text).toContain('Clear the OAuth fields');
    });

    it.each([
        ['secrets', 'clientSecret'],
        ['config', 'tenantId'],
    ])('a whitespace-only %s.%s does not count as configured', async (where, field) => {
        findFirstMock.mockResolvedValue(
            where === 'secrets'
                ? row({ secretEncrypted: JSON.stringify({ [field]: '   ' }) })
                : row({ configJson: { [field]: '   ' } }),
        );
        const out = await mintMcpServerToken(ctx, CONN);
        expect(out.ok).toBe(true);
    });
});

describe('the wrong connection is refused, naming which', () => {
    it('refuses a connection that is not an mcp-server one', async () => {
        findFirstMock.mockResolvedValue(row({ provider: 'legacy-mcp' }));
        const out = await mintMcpServerToken(ctx, CONN);
        expect(out.ok === false && out.refusal.kind).toBe('wrong_provider');
        expect(describeMintRefusal({ kind: 'wrong_provider', provider: 'legacy-mcp' })).toContain(
            'legacy-mcp',
        );
    });

    it('refuses a connection that does not exist', async () => {
        findFirstMock.mockResolvedValue(null);
        const out = await mintMcpServerToken(ctx, CONN);
        expect(out.ok === false && out.refusal.kind).toBe('not_found');
        expect(updateMock).not.toHaveBeenCalled();
    });
});

describe('rotation, and what the audit row may say', () => {
    it('reports rotated=false on a first mint and true on a second', async () => {
        const first = await mintMcpServerToken(ctx, CONN);
        expect(first.ok && first.rotated).toBe(false);

        findFirstMock.mockResolvedValue(
            row({ secretEncrypted: JSON.stringify({ authorization: `${CONN}.old` }) }),
        );
        const second = await mintMcpServerToken(ctx, CONN);
        expect(second.ok && second.rotated).toBe(true);
    });

    it('the audit row carries NO part of the token', async () => {
        const out = await mintMcpServerToken(ctx, CONN);
        const token = out.ok ? out.token : '';
        const secret = token.slice(CONN.length + 1);
        const serialised = JSON.stringify(logEventMock.mock.calls[0]);
        // POSITIVE CONTROL first: a negated assertion over an empty window
        // passes while checking nothing.
        expect(serialised).toContain('MCP_GRANT_TOKEN_MINTED');
        expect(serialised).not.toContain(secret);
        // The connection id MAY appear — it is the entity the row is about, and
        // it is not the secret half.
        expect(serialised).toContain(CONN);
    });

    it('records the secret LENGTH, so an auditor can see a weak one was refused', async () => {
        await mintMcpServerToken(ctx, CONN);
        const serialised = JSON.stringify(logEventMock.mock.calls[0]);
        expect(serialised).toContain(String(GRANT_TOKEN_SECRET_BYTES));
    });
});
