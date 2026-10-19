/**
 * The scanner's GitHub Actions source over a fixture repository (#3784).
 *
 *   1. WHAT IT FINDS. A workflow that holds a secret, whose run token may write,
 *      or that reaches secrets dynamically is a principal, with its run token,
 *      its OIDC token and its secrets by reference; a read-only workflow that
 *      holds nothing is a row. A repository secret no workflow references is
 *      unbound.
 *   2. WHAT COUNTS AS A REFERENCE. An expression only: prose in a script, a
 *      string literal and a property named `secrets` of another object are not.
 *      Dynamic access is never mistaken for none.
 *   3. READ-ONLY, by the request log: every request is a GET to a declared path
 *      on `api.github.com`, carrying the token, and the per-secret endpoint is
 *      never asked — the fake would answer it with a marker if it were.
 *   4. FAIL CLOSED. Every way the read can stop is INCOMPLETE with the
 *      contract's reason, what was read is kept, and no unbound secret is
 *      claimed for a repository the source could not read whole.
 *   5. END TO END, the signed report verifies with the ingest's own verifier and
 *      carries the unbound secret for the ingest to raise ORPHAN_CREDENTIAL on.
 */
import { generateKeyPairSync } from 'crypto';

import { verifyAndParseHarnessReport } from '@/lib/agentic/harness-contract';
import { credentialEnvNames, parseScannerConfig } from '../../../packages/agent-harness-scanner/src/config';
import { createSourceWire, type FetchLike } from '../../../packages/agent-harness-scanner/src/http';
import { jsonLineLog } from '../../../packages/agent-harness-scanner/src/log';
import { rawPublicKeyHex } from '../../../packages/agent-harness-scanner/src/report';
import { runScan } from '../../../packages/agent-harness-scanner/src/scan';
import { isDeclaredRequest } from '../../../packages/agent-harness-scanner/src/scanner-surface';
import {
    analyseWorkflow,
    GITHUB_DIRECTORY_LISTING_CAP,
    githubActionsSource,
    MAX_WORKFLOW_BYTES,
    secretsInExpression,
    UnparseableWorkflow,
} from '../../../packages/agent-harness-scanner/src/sources/github-actions';
import type { SourceRead } from '../../../packages/agent-harness-scanner/src/source';

const ASOF = new Date('2026-10-19T03:00:00.000Z');
const GH = 'https://api.github.com';
/** Distinctive, and deliberately not token-shaped: it is searched for, never used. */
const GITHUB_READ_TOKEN_VALUE = 'fake-github-read-token-value-3784';
/** What the fake answers the per-secret endpoint with, so a reader that asked would visibly hold it. */
const SECRET_ENDPOINT_MARKER = 'never-requested-secret-endpoint-3784';

const daysBefore = (days: number) => new Date(ASOF.getTime() - days * 86_400_000).toISOString();

const WORKFLOWS: Record<string, string> = {
    'release.yml': `name: Release
on:
  push:
    branches: [main]
permissions:
  contents: write
  issues: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/create-github-app-token@v2
        id: app
        with:
          app-id: \${{ vars.RELEASE_APP_ID }}
          private-key: \${{ secrets.RELEASE_APP_PRIVATE_KEY }}
      - run: |
          # This script names secrets.NOT_A_REFERENCE in its prose, and holds nothing.
          npx semantic-release
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          GH_TOKEN: \${{ steps.app.outputs.token }}
`,
    'evaluate.yml': `name: Evaluate
on: workflow_dispatch
permissions:
  contents: read
jobs:
  evaluate:
    runs-on: ubuntu-latest
    if: \${{ github.ref == 'refs/heads/main' || contains(github.event.head_commit.message, 'secrets.QUOTED') }}
    steps:
      - run: npm run skills:evaluate
        env:
          ANTHROPIC_API_KEY: \${{ secrets.anthropic_api_key }}
`,
    'lint.yml': `on: pull_request
permissions:
  contents: read
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
`,
    'deploy.yaml': `on: push
permissions: {}
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: google-github-actions/auth@v2
`,
    'legacy.yml': `on:
  schedule:
    - cron: '0 3 * * *'
jobs:
  nightly:
    runs-on: ubuntu-latest
    steps:
      - run: echo nightly
`,
};

interface RepoFixture {
    /** File name → text; null when the repository has no workflow directory. */
    workflows: Record<string, string> | null;
    /** Further directory entries, served beside the workflow files. */
    extraEntries?: unknown[];
    secrets: { name: string; updated_at: string }[];
    secretPageSize?: number;
    /** Overrides the `total_count` every secrets page declares. */
    totalCount?: number;
}

