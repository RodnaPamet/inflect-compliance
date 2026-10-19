/**
 * The scanner's GCP service-account source over a fixture project (#3785).
 *
 *   1. WHAT IT FINDS. Every enabled service account but the scanner's own is a
 *      principal, keyed on its numeric id, with its enabled user-managed keys
 *      by reference. A disabled account is a row; the scanner's own account,
 *      identified by the key it signs with, is not reported. Nothing that can
 *      name a person — an e-mail address, a display name, a description —
 *      reaches the result.
 *   2. AUTHENTICATION. One JWT-bearer exchange at `oauth2.googleapis.com`, with
 *      an assertion the fake verifies against the key's public half, and never
 *      at the `token_uri` a key file names.
 *   3. READ-ONLY, by the request log: GETs to the two declared paths on
 *      `iam.googleapis.com`, and the one token POST.
 *   4. FAIL CLOSED. Every way the read can stop is INCOMPLETE with the
 *      contract's reason, and what was read before it stopped is kept.
 *   5. END TO END, the signed report speaks `/3` and verifies with the ingest's
 *      own verifier, and the key's private half is nowhere in it.
 */
import { createVerify, generateKeyPairSync } from 'crypto';

import { HARNESS_CONTRACT_V3, verifyAndParseHarnessReport } from '@/lib/agentic/harness-contract';
import { credentialEnvNames, parseScannerConfig } from '../../../packages/agent-harness-scanner/src/config';
import { createSourceWire, JWT_BEARER_GRANT, type FetchLike } from '../../../packages/agent-harness-scanner/src/http';
import { jsonLineLog } from '../../../packages/agent-harness-scanner/src/log';
import { rawPublicKeyHex } from '../../../packages/agent-harness-scanner/src/report';
import { runScan } from '../../../packages/agent-harness-scanner/src/scan';
import { isDeclaredRequest } from '../../../packages/agent-harness-scanner/src/scanner-surface';
import {
    GCP_IAM_SCOPE,
    gcpServiceAccountSource,
    parseServiceAccountKey,
} from '../../../packages/agent-harness-scanner/src/sources/gcp-service-accounts';
import type { SourceRead } from '../../../packages/agent-harness-scanner/src/source';

const ASOF = new Date('2026-10-19T03:00:00.000Z');
const IAM = 'https://iam.googleapis.com';
const OAUTH = 'https://oauth2.googleapis.com';
/** Distinctive, and deliberately not token-shaped: it is searched for, never used. */
const GCP_ACCESS_TOKEN_VALUE = 'fake-google-access-token-value-3785';
const SCANNER_EMAIL = 'harness-scanner@acme-prod-319.iam.gserviceaccount.com';
/** Markers in the members the source must drop: each could name a person. */
const MARKERS = {
    email: 'jane.doe.marker',
    displayName: 'display-name-marker-3785',
    description: 'description-marker-3785',
} as const;

const daysBefore = (days: number) => new Date(ASOF.getTime() - days * 86_400_000).toISOString();
const NEVER = '9999-12-31T23:59:59Z';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function keyJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        type: 'service_account',
        project_id: 'acme-prod-319',
        private_key_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        private_key: PRIVATE_PEM,
        client_email: SCANNER_EMAIL,
        client_id: '100000000000000000001',
        token_uri: `${OAUTH}/token`,
        ...overrides,
    });
}

const id = (n: number) => `1042388561234567890${n}`;
/** A key's resource name, as Google gives it: under the account's e-mail address, which the source must not carry. */
const keyName = (keyId: string) => `projects/acme-prod-319/serviceAccounts/${MARKERS.email}@acme-prod-319.iam.gserviceaccount.com/keys/${keyId}`;

interface Project {
    accounts: unknown[][];
    keys: Record<string, unknown[] | undefined>;
}

