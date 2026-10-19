/**
 * The scanner's Okta source over a fixture org (#3678).
 *
 *   1. It finds service apps and API tokens, with their owners, and nothing else.
 *   2. READ-ONLY, by its request log: every request is a GET to a declared path
 *      on the configured org, and it never asks for an app's client secrets —
 *      the fake would hand them over if it did.
 *   4. ITS OWN TOKEN IS NOT A SHADOW PRINCIPAL. The scanner identifies the token
 *      it reads with by id, from `/api-tokens/current`, and reports every other
 *      token — including one that carries the same name.
 *   3. An org it cannot read is INCOMPLETE with the contract's reason, for every
 *      way a read can stop, and what it read before stopping is kept.
 */
import {
    createSourceFakes,
    OKTA_ORG,
    OKTA_TOKEN_VALUE,
    oktaFixture,
    OKTA_CLIENT_SECRET_VALUE,
    SCANNER_OKTA_TOKEN_ID,
    type Fakes,
} from '../../helpers/agent-harness-source-fakes';
import { createSourceWire } from '../../../packages/agent-harness-scanner/src/http';
import { isDeclaredRequest } from '../../../packages/agent-harness-scanner/src/scanner-surface';
import { oktaSource, OKTA_READ_PATHS } from '../../../packages/agent-harness-scanner/src/sources/okta';
import type { SourceRead } from '../../../packages/agent-harness-scanner/src/source';

const ASOF = new Date('2026-10-19T03:00:00.000Z');

async function read(fakes: Fakes, opts: { token?: string; now?: () => number; caps?: { response?: number; source?: number } } = {}): Promise<SourceRead> {
    const now = opts.now ?? (() => ASOF.getTime());
    const wire = createSourceWire({ fetchImpl: fakes.fetchImpl, deadline: ASOF.getTime() + 60_000, now }, opts.caps);
    const source = oktaSource({ orgUrl: OKTA_ORG, apiToken: opts.token ?? OKTA_TOKEN_VALUE, ownerProfileKey: 'owner' });
    return source.read({ asOf: ASOF, deadline: Number.MAX_SAFE_INTEGER, now: Date.now, ...wire });
}

describe('1. what the Okta source finds', () => {
    it('reports each service app and API token as a principal, with its owner', async () => {
        const fakes = createSourceFakes();
        const result = await read(fakes);

        // Three apps and three tokens read, the scanner's own among them.
        expect(result).toMatchObject({ kind: 'okta-app', status: 'COMPLETE', rows: 6 });
        expect(result.reason).toBeUndefined();
        const byId = new Map(result.observations.map((o) => [o.discoveredId, o]));
        // The web app is an OIDC app but not a service app: no principal.
        expect([...byId.keys()].sort()).toEqual([
            'okta:api-token:00TToken1',
            'okta:api-token:00TToken2',
            'okta:app:0oaService1',
            'okta:app:0oaService2',
        ]);
        expect(byId.get('okta:app:0oaService1')).toMatchObject({
            owner: { kind: 'user', id: 'jane.doe@acme.example', source: 'okta-app-profile' },
            credentials: [{ ref: 'okta://acme.okta.com/apps/0oaService1/oauth-client', ageDays: null, boundToAgent: true, grant: 'app-only' }],
        });
        // No profile owner: reported unowned, never guessed.
        expect(byId.get('okta:app:0oaService2')?.owner).toBeNull();
        expect(byId.get('okta:api-token:00TToken1')).toMatchObject({
            owner: { kind: 'user', id: '00uAdmin1', source: 'okta-api-token' },
            credentials: [{ ref: 'okta://acme.okta.com/api-tokens/00TToken1', ageDays: 110, expires: true, boundToAgent: false, grant: 'delegated' }],
            verdicts: [{ criterion: 'H2.credential_bound', met: false }],
        });
        expect(byId.get('okta:api-token:00TToken2')?.credentials[0]).toMatchObject({ ageDays: 18, expires: false });
    });

    it('never names a register agent, whatever the app profile says', async () => {
        const fixture = oktaFixture();
        (fixture.apps[0][0] as { profile: Record<string, string> }).profile.inflectAgentId = 'agt_claimed';
        const result = await read(createSourceFakes({ okta: fixture }));
        expect(JSON.stringify(result)).not.toContain('agt_claimed');
        expect(result.observations.every((o) => !('registeredAgentId' in o))).toBe(true);
    });
});