function paymentsApi(): RepoFixture {
    return {
        workflows: { ...WORKFLOWS },
        extraEntries: [
            { type: 'file', name: 'README.md' },
            { type: 'dir', name: 'templates' },
        ],
        secrets: [
            { name: 'RELEASE_APP_PRIVATE_KEY', updated_at: daysBefore(30) },
            { name: 'ANTHROPIC_API_KEY', updated_at: daysBefore(10) },
            { name: 'STALE_DEPLOY_KEY', updated_at: daysBefore(365) },
        ],
        secretPageSize: 2,
    };
}

type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | 'throw';

interface Fake {
    readonly fetchImpl: FetchLike;
    readonly log: { method: string; url: string; authorization: string | null }[];
    override: ((url: URL) => Answer | undefined) | null;
}

function githubFake(repos: Record<string, RepoFixture>): Fake {
    const log: Fake['log'] = [];
    const fake: Fake = {
        log,
        override: null,
        fetchImpl: async (url, init) => {
            const u = new URL(url);
            const method = (init.method ?? 'GET').toUpperCase();
            const headers = new Headers(init.headers);
            log.push({ method, url, authorization: headers.get('authorization') });
            const answer = fake.override?.(u) ?? route(u, method, headers);
            if (answer === 'throw') throw new TypeError('fetch failed');
            return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
                status: answer.status,
                headers: { 'content-type': 'application/json', ...answer.headers },
            });
        },
    };

    function route(u: URL, method: string, headers: Headers): Exclude<Answer, 'throw'> {
        if (u.origin !== GH) return { status: 404, body: { message: 'Not Found' } };
        if (headers.get('authorization') !== `Bearer ${GITHUB_READ_TOKEN_VALUE}`) return { status: 401, body: { message: 'Bad credentials' } };
        if (method !== 'GET') return { status: 405, body: { message: 'Method Not Allowed' } };
        const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(u.pathname);
        const repo = m ? repos[`${m[1]}/${m[2]}`] : undefined;
        if (!m || !repo) return { status: 404, body: { message: 'Not Found' } };
        const rest = m[3] ?? '';
        if (rest === '') return { status: 200, body: { full_name: `${m[1]}/${m[2]}`, default_branch: 'main' } };
        if (rest === '/contents/.github/workflows') {
            if (repo.workflows === null) return { status: 404, body: { message: 'Not Found' } };
            const files = Object.keys(repo.workflows).map((name) => ({ type: 'file', name, path: `.github/workflows/${name}` }));
            return { status: 200, body: [...files, ...(repo.extraEntries ?? [])] };
        }
        const file = /^\/contents\/\.github\/workflows\/([^/]+)$/.exec(rest);
        if (file) {
            const text = repo.workflows?.[decodeURIComponent(file[1])];
            if (text === undefined) return { status: 404, body: { message: 'Not Found' } };
            return { status: 200, body: { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') } };
        }
        if (rest === '/actions/secrets') {
            const size = repo.secretPageSize ?? 100;
            const pageNo = Number(u.searchParams.get('page') ?? '1');
            const items = repo.secrets.slice((pageNo - 1) * size, pageNo * size);
            const more = pageNo * size < repo.secrets.length;
            return {
                status: 200,
                body: { total_count: repo.totalCount ?? repo.secrets.length, secrets: items },
                headers: more ? { link: `<${GH}${u.pathname}?per_page=100&page=${pageNo + 1}>; rel="next", <${GH}${u.pathname}?page=9>; rel="last"` } : {},
            };
        }
        // GitHub answers this with a secret's metadata; the fake answers with a
        // marker, so a reader that asked would visibly hold something it should not.
        if (/^\/actions\/secrets\/[^/]+$/.test(rest)) return { status: 200, body: { name: 'X', marker: SECRET_ENDPOINT_MARKER } };
        return { status: 404, body: { message: 'Not Found' } };
    }
    return fake;
}

async function read(
    fake: Fake,
    repositories: readonly string[] = ['acme/payments-api', 'acme/infra'],
    caps?: { response?: number; source?: number },
): Promise<SourceRead> {
    const wire = createSourceWire({ fetchImpl: fake.fetchImpl, deadline: ASOF.getTime() + 60_000, now: () => ASOF.getTime() }, caps);
    return githubActionsSource({ repositories, token: GITHUB_READ_TOKEN_VALUE }).read({ asOf: ASOF, deadline: Number.MAX_SAFE_INTEGER, now: Date.now, ...wire });
}

const twoRepos = () => ({ 'acme/payments-api': paymentsApi(), 'acme/infra': { workflows: null, secrets: [] } as RepoFixture });
const at = (file: string) => `github-actions:acme/payments-api/.github/workflows/${file}`;
const tokenRef = (file: string) => `github-token://github.com/acme/payments-api/.github/workflows/${file}`;
const secretRef = (name: string) => `github-secret://github.com/acme/payments-api/${name}`;

describe('1. what the GitHub Actions source finds', () => {
    it('reports each workflow that holds a credential or may write, and none that only reads', async () => {
        const result = await read(githubFake(twoRepos()));

        // Five workflow files and three secrets; the README and the directory are not rows.
        expect(result).toMatchObject({ kind: 'cicd', status: 'COMPLETE', rows: 8 });
        const byId = new Map(result.observations.map((o) => [o.discoveredId, o]));
        expect([...byId.keys()]).toEqual([
            'github:workflow:acme/payments-api/deploy.yaml',
            'github:workflow:acme/payments-api/evaluate.yml',
            'github:workflow:acme/payments-api/legacy.yml',
            'github:workflow:acme/payments-api/release.yml',
        ]);

        // A static secret, aged from its last update: not bound to the workflow.
        expect(byId.get('github:workflow:acme/payments-api/release.yml')).toEqual({
            discoveredId: 'github:workflow:acme/payments-api/release.yml',
            owner: null,
            credentials: [
                { ref: tokenRef('release.yml'), ageDays: 0, expires: true, boundToAgent: true, grant: 'app-only' },
                { ref: secretRef('RELEASE_APP_PRIVATE_KEY'), ageDays: 30, expires: null, boundToAgent: false, grant: 'unknown' },
            ],
            verdicts: [
                { criterion: 'H2.credential_bound', met: false, evidence: `${at('release.yml')}#secrets.RELEASE_APP_PRIVATE_KEY` },
                { criterion: 'H2.tools_allowlisted', met: true, evidence: `${at('release.yml')}#permissions` },
            ],
        });
        // A lower-case reference is the upper-case secret: GitHub's names are case-insensitive.
        expect(byId.get('github:workflow:acme/payments-api/evaluate.yml')?.credentials).toEqual([
            expect.objectContaining({ ref: tokenRef('evaluate.yml') }),
            expect.objectContaining({ ref: secretRef('ANTHROPIC_API_KEY'), ageDays: 10 }),
        ]);
        // A job that may mint an OIDC token holds that identity too, and only the run's own credentials.
        expect(byId.get('github:workflow:acme/payments-api/deploy.yaml')).toMatchObject({
            credentials: [
                { ref: tokenRef('deploy.yaml'), grant: 'app-only' },
                { ref: 'github-oidc://github.com/acme/payments-api/.github/workflows/deploy.yaml', boundToAgent: true, grant: 'app-only' },
            ],
            verdicts: [
                { criterion: 'H2.credential_bound', met: true, evidence: `${at('deploy.yaml')}#GITHUB_TOKEN` },
                { criterion: 'H2.grant_kind_declared', met: true },
                { criterion: 'H2.tools_allowlisted', met: true },
            ],
        });
        // No permissions at all: the repository default, which the source never assumes is read-only.
        expect(byId.get('github:workflow:acme/payments-api/legacy.yml')).toMatchObject({
            credentials: [{ ref: tokenRef('legacy.yml') }],
            verdicts: [
                { criterion: 'H2.credential_bound', met: true },
                { criterion: 'H2.grant_kind_declared', met: true },
                { criterion: 'H2.tools_allowlisted', met: false, evidence: `${at('legacy.yml')}#jobs.nightly.permissions` },
            ],
        });
    });

    it('reports the one repository secret no workflow references as unbound, and only that one', async () => {
        const result = await read(githubFake(twoRepos()));
        expect(result.unboundCredentials).toEqual([secretRef('STALE_DEPLOY_KEY')]);
    });

    it('reads a repository with no workflow directory as zero workflows, because the repository itself answered', async () => {
        const result = await read(githubFake(twoRepos()), ['acme/infra']);
        expect(result).toMatchObject({ status: 'COMPLETE', rows: 0, observations: [], unboundCredentials: [] });
    });

    it('names no owner: a workflow carries none, and the ingest reads that as unowned', async () => {
        const result = await read(githubFake(twoRepos()));
        expect(result.observations.every((o) => o.owner === null && !('registeredAgentId' in o))).toBe(true);
    });
});

describe('2. what counts as a reference', () => {
    it('reads expressions only: a property access, a literal index, and a whole if: value', () => {
        expect(secretsInExpression(" secrets.A && secrets['b_key'] || format('{0}', secrets.c) ")).toEqual({ names: ['B_KEY', 'A', 'C'], dynamic: false });
        const analysis = analyseWorkflow(`on: push
jobs:
  a:
    if: secrets.FROM_CONDITION != ''
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - run: echo secrets.IN_PROSE_ONLY
`);
        expect(analysis.secrets).toEqual(['FROM_CONDITION']);
    });

    it('does not read a string literal, another object\'s property named secrets, or a variable that only contains the word', () => {
        expect(secretsInExpression("contains(github.event.head_commit.message, 'secrets.X')")).toEqual({ names: [], dynamic: false });
        expect(secretsInExpression("inputs.secrets == 'all' && vars.SECRETS_PATH != ''")).toEqual({ names: [], dynamic: false });
    });

    it('never mistakes dynamic access for none', () => {
        expect(secretsInExpression('secrets[matrix.key]').dynamic).toBe(true);
        expect(secretsInExpression("secrets[format('{0}_KEY', matrix.env)]").dynamic).toBe(true);
        expect(secretsInExpression('toJSON(secrets)').dynamic).toBe(true);
    });

    it('a workflow that reaches secrets dynamically is a principal, evidenced unbound, and the repository reports no unbound secret', async () => {
        const repo = paymentsApi();
        repo.workflows!['matrix.yml'] = `on: push
permissions:
  contents: read
jobs:
  fanout:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ toJSON(secrets) }}" > /dev/null
`;
        const result = await read(githubFake({ 'acme/payments-api': repo }), ['acme/payments-api']);
        expect(result.status).toBe('COMPLETE');
        expect(result.observations.find((o) => o.discoveredId.endsWith('/matrix.yml'))).toMatchObject({
            credentials: [{ ref: tokenRef('matrix.yml') }],
            verdicts: [{ criterion: 'H2.credential_bound', met: false, evidence: `${at('matrix.yml')}#secrets` }, { criterion: 'H2.tools_allowlisted', met: true }],
        });
        // STALE_DEPLOY_KEY may be what `toJSON(secrets)` hands on: nothing is claimed unbound.
        expect(result.unboundCredentials).toEqual([]);
    });

    it('secrets: inherit to another repository is dynamic; to a workflow in this one, whose file is read, it is not', () => {
        const caller = (uses: string) => `on: push
jobs:
  call:
    uses: ${uses}
    secrets: inherit
`;
        expect(analyseWorkflow(caller('other-org/shared/.github/workflows/deploy.yml@v1')).dynamicSecrets).toBe(true);
        expect(analyseWorkflow(caller('./.github/workflows/release.yml')).dynamicSecrets).toBe(false);
    });

    it('reads a node an alias reaches twice once, and a job scope from the workflow when the job declares none', () => {
        const analysis = analyseWorkflow(`on: push
permissions:
  contents: write
x-env: &env
  KEY: \${{ secrets.SHARED }}
jobs:
  a: { runs-on: ubuntu-latest, env: *env, steps: [{ run: echo }] }
  b: { runs-on: ubuntu-latest, env: *env, permissions: read-all, steps: [{ run: echo }] }
`);
        expect(analysis).toEqual({
            secrets: ['SHARED'],
            dynamicSecrets: false,
            jobs: [
                { id: 'a', scope: { kind: 'map', scopes: { contents: 'write' } } },
                { id: 'b', scope: { kind: 'read-all' } },
            ],
        });
    });

    it.each([
        ['not YAML', 'jobs: [unclosed'],
        ['no jobs', 'on: push\n'],
        ['a permission it does not know', 'on: push\npermissions:\n  contents: admin\njobs:\n  a: { runs-on: x }\n'],
        ['a permissions value that is not a scope', 'on: push\npermissions: everything\njobs:\n  a: { runs-on: x }\n'],
        ['a duplicated key', 'on: push\njobs:\n  a: { runs-on: x }\n  a: { runs-on: y }\n'],
        ['a job that is not a mapping', 'on: push\njobs:\n  a: just-a-string\n'],
        ['an empty file', ''],
    ])('refuses %s as unparseable rather than reading part of it', (_label, text) => {
        expect(() => analyseWorkflow(text)).toThrow(UnparseableWorkflow);
    });
});

describe('3. read-only, by the request log', () => {
    it('every request is a GET to a declared path on api.github.com, with the token, and never the per-secret endpoint', async () => {
        const fake = githubFake(twoRepos());
        const result = await read(fake);
        expect(result.status).toBe('COMPLETE');
        expect(fake.log.length).toBeGreaterThan(0);
        for (const entry of fake.log) {
            expect(entry.method).toBe('GET');
            expect(new URL(entry.url).origin).toBe(GH);
            expect(isDeclaredRequest(entry.method, entry.url)).toBe(true);
            expect(entry.authorization).toBe(`Bearer ${GITHUB_READ_TOKEN_VALUE}`);
        }
        expect(fake.log.some((e) => /\/actions\/secrets\/[^/?]+$/.test(new URL(e.url).pathname))).toBe(false);
        expect(JSON.stringify(result)).not.toContain(SECRET_ENDPOINT_MARKER);
        expect(JSON.stringify(result)).not.toContain(GITHUB_READ_TOKEN_VALUE);
    });

    it('the declared surface does not stretch: a deeper path, another host or a write is not on it', () => {
        expect(isDeclaredRequest('GET', `${GH}/repos/acme/payments-api/actions/secrets`)).toBe(true);
        expect(isDeclaredRequest('GET', `${GH}/repos/acme/payments-api/actions/secrets/RELEASE_APP_PRIVATE_KEY`)).toBe(false);
        expect(isDeclaredRequest('GET', `${GH}/repos/acme/payments-api/contents/.github/workflows/sub/x.yml`)).toBe(false);
        expect(isDeclaredRequest('GET', 'https://api.github.example/repos/acme/payments-api')).toBe(false);
        expect(isDeclaredRequest('PUT', `${GH}/repos/acme/payments-api/actions/secrets/X`)).toBe(false);
    });
});

describe('4. fail closed, never silently', () => {
    it.each([
        ['a repository the token cannot see', (u: URL) => (u.pathname === '/repos/acme/infra' ? { status: 404, body: {} } : undefined), 'UNREACHABLE'],
        ['a token GitHub refuses', () => ({ status: 401, body: { message: 'Bad credentials' } }), 'AUTH_FAILED'],
        ['a token without Secrets: read', (u: URL) => (u.pathname.endsWith('/actions/secrets') ? { status: 403, body: {} } : undefined), 'AUTH_FAILED'],
        ['the rate limiter', (u: URL) => (u.pathname.endsWith('/actions/secrets') ? { status: 429, body: {} } : undefined), 'RATE_LIMITED'],
        ['the network', (u: URL) => (u.pathname.endsWith('/release.yml') ? ('throw' as const) : undefined), 'UNREACHABLE'],
        [
            'a next link off api.github.com',
            (u: URL) =>
                u.pathname.endsWith('/actions/secrets') && !u.searchParams.has('page')
                    ? { status: 200, body: { total_count: 3, secrets: [] }, headers: { link: '<https://evil.example/next>; rel="next"' } }
                    : undefined,
            'PAGINATION_TORN',
        ],
        [
            'a file GitHub serves without its content',
            (u: URL) => (u.pathname.endsWith('/release.yml') ? { status: 200, body: { type: 'file', encoding: 'none', content: '' } } : undefined),
            'BYTE_CAP',
        ],
    ] as const)('%s stops the read with its reason', async (_label, override, reason) => {
        const fake = githubFake(twoRepos());
        fake.override = override as Fake['override'];
        const result = await read(fake);
        expect(result).toMatchObject({ kind: 'cicd', status: 'INCOMPLETE', reason });
    });

    it('keeps what it read before the read stopped, and claims no unbound secret for the repository it did not finish', async () => {
        const fake = githubFake(twoRepos());
        fake.override = (u) => (u.pathname === '/repos/acme/infra' ? { status: 404, body: {} } : undefined);
        const result = await read(fake);
        expect(result.status).toBe('INCOMPLETE');
        // payments-api was read whole before infra failed: its principals are real.
        expect(result.observations).toHaveLength(4);

        const halfRead = githubFake(twoRepos());
        halfRead.override = (u) => (u.pathname.endsWith('/actions/secrets') ? { status: 429, body: {} } : undefined);
        expect((await read(halfRead)).unboundCredentials).toEqual([]);
    });

    it('a secret count that does not match the secrets read is a torn listing, never a shorter one', async () => {
        const repos = twoRepos();
        repos['acme/payments-api'].totalCount = 4;
        expect(await read(githubFake(repos))).toMatchObject({ status: 'INCOMPLETE', reason: 'PAGINATION_TORN' });
    });

    it('a workflow directory at GitHub\'s listing cap may be truncated, so it is a cap and not a population', async () => {
        const repos = twoRepos();
        repos['acme/payments-api'].extraEntries = Array.from({ length: GITHUB_DIRECTORY_LISTING_CAP }, (_, i) => ({ type: 'file', name: `n${i}.txt` }));
        expect(await read(githubFake(repos))).toMatchObject({ status: 'INCOMPLETE', reason: 'BYTE_CAP' });
    });

    it('a workflow file over the cap is not read whole', async () => {
        const repos = twoRepos();
        repos['acme/payments-api'].workflows!['huge.yml'] = `on: push\njobs:\n  a: { runs-on: x }\n# ${'x'.repeat(MAX_WORKFLOW_BYTES)}\n`;
        expect(await read(githubFake(repos), ['acme/payments-api'])).toMatchObject({ status: 'INCOMPLETE', reason: 'BYTE_CAP' });
    });

    it('an unparseable file makes the source UNPARSEABLE, keeps every other workflow, and claims no unbound secret', async () => {
        const repos = twoRepos();
        repos['acme/payments-api'].workflows!['broken.yml'] = 'on: push\npermissions:\n  contents: admin\njobs:\n  a: { runs-on: x }\n';
        const result = await read(githubFake(repos));
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'UNPARSEABLE', rows: 9 });
        expect(result.observations).toHaveLength(4);
        expect(result.unboundCredentials).toEqual([]);
    });
});