function fixture(): Record<string, Project> {
    return {
        'acme-prod-319': {
            accounts: [
                [
                    {
                        name: 'projects/acme-prod-319/serviceAccounts/reporting',
                        uniqueId: id(12),
                        email: `${MARKERS.email}@acme-prod-319.iam.gserviceaccount.com`,
                        displayName: MARKERS.displayName,
                        description: MARKERS.description,
                    },
                    { uniqueId: id(13), email: '123456789-compute@developer.gserviceaccount.com' },
                ],
                [
                    { uniqueId: id(14), email: 'retired@acme-prod-319.iam.gserviceaccount.com', disabled: true },
                    // The scanner's own account: named like any other.
                    { uniqueId: id(15), email: SCANNER_EMAIL.toUpperCase(), displayName: MARKERS.displayName },
                    { uniqueId: id(16), email: 'exporter@acme-prod-319.iam.gserviceaccount.com' },
                ],
            ],
            keys: {
                [id(12)]: [
                    { name: keyName('2f1a9c0e3b4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f'), validAfterTime: daysBefore(400), validBeforeTime: NEVER, keyType: 'USER_MANAGED' },
                    { name: keyName('9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d'), validAfterTime: daysBefore(30), validBeforeTime: NEVER, disabled: true },
                ],
                // Google omits an empty collection: no `keys` member at all.
                [id(13)]: undefined,
                [id(16)]: [{ name: keyName('0123456789abcdef0123456789abcdef01234567'), validAfterTime: daysBefore(10), validBeforeTime: '2027-01-01T00:00:00Z' }],
            },
        },
        'acme-data-204': { accounts: [[]], keys: {} },
    };
}

type Answer = { status: number; body?: unknown } | 'throw';

interface Fake {
    readonly fetchImpl: FetchLike;
    readonly log: { method: string; url: string; authorization: string | null; body: string | null }[];
    override: ((url: URL, method: string) => Answer | undefined) | null;
    /** The claims of every assertion the token endpoint verified. */
    readonly assertions: Record<string, unknown>[];
}