describe('2. read-only, by the request log', () => {
    it('every request is a GET to a declared path on the org — and never the client-secret endpoint', async () => {
        const fakes = createSourceFakes();
        const result = await read(fakes);

        // Two pages of apps, the current-token read, two pages of tokens.
        expect(fakes.log.map((r) => r.path)).toEqual([
            '/api/v1/apps',
            '/api/v1/apps',
            '/api/v1/api-tokens/current',
            '/api/v1/api-tokens',
            '/api/v1/api-tokens',
        ]);
        for (const req of fakes.log) {
            expect(req.method).toBe('GET');
            expect(req.host).toBe('acme.okta.com');
            expect(OKTA_READ_PATHS as readonly string[]).toContain(req.path);
            expect(isDeclaredRequest(req.method, `https://${req.host}${req.path}${req.query}`)).toBe(true);
        }
        expect(fakes.log.some((r) => r.path.includes('/credentials'))).toBe(false);
        expect(JSON.stringify(result)).not.toContain(OKTA_CLIENT_SECRET_VALUE);
        expect(JSON.stringify(result)).not.toContain(OKTA_TOKEN_VALUE);
    });

    it('asks Okta for OIDC apps with a %20-encoded filter', async () => {
        const fakes = createSourceFakes();
        await read(fakes);
        expect(fakes.log[0].query).toBe('?limit=200&filter=name%20eq%20%22oidc_client%22');
    });
});

describe('3. an org it cannot read is INCOMPLETE with a reason', () => {
    it('a rejected token is AUTH_FAILED, before anything is read', async () => {
        const result = await read(createSourceFakes(), { token: 'not-the-token' });
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'AUTH_FAILED', rows: 0, observations: [] });
    });

    it('a token that cannot list API tokens is AUTH_FAILED, and the apps it read are kept', async () => {
        const fakes = createSourceFakes();
        fakes.override = (r) => (r.path === '/api/v1/api-tokens' ? { status: 403, body: { errorCode: 'E0000006' } } : undefined);
        const result = await read(fakes);
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'AUTH_FAILED', rows: 3 });
        expect(result.observations.map((o) => o.discoveredId).sort()).toEqual(['okta:app:0oaService1', 'okta:app:0oaService2']);
    });

    it.each([
        ['rate limiting', { status: 429 }, 'RATE_LIMITED'],
        ['a server error', { status: 503 }, 'UNREACHABLE'],
        ['a page that is not a listing', { status: 200, raw: '{"not":"an array"}', headers: { 'content-type': 'application/json' } }, 'PAGINATION_TORN'],
        ['a page that is not JSON', { status: 200, raw: '<html>', headers: { 'content-type': 'text/html' } }, 'PAGINATION_TORN'],
    ] as const)('%s → %s', async (_label, answer, reason) => {
        const fakes = createSourceFakes();
        fakes.override = (r) => (r.path === '/api/v1/apps' ? answer : undefined);
        expect(await read(fakes)).toMatchObject({ status: 'INCOMPLETE', reason });
    });

    it('a network failure is UNREACHABLE', async () => {
        const fakes = createSourceFakes();
        fakes.override = () => 'throw';
        expect(await read(fakes)).toMatchObject({ status: 'INCOMPLETE', reason: 'UNREACHABLE' });
    });

    it('a next link off the org is not followed — the token never leaves — and the read is PAGINATION_TORN', async () => {
        const fakes = createSourceFakes();
        fakes.override = (r) =>
            r.path === '/api/v1/apps'
                ? { status: 200, body: [], headers: { link: '<https://evil.example/api/v1/apps?after=1>; rel="next"' } }
                : undefined;
        expect(await read(fakes)).toMatchObject({ status: 'INCOMPLETE', reason: 'PAGINATION_TORN' });
        expect(fakes.log.map((r) => r.host)).toEqual(['acme.okta.com']);
    });

    it('a next link back to a page already served is a loop: PAGINATION_TORN', async () => {
        const fakes = createSourceFakes();
        fakes.override = (r) =>
            r.path === '/api/v1/apps'
                ? { status: 200, body: [], headers: { link: `<${OKTA_ORG}/api/v1/apps?limit=200&after=0>; rel="next"` } }
                : undefined;
        expect(await read(fakes)).toMatchObject({ status: 'INCOMPLETE', reason: 'PAGINATION_TORN' });
        expect(fakes.log).toHaveLength(2);
    });

    it('a response past the byte cap is BYTE_CAP', async () => {
        expect(await read(createSourceFakes(), { caps: { response: 64 } })).toMatchObject({ status: 'INCOMPLETE', reason: 'BYTE_CAP' });
    });

    it('a read past its time box is TIME_BOX, with the pages before it kept', async () => {
        let t = ASOF.getTime();
        const fakes = createSourceFakes();
        const inner = fakes.fetchImpl;
        // Each request advances the clock 40 s against a 60 s time box.
        const slow: typeof inner = async (url, init) => {
            t += 40_000;
            return inner(url, init);
        };
        const wire = createSourceWire({ fetchImpl: slow, deadline: ASOF.getTime() + 60_000, now: () => t });
        const result = await oktaSource({ orgUrl: OKTA_ORG, apiToken: OKTA_TOKEN_VALUE, ownerProfileKey: 'owner' }).read({ asOf: ASOF, deadline: Number.MAX_SAFE_INTEGER, now: Date.now, ...wire });
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'TIME_BOX', rows: 3 });
    });

    it('an app with no usable id is a torn page, not a skipped row', async () => {
        const fixture = oktaFixture();
        fixture.apps[0].push({ id: 'has a space', signOnMode: 'OPENID_CONNECT' });
        expect(await read(createSourceFakes({ okta: fixture }))).toMatchObject({ status: 'INCOMPLETE', reason: 'PAGINATION_TORN' });
    });
});