describe('5. end to end: configuration, a signed report the ingest verifies', () => {
    const config = (overrides: Record<string, unknown> = {}) =>
        parseScannerConfig({
            estate: 'acme-ci',
            scanner: { agentId: 'agt_scanner_acme', signingKeyEnv: 'SCANNER_SIGNING_KEY' },
            inflect: { baseUrl: 'https://inflect.example.com', tenantSlug: 'acme', apiKeyEnv: 'INFLECT_INGEST_KEY' },
            schedule: { everyHours: 24 },
            sources: [{ kind: 'cicd', product: 'github-actions', repositories: ['acme/payments-api', 'acme/infra'], tokenEnv: 'GITHUB_READ_TOKEN', ...overrides }],
        });

    it('parses a cicd source, names its token variable, and refuses a malformed or repeated repository', () => {
        expect(credentialEnvNames(config())).toEqual(['SCANNER_SIGNING_KEY', 'INFLECT_INGEST_KEY', 'GITHUB_READ_TOKEN']);
        expect(() => config({ repositories: ['acme'] })).toThrow(/repositories/);
        expect(() => config({ repositories: ['acme/a', 'ACME/a'] })).toThrow(/repositories/);
        expect(() => config({ repositories: ['acme/..'] })).toThrow(/repositories/);
        expect(() => config({ host: 'https://github.acme.example' })).toThrow(/unrecognized_keys/);
    });

    it('signs a report the ingest verifies, with the unbound secret for ORPHAN_CREDENTIAL, and the token nowhere', async () => {
        const { privateKey, publicKey } = generateKeyPairSync('ed25519');
        const fake = githubFake(twoRepos());
        const lines: string[] = [];
        const { raw, body } = await runScan({
            config: config(),
            env: {
                SCANNER_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
                INFLECT_INGEST_KEY: 'iflk_fake-ingest-key-3784',
                GITHUB_READ_TOKEN: GITHUB_READ_TOKEN_VALUE,
            },
            log: jsonLineLog((l) => lines.push(l)),
            fetchImpl: fake.fetchImpl,
            now: () => ASOF.getTime(),
        });

        expect(verifyAndParseHarnessReport(raw, [rawPublicKeyHex(publicKey)])).toMatchObject({ ok: true, complete: true });
        expect(body.population.sources).toEqual([{ kind: 'cicd', status: 'COMPLETE', rows: 8 }]);
        expect(body.unboundCredentials).toEqual([{ ref: secretRef('STALE_DEPLOY_KEY'), sourceKind: 'cicd' }]);
        expect(body.agents.map((a) => a.discoveredVia)).toEqual([['cicd'], ['cicd'], ['cicd'], ['cicd']]);
        expect([raw, ...lines].some((text) => text.includes(GITHUB_READ_TOKEN_VALUE))).toBe(false);
    });
});