function verifyAssertion(jwt: string): Record<string, unknown> | null {
    const [h, c, sig] = jwt.split('.');
    if (!h || !c || !sig) return null;
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${h}.${c}`);
    if (!verifier.verify(publicKey, Buffer.from(sig, 'base64url'))) return null;
    const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { alg?: string };
    return header.alg === 'RS256' ? (JSON.parse(Buffer.from(c, 'base64url').toString()) as Record<string, unknown>) : null;
}

function googleFake(projects: Record<string, Project>): Fake {
    const fake: Fake = {
        log: [],
        assertions: [],
        override: null,
        fetchImpl: async (url, init) => {
            const u = new URL(url);
            const method = (init.method ?? 'GET').toUpperCase();
            const headers = new Headers(init.headers);
            fake.log.push({ method, url, authorization: headers.get('authorization'), body: init.body === undefined ? null : String(init.body) });
            const answer = fake.override?.(u, method) ?? route(u, method, headers, init.body === undefined ? '' : String(init.body));
            if (answer === 'throw') throw new TypeError('fetch failed');
            return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
                status: answer.status,
                headers: { 'content-type': 'application/json' },
            });
        },
    };

    function route(u: URL, method: string, headers: Headers, body: string): Exclude<Answer, 'throw'> {
        if (u.origin === OAUTH && u.pathname === '/token' && method === 'POST') {
            const form = new URLSearchParams(body);
            const claims = form.get('grant_type') === JWT_BEARER_GRANT ? verifyAssertion(form.get('assertion') ?? '') : null;
            if (claims === null || claims.aud !== `${OAUTH}/token` || claims.iss !== SCANNER_EMAIL) {
                return { status: 400, body: { error: 'invalid_grant' } };
            }
            fake.assertions.push(claims);
            return { status: 200, body: { access_token: GCP_ACCESS_TOKEN_VALUE, expires_in: 3599, token_type: 'Bearer' } };
        }
        if (u.origin !== IAM) return { status: 404, body: { error: { code: 404 } } };
        if (headers.get('authorization') !== `Bearer ${GCP_ACCESS_TOKEN_VALUE}`) return { status: 401, body: { error: { code: 401 } } };
        if (method !== 'GET') return { status: 405, body: { error: { code: 405 } } };
        const list = /^\/v1\/projects\/([^/]+)\/serviceAccounts$/.exec(u.pathname);
        const keys = /^\/v1\/projects\/([^/]+)\/serviceAccounts\/([^/]+)\/keys$/.exec(u.pathname);
        const project = projects[(list ?? keys)?.[1] ?? ''];
        if (!project) return { status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED' } } };
        if (list) {
            const at = Number(u.searchParams.get('pageToken') ?? '0');
            const accounts = project.accounts[at] ?? [];
            const next = at + 1 < project.accounts.length ? String(at + 1) : undefined;
            return { status: 200, body: { ...(accounts.length > 0 ? { accounts } : {}), ...(next ? { nextPageToken: next } : {}) } };
        }
        if (keys && u.searchParams.get('keyTypes') === 'USER_MANAGED') {
            const listed = project.keys[keys[2]];
            return { status: 200, body: listed === undefined ? {} : { keys: listed } };
        }
        return { status: 404, body: { error: { code: 404 } } };
    }
    return fake;
}

async function read(fake: Fake, opts: { projects?: string[]; key?: string } = {}): Promise<SourceRead> {
    const wire = createSourceWire({ fetchImpl: fake.fetchImpl, deadline: ASOF.getTime() + 60_000, now: () => ASOF.getTime() });
    return gcpServiceAccountSource({ projects: opts.projects ?? ['acme-prod-319', 'acme-data-204'], keyJson: opts.key ?? keyJson() }).read({
        asOf: ASOF,
        deadline: Number.MAX_SAFE_INTEGER,
        now: () => ASOF.getTime(),
        ...wire,
    });
}

const keyRef = (account: number, keyId: string) => `gcp-sa-key://acme-prod-319/${id(account)}/${keyId}`;

describe('1. what the GCP service-account source finds', () => {
    it('reports every enabled account but its own, by id, with its enabled user-managed keys', async () => {
        const result = await read(googleFake(fixture()));

        // Five accounts listed across two pages; the empty project lists none.
        expect(result).toMatchObject({ kind: 'gcp-sa', status: 'COMPLETE', rows: 5 });
        expect(result.observations.map((o) => o.discoveredId)).toEqual([`gcp:sa:${id(12)}`, `gcp:sa:${id(13)}`, `gcp:sa:${id(16)}`]);
        const [reporting, compute, exporter] = result.observations;
        expect(reporting).toEqual({
            discoveredId: `gcp:sa:${id(12)}`,
            owner: null,
            // The disabled key authenticates nothing and is not reported.
            credentials: [
                { ref: keyRef(12, '2f1a9c0e3b4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f'), ageDays: 400, expires: false, boundToAgent: true, grant: 'app-only' },
            ],
            verdicts: [
                { criterion: 'H2.credential_bound', met: true, evidence: `gcp-sa:projects/acme-prod-319/serviceAccounts/${id(12)}/keys#keyTypes=USER_MANAGED` },
                { criterion: 'H2.grant_kind_declared', met: true, evidence: `gcp-sa:projects/acme-prod-319/serviceAccounts/${id(12)}#serviceAccount` },
            ],
        });
        // A default account with no user-managed key: a principal, holding no key.
        expect(compute.credentials).toEqual([]);
        expect(exporter.credentials).toEqual([expect.objectContaining({ ageDays: 10, expires: true })]);
    });

    it('identifies its own account by the key it signs with, whatever the account is named', async () => {
        const result = await read(googleFake(fixture()));
        expect(result.observations.some((o) => o.discoveredId === `gcp:sa:${id(15)}`)).toBe(false);
        // A disabled account is counted and is not a principal.
        expect(result.observations.some((o) => o.discoveredId === `gcp:sa:${id(14)}`)).toBe(false);
    });

    it('carries no e-mail address, display name or description, and no token', async () => {
        const text = JSON.stringify(await read(googleFake(fixture())));
        for (const marker of [...Object.values(MARKERS), GCP_ACCESS_TOKEN_VALUE, '@']) expect(text.includes(marker)).toBe(false);
    });
});

describe('2. authentication: one JWT-bearer exchange, at Google, signed with the key', () => {
    it('sends an RS256 assertion the key\'s public half verifies, for the IAM scope, valid for minutes', async () => {
        const fake = googleFake(fixture());
        expect((await read(fake)).status).toBe('COMPLETE');
        expect(fake.assertions).toHaveLength(1);
        const [claims] = fake.assertions;
        expect(claims).toMatchObject({ iss: SCANNER_EMAIL, aud: `${OAUTH}/token`, scope: GCP_IAM_SCOPE });
        expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(3600);
    });

    it('never sends the assertion to the token_uri a key file names', async () => {
        const fake = googleFake(fixture());
        await read(fake, { key: keyJson({ token_uri: 'https://token-thief.example/token' }) });
        expect(fake.log.some((e) => new URL(e.url).host === 'token-thief.example')).toBe(false);
        expect(fake.log.filter((e) => e.method === 'POST').map((e) => e.url)).toEqual([`${OAUTH}/token`]);
    });

    it.each([
        ['not JSON', 'not-json'],
        ['not a service-account key', keyJson({ type: 'authorized_user' })],
        ['a key with no e-mail', keyJson({ client_email: 'no-at-sign' })],
        ['a private key that cannot sign', keyJson({ private_key: 'not a pem' })],
    ])('refuses %s as AUTH_FAILED, before any request', async (_label, key) => {
        const fake = googleFake(fixture());
        expect(await read(fake, { key })).toMatchObject({ status: 'INCOMPLETE', reason: 'AUTH_FAILED', rows: 0 });
        expect(fake.log).toEqual([]);
    });

    it('parses the key file to the three members it uses and nothing else', () => {
        expect(Object.keys(parseServiceAccountKey(keyJson())).sort()).toEqual(['clientEmail', 'privateKey', 'privateKeyId']);
    });
});

describe('3. read-only, by the request log', () => {
    it('every request is a declared GET on iam.googleapis.com with the token, or the one token POST', async () => {
        const fake = googleFake(fixture());
        await read(fake);
        expect(fake.log.length).toBeGreaterThan(1);
        for (const entry of fake.log) {
            expect(isDeclaredRequest(entry.method, entry.url)).toBe(true);
            if (entry.method === 'GET') {
                expect(new URL(entry.url).origin).toBe(IAM);
                expect(entry.authorization).toBe(`Bearer ${GCP_ACCESS_TOKEN_VALUE}`);
            }
        }
        expect(fake.log.filter((e) => e.method !== 'GET')).toHaveLength(1);
    });

    it('the declared surface does not stretch to a write or another resource', () => {
        expect(isDeclaredRequest('POST', `${IAM}/v1/projects/acme-prod-319/serviceAccounts/${id(12)}/keys`)).toBe(false);
        expect(isDeclaredRequest('POST', 'https://cloudresourcemanager.googleapis.com/v1/projects/acme-prod-319:getIamPolicy')).toBe(false);
        expect(isDeclaredRequest('GET', `${IAM}/v1/projects/acme-prod-319/serviceAccounts/${id(12)}/keys/abc`)).toBe(false);
        expect(isDeclaredRequest('POST', `${OAUTH}/revoke`)).toBe(false);
    });
});

describe('4. fail closed, never silently', () => {
    const accountsPath = '/v1/projects/acme-prod-319/serviceAccounts';
    it.each([
        ['a refused assertion', (u: URL) => (u.origin === OAUTH ? { status: 400, body: { error: 'invalid_grant' } } : undefined), 'AUTH_FAILED'],
        ['a project the account cannot read', (u: URL) => (u.pathname === accountsPath ? { status: 403, body: {} } : undefined), 'AUTH_FAILED'],
        ['the rate limiter', (u: URL) => (u.pathname.endsWith('/keys') ? { status: 429, body: {} } : undefined), 'RATE_LIMITED'],
        ['the network', (u: URL) => (u.pathname.endsWith('/keys') ? ('throw' as const) : undefined), 'UNREACHABLE'],
        ['a page that links back to itself', (u: URL) => (u.pathname === accountsPath ? { status: 200, body: { accounts: [], nextPageToken: '0' } } : undefined), 'PAGINATION_TORN'],
        [
            'an account with no usable id',
            (u: URL) => (u.pathname === accountsPath ? { status: 200, body: { accounts: [{ email: 'x@y' }] } } : undefined),
            'PAGINATION_TORN',
        ],
        ['a key listing that claims to be paged', (u: URL) => (u.pathname.endsWith('/keys') ? { status: 200, body: { keys: [], nextPageToken: 'x' } } : undefined), 'PAGINATION_TORN'],
        ['a key with no usable id', (u: URL) => (u.pathname.endsWith('/keys') ? { status: 200, body: { keys: [{ name: 'projects/p/x' }] } } : undefined), 'PAGINATION_TORN'],
    ] as const)('%s stops the read with its reason', async (_label, override, reason) => {
        const fake = googleFake(fixture());
        fake.override = override as Fake['override'];
        expect(await read(fake)).toMatchObject({ kind: 'gcp-sa', status: 'INCOMPLETE', reason });
    });

    it('an account listed twice across pages is a torn listing, never one principal', async () => {
        const projects = fixture();
        projects['acme-prod-319'].accounts[1].push({ uniqueId: id(12), email: 'again@acme-prod-319.iam.gserviceaccount.com' });
        expect(await read(googleFake(projects))).toMatchObject({ status: 'INCOMPLETE', reason: 'PAGINATION_TORN' });
    });

    it('keeps what it read before the read stopped', async () => {
        const fake = googleFake(fixture());
        fake.override = (u) => (u.pathname === '/v1/projects/acme-data-204/serviceAccounts' ? { status: 403, body: {} } : undefined);
        const result = await read(fake);
        expect(result.status).toBe('INCOMPLETE');
        expect(result.observations).toHaveLength(3);
    });
});

describe('5. end to end: configuration, and a signed /3 report the ingest verifies', () => {
    const config = (overrides: Record<string, unknown> = {}) =>
        parseScannerConfig({
            estate: 'acme-gcp',
            scanner: { agentId: 'agt_scanner_acme', signingKeyEnv: 'SCANNER_SIGNING_KEY' },
            inflect: { baseUrl: 'https://inflect.example.com', tenantSlug: 'acme', apiKeyEnv: 'INFLECT_INGEST_KEY' },
            schedule: { everyHours: 24 },
            sources: [{ kind: 'gcp-sa', product: 'gcp-iam', projects: ['acme-prod-319', 'acme-data-204'], keyEnv: 'GCP_SCANNER_KEY', ...overrides }],
        });

    it('parses a gcp-sa source, names its key variable, and refuses a malformed or repeated project or a pasted key', () => {
        expect(credentialEnvNames(config())).toEqual(['SCANNER_SIGNING_KEY', 'INFLECT_INGEST_KEY', 'GCP_SCANNER_KEY']);
        expect(() => config({ projects: ['Acme-Prod'] })).toThrow(/projects/);
        expect(() => config({ projects: ['acme-prod-319', 'acme-prod-319'] })).toThrow(/projects/);
        expect(() => config({ keyEnv: PRIVATE_PEM })).toThrow(/credential value/);
    });

    it('signs a /3 report the ingest verifies, with the key\'s private half nowhere in it', async () => {
        const signing = generateKeyPairSync('ed25519');
        const fake = googleFake(fixture());
        const lines: string[] = [];
        const { raw, body } = await runScan({
            config: config(),
            env: {
                SCANNER_SIGNING_KEY: signing.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
                INFLECT_INGEST_KEY: 'iflk_fake-ingest-key-3785',
                GCP_SCANNER_KEY: keyJson(),
            },
            log: jsonLineLog((l) => lines.push(l)),
            fetchImpl: fake.fetchImpl,
            now: () => ASOF.getTime(),
        });

        expect(verifyAndParseHarnessReport(raw, [rawPublicKeyHex(signing.publicKey)])).toMatchObject({
            ok: true,
            complete: true,
            body: { contract: HARNESS_CONTRACT_V3 },
        });
        expect(body.population.sources).toEqual([{ kind: 'gcp-sa', status: 'COMPLETE', rows: 5 }]);
        expect(body.agents.map((a) => a.discoveredVia)).toEqual([['gcp-sa'], ['gcp-sa'], ['gcp-sa']]);
        const pemBody = PRIVATE_PEM.split('\n')[1];
        expect([raw, ...lines].some((text) => text.includes(pemBody) || text.includes(GCP_ACCESS_TOKEN_VALUE))).toBe(false);
    });
});