describe('4. the scanner\'s own token is not a shadow principal', () => {
    it('is identified by id from /current and left out; every other token is reported', async () => {
        const result = await read(createSourceFakes());
        const tokens = result.observations.map((o) => o.discoveredId).filter((id) => id.startsWith('okta:api-token:'));
        expect(tokens.sort()).toEqual(['okta:api-token:00TToken1', 'okta:api-token:00TToken2']);
        expect(tokens).not.toContain(`okta:api-token:${SCANNER_OKTA_TOKEN_ID}`);
        // It was read, so it is counted: the row count is the population read.
        expect(result.rows).toBe(6);
    });

    it('a name is never the test: another token named like the scanner\'s is still reported', async () => {
        const fixture = oktaFixture();
        // 00TToken2 already carries the scanner token's name; make the match exact.
        const own = fixture.tokens[0][1] as { name: string };
        expect((fixture.tokens[1][0] as { name: string }).name).toBe(own.name);
        const result = await read(createSourceFakes({ okta: fixture }));
        expect(result.observations.map((o) => o.discoveredId)).toContain('okta:api-token:00TToken2');
    });

    it('when /current names a different token, that one is left out and the scanner\'s listed token is reported', async () => {
        const fixture = oktaFixture();
        fixture.currentTokenId = '00TToken1';
        const ids = (await read(createSourceFakes({ okta: fixture }))).observations.map((o) => o.discoveredId);
        expect(ids).toContain(`okta:api-token:${SCANNER_OKTA_TOKEN_ID}`);
        expect(ids).not.toContain('okta:api-token:00TToken1');
    });

    it('a scanner that cannot identify its own token stops before the list, with the reason', async () => {
        const denied = createSourceFakes();
        denied.override = (r) => (r.path === '/api/v1/api-tokens/current' ? { status: 403, body: { errorCode: 'E0000006' } } : undefined);
        const result = await read(denied);
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'AUTH_FAILED', rows: 3 });
        expect(result.observations.some((o) => o.discoveredId.startsWith('okta:api-token:'))).toBe(false);
        expect(denied.log.some((r) => r.path === '/api/v1/api-tokens')).toBe(false);

        const anonymous = createSourceFakes();
        anonymous.override = (r) => (r.path === '/api/v1/api-tokens/current' ? { status: 200, body: { name: 'no id' } } : undefined);
        expect(await read(anonymous)).toMatchObject({ status: 'INCOMPLETE', reason: 'PAGINATION_TORN' });
    });
});
