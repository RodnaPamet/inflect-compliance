/**
 * HTTP fakes for the scanner's sources (#3678, #3738): an Okta org, the
 * Microsoft identity platform, Azure Key Vault, LangSmith, and the Inflect
 * ingest — no network.
 *
 * Each fake answers the way the real API does for the requests the scanner is
 * meant to make, and ALSO answers the requests it must never make (an Okta
 * app's client secrets, a Key Vault secret's value, a LangSmith run's inputs
 * and outputs) with the dangerous thing, so a scanner that strayed would
 * visibly receive it. Every request is recorded — method, host, path, query —
 * in `log`, which is what the read-only assertions read.
 *
 * Credential-shaped values here are deliberately NOT secret-shaped (no `ghp_`,
 * no JWT): they are distinctive strings the tests search the report and the
 * log lines for, and the repository's secret scanners must not flag them.
 */
import type { FetchLike } from '../../packages/agent-harness-scanner/src/http';

export interface RequestLogEntry {
    readonly method: string;
    readonly host: string;
    readonly path: string;
    readonly query: string;
}

export const OKTA_ORG = 'https://acme.okta.com';
export const OKTA_TOKEN_VALUE = 'fake-okta-ssws-token-value-4a';
export const AZURE_TENANT = 'contoso.onmicrosoft.com';
export const AZURE_CLIENT_ID = '11111111-2222-3333-4444-555555555555';
export const AZURE_CLIENT_SECRET_VALUE = 'fake-azure-client-secret-value-4a';
export const AZURE_ACCESS_TOKEN_VALUE = 'fake-azure-access-token-value-4a';
export const VAULT = 'https://acme-agents.vault.azure.net';
/** What `GET {vault}/secrets/{name}` would return — the value the scanner must never read. */
export const VAULT_SECRET_VALUE = 'fake-vault-secret-value-never-read-4a';
export const OKTA_CLIENT_SECRET_VALUE = 'fake-okta-client-secret-never-read-4a';
export const INGEST = 'https://inflect.example.com';

type Answer = { status: number; body?: unknown; headers?: Record<string, string>; raw?: string };
/** Override one request's answer: return an Answer, `'throw'` for a network failure, or undefined to fall through. */
export type Override = (req: RequestLogEntry) => Answer | 'throw' | undefined;

export interface OktaFixture {
    /** Pages of the apps listing (already filtered to OIDC by the fake, as Okta's filter would). */
    apps: unknown[][];
    tokens: unknown[][];
    /** The id `GET /api/v1/api-tokens/current` answers: the token the scanner reads with. */
    currentTokenId: string;
}

/** The scanner's own SSWS token in the fixture org: listed, and answered by `/current`. */
export const SCANNER_OKTA_TOKEN_ID = '00TScannerOwn';

export function oktaFixture(): OktaFixture {
    return {
        apps: [
            [
                {
                    id: '0oaService1',
                    signOnMode: 'OPENID_CONNECT',
                    settings: { oauthClient: { application_type: 'service' } },
                    profile: { owner: 'jane.doe@acme.example' },
                },
                {
                    id: '0oaWeb1',
                    signOnMode: 'OPENID_CONNECT',
                    settings: { oauthClient: { application_type: 'web' } },
                    profile: null,
                },
            ],
            [
                {
                    id: '0oaService2',
                    signOnMode: 'OPENID_CONNECT',
                    settings: { oauthClient: { application_type: 'service' } },
                },
            ],
        ],
        tokens: [
            [
                { id: '00TToken1', userId: '00uAdmin1', created: '2026-07-01T00:00:00.000Z', expiresAt: '2026-11-01T00:00:00.000Z' },
                // The scanner's own token. Named like any other on purpose: it is
                // told apart by its id from `/current`, never by its name.
                { id: SCANNER_OKTA_TOKEN_ID, name: 'Automation token', userId: '00uScannerOwner', created: '2026-09-01T00:00:00.000Z' },
            ],
            [{ id: '00TToken2', name: 'Automation token', userId: '00uAdmin2', created: '2026-10-01T00:00:00.000Z' }],
        ],
        currentTokenId: SCANNER_OKTA_TOKEN_ID,
    };
}

export interface VaultFixture {
    secrets: unknown[][];
    certificates: unknown[][];
}

const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

export function vaultFixture(origin = VAULT): VaultFixture {
    return {
        secrets: [
            [
                {
                    id: `${origin}/secrets/sales-bot-client`,
                    attributes: { enabled: true, created: unix('2026-04-01T00:00:00Z') },
                    tags: { 'inflect-principal': 'entra:sp:sales-bot', owner: 'bob@acme.example' },
                },
                {
                    // An Okta service app's client secret, kept in the vault: the
                    // tag names the app the Okta source finds.
                    id: `${origin}/secrets/okta-service1`,
                    attributes: { enabled: true, created: unix('2026-10-10T00:00:00Z'), exp: unix('2027-01-01T00:00:00Z') },
                    tags: { 'inflect-principal': 'okta:app:0oaService1' },
                },
            ],
            [
                { id: `${origin}/secrets/db-password`, attributes: { enabled: true, created: unix('2026-01-01T00:00:00Z') } },
                {
                    id: `${origin}/secrets/disabled-one`,
                    attributes: { enabled: false, created: unix('2026-01-01T00:00:00Z') },
                    tags: { 'inflect-principal': 'entra:sp:retired-bot' },
                },
                {
                    id: `${origin}/secrets/cert-backing`,
                    managed: true,
                    attributes: { enabled: true, created: unix('2026-01-01T00:00:00Z') },
                    tags: { 'inflect-principal': 'entra:sp:cert-bot' },
                },
            ],
        ],
        certificates: [
            [
                {
                    id: `${origin}/certificates/cert-bot`,
                    attributes: { enabled: true, created: unix('2026-09-01T00:00:00Z'), exp: unix('2027-09-01T00:00:00Z') },
                    tags: { 'inflect-principal': 'entra:sp:cert-bot' },
                },
            ],
        ],
    };
}

// ─── LangSmith (#3738) ───

export const LANGSMITH_US = 'https://api.smith.langchain.com';
export const LANGSMITH_EU = 'https://eu.api.smith.langchain.com';
export const LANGSMITH_SELF_HOSTED = 'https://langsmith.acme.example';
export const LANGSMITH_API_KEY_VALUE = 'fake-langsmith-api-key-value-3738';
export const LANGSMITH_WORKSPACE_ID = '7a1b0000-0000-4000-8000-000000003738';

/**
 * Strings that live only where the LangSmith source must never look, or in
 * members it receives and must never keep. Each is searched for in the whole
 * signed report and in every log line.
 */
export const LANGSMITH_MARKERS = {
    runInput: 'marker-run-input-3738-customer-question',
    runOutput: 'marker-run-output-3738-model-answer',
    traceEvent: 'marker-trace-event-3738-token-stream',
    projectName: 'marker-project-name-3738',
    projectDescription: 'marker-project-description-3738',
    projectExtra: 'marker-project-extra-metadata-3738',
    facetMetadata: 'marker-facet-metadata-value-3738',
    facetTag: 'marker-facet-tag-3738',
    deploymentName: 'marker-deployment-name-3738',
    deploymentSecretValue: 'marker-deployment-secret-value-3738',
    deploymentSource: 'marker-deployment-source-repo-3738',
    /** A run name set at call time, carrying content: reported by digest, never verbatim. */
    dynamicRunName: 'look up order for marker-run-name-3738',
} as const;

export interface LangSmithRun {
    readonly id: string;
    readonly runType: 'tool' | 'llm' | 'chain';
    readonly name: string;
    readonly startTime: string;
}

export interface LangSmithProjectFixture {
    readonly id: string;
    readonly startTime: string;
    /** Set for an experiment: `reference_free=true` leaves it out. */
    readonly referenceDatasetId?: string;
    readonly runs: LangSmithRun[];
}

export interface LangSmithDeploymentFixture {
    readonly id: string;
    readonly tracerSessionId: string | null;
}

export interface LangSmithFixture {
    projects: LangSmithProjectFixture[];
    deployments: LangSmithDeploymentFixture[];
    /** Serves the control plane under `/api-host`, as a self-hosted LangSmith does. */
    selfHosted?: boolean;
    /** The key the workspace accepts; any other is answered 401, as an expired key is. */
    acceptedKey?: string;
}

export const LS = {
    /** Deployed support agent; its tracing project is `projectSupport`. */
    deploymentSupport: 'd0000001-0000-4000-8000-000000000001',
    /** Deployed, and idle over the window. */
    deploymentIdle: 'd0000002-0000-4000-8000-000000000002',
    projectSupport: 'p0000001-0000-4000-8000-000000000001',
    projectIdle: 'p0000004-0000-4000-8000-000000000004',
    /** Traced from outside LangSmith Deployment, and calls tools: a project agent. */
    projectResearch: 'p0000002-0000-4000-8000-000000000002',
    /** Calls a model and no tool: counted, reported as nothing. */
    projectChat: 'p0000003-0000-4000-8000-000000000003',
    /** An evaluation experiment. */
    projectExperiment: 'p0000005-0000-4000-8000-000000000005',
} as const;

const daysBefore = (iso: string, days: number) => new Date(Date.parse(iso) - days * 86_400_000).toISOString();

/** The fixture workspace as of `asOf`. Runs older than the seven-day window must not count. */
export function langSmithFixture(asOf = '2026-10-19T03:00:00.000Z'): LangSmithFixture {
    const run = (id: string, runType: LangSmithRun['runType'], name: string, daysAgo: number): LangSmithRun => ({
        id,
        runType,
        name,
        startTime: daysBefore(asOf, daysAgo),
    });
    return {
        deployments: [
            { id: LS.deploymentSupport, tracerSessionId: LS.projectSupport },
            { id: LS.deploymentIdle, tracerSessionId: LS.projectIdle },
        ],
        projects: [
            {
                id: LS.projectSupport,
                startTime: daysBefore(asOf, 90),
                runs: [
                    run('r-1', 'chain', 'support_agent', 1),
                    run('r-2', 'llm', 'ChatAnthropic', 1),
                    run('r-3', 'tool', 'search_orders', 1),
                    run('r-4', 'tool', 'search_orders', 2),
                    run('r-5', 'tool', 'search_orders', 3),
                    run('r-6', 'tool', 'refund_order', 2),
                    // Outside the window: never counted, never named.
                    run('r-7', 'tool', 'legacy_lookup', 12),
                ],
            },
            { id: LS.projectIdle, startTime: daysBefore(asOf, 60), runs: [run('r-8', 'tool', 'idle_tool', 20)] },
            {
                id: LS.projectResearch,
                startTime: daysBefore(asOf, 30),
                runs: [
                    run('r-9', 'tool', 'web_search', 1),
                    run('r-10', 'tool', 'web_search', 4),
                    run('r-11', 'tool', LANGSMITH_MARKERS.dynamicRunName, 2),
                ],
            },
            { id: LS.projectChat, startTime: daysBefore(asOf, 20), runs: [run('r-12', 'llm', 'ChatOpenAI', 1)] },
            {
                id: LS.projectExperiment,
                startTime: daysBefore(asOf, 5),
                referenceDatasetId: 'ds000001-0000-4000-8000-000000000001',
                runs: [run('r-13', 'tool', 'eval_tool', 1)],
            },
        ],
    };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Answer {
    return { status, body, headers: { 'content-type': 'application/json', ...headers } };
}

export interface Fakes {
    readonly fetchImpl: FetchLike;
    readonly log: RequestLogEntry[];
    /** Raw bodies the ingest fake received, in order. */
    readonly posted: string[];
    /** Authorization headers the ingest fake received. */
    readonly ingestAuth: string[];
    override: Override | null;
    /** The ingest's answer; defaults to a 201. */
    ingest: (raw: string) => Answer;
}

/**
 * The fake world. `okta` and `vaults` are mutable — a test edits a fixture
 * before scanning. Paging follows each API's own convention: Okta by `Link`
 * header with an `after` cursor, Key Vault by `nextLink` in the body.
 */
export function createSourceFakes(opts: {
    okta?: OktaFixture;
    /** Further Okta orgs by origin, beside `OKTA_ORG`. */
    oktaOrgs?: Record<string, OktaFixture>;
    vaults?: Record<string, VaultFixture>;
    /** LangSmith workspaces by origin; `LANGSMITH_US` holds `langSmithFixture()` unless replaced. */
    langsmith?: Record<string, LangSmithFixture>;
} = {}): Fakes {
    const oktas: Record<string, OktaFixture> = { [OKTA_ORG]: opts.okta ?? oktaFixture(), ...opts.oktaOrgs };
    const vaults = opts.vaults ?? { [VAULT]: vaultFixture() };
    const langsmiths = opts.langsmith ?? { [LANGSMITH_US]: langSmithFixture() };
    const log: RequestLogEntry[] = [];
    const posted: string[] = [];
    const ingestAuth: string[] = [];

    const fakes: Fakes = {
        log,
        posted,
        ingestAuth,
        override: null,
        ingest: () => json({ scanId: 'scan_row', complete: true, agentCount: 1 }, 201),
        fetchImpl: async (url: string, init: RequestInit) => {
            const u = new URL(url);
            const method = (init.method ?? 'GET').toUpperCase();
            const entry: RequestLogEntry = { method, host: u.host, path: u.pathname, query: u.search };
            log.push(entry);
            const headers = new Headers(init.headers);
            const answer = fakes.override?.(entry) ?? route(u, method, headers, init.body);
            if (answer === 'throw') throw new TypeError('fetch failed');
            return new Response(answer.raw ?? (answer.body === undefined ? null : JSON.stringify(answer.body)), {
                status: answer.status,
                headers: answer.headers,
            });
        },
    };

    function page(pages: unknown[][], u: URL, base: string): Answer {
        const at = Number(u.searchParams.get('after') ?? '0');
        const items = pages[at] ?? [];
        const next = at + 1 < pages.length ? `<${base}${u.pathname}?limit=200&after=${at + 1}>; rel="next"` : null;
        return json(items, 200, next ? { link: next } : {});
    }

    function route(u: URL, method: string, headers: Headers, body: unknown): Answer {
        // ── Okta ──
        const okta = oktas[u.origin];
        if (okta) {
            if (headers.get('authorization') !== `SSWS ${OKTA_TOKEN_VALUE}`) return json({ errorCode: 'E0000011' }, 401);
            if (method !== 'GET') return json({ errorCode: 'E0000022' }, 405);
            if (u.pathname === '/api/v1/apps') return page(okta.apps, u, u.origin);
            if (u.pathname === '/api/v1/api-tokens') return page(okta.tokens, u, u.origin);
            if (u.pathname === '/api/v1/api-tokens/current') {
                const own = okta.tokens.flat().find((t) => (t as { id?: string }).id === okta.currentTokenId);
                return json(own ?? { id: okta.currentTokenId });
            }
            // The endpoint a reader must never call: Okta returns client secrets here.
            if (/^\/api\/v1\/apps\/[^/]+\/credentials\/secrets$/.test(u.pathname)) {
                return json([{ id: 'ocs1', client_secret: OKTA_CLIENT_SECRET_VALUE }]);
            }
            return json({ errorCode: 'E0000007' }, 404);
        }
        // ── Microsoft identity platform ──
        if (u.origin === 'https://login.microsoftonline.com') {
            if (method !== 'POST' || u.pathname !== `/${AZURE_TENANT}/oauth2/v2.0/token`) return json({ error: 'invalid_request' }, 400);
            const form = new URLSearchParams(String(body ?? ''));
            if (form.get('client_id') !== AZURE_CLIENT_ID || form.get('client_secret') !== AZURE_CLIENT_SECRET_VALUE) {
                return json({ error: 'invalid_client' }, 401);
            }
            return json({ token_type: 'Bearer', expires_in: 3599, access_token: AZURE_ACCESS_TOKEN_VALUE });
        }
        // ── Azure Key Vault ──
        const vault = vaults[u.origin];
        if (vault) {
            if (headers.get('authorization') !== `Bearer ${AZURE_ACCESS_TOKEN_VALUE}`) return json({ error: { code: 'Unauthorized' } }, 401);
            if (method !== 'GET') return json({ error: { code: 'BadParameter' } }, 405);
            const collection = u.pathname === '/secrets' ? vault.secrets : u.pathname === '/certificates' ? vault.certificates : null;
            if (collection) {
                const at = Number(u.searchParams.get('$skiptoken') ?? '0');
                const nextLink = at + 1 < collection.length
                    ? `${u.origin}:443${u.pathname}?api-version=7.4&$skiptoken=${at + 1}&maxresults=25`
                    : null;
                return json({ value: collection[at] ?? [], nextLink });
            }
            // The endpoint a metadata reader must never call: it returns the value.
            if (/^\/secrets\/[^/]+(\/[^/]+)?$/.test(u.pathname)) return json({ value: VAULT_SECRET_VALUE, id: `${u.origin}${u.pathname}` });
            return json({ error: { code: 'NotFound' } }, 404);
        }
        // ── LangSmith ──
        const ls = langsmiths[u.origin];
        if (ls) return langSmith(ls, u, method, headers);
        // ── The Inflect ingest ──
        if (u.origin === INGEST) {
            if (method === 'POST' && /^\/api\/t\/[^/]+\/admin\/agents\/harness-scans$/.test(u.pathname)) {
                posted.push(String(body));
                ingestAuth.push(headers.get('authorization') ?? '');
                return fakes.ingest(String(body));
            }
            return json({ error: 'not found' }, 404);
        }
        return json({ error: 'unknown host' }, 502);
    }

    /**
     * One LangSmith workspace. The projects listing computes its stats the way
     * the service does — tool runs in the window, by name — and carries every
     * member the source must not keep, each holding a marker. The run
     * endpoints answer with the runs' content: a source that called one would
     * hand the test its marker.
     */
    function langSmith(ls: LangSmithFixture, u: URL, method: string, headers: Headers): Answer {
        if (headers.get('x-api-key') !== (ls.acceptedKey ?? LANGSMITH_API_KEY_VALUE)) {
            return json({ detail: 'Invalid token' }, 401);
        }
        const runBody = (r: LangSmithRun) => ({
            id: r.id,
            name: r.name,
            run_type: r.runType,
            start_time: r.startTime,
            inputs: { question: LANGSMITH_MARKERS.runInput },
            outputs: { answer: LANGSMITH_MARKERS.runOutput },
            events: [{ name: 'new_token', kwargs: { token: LANGSMITH_MARKERS.traceEvent } }],
        });
        const allRuns = ls.projects.flatMap((p) => p.runs);
        if (u.pathname.startsWith('/api/v1/runs') || u.pathname.startsWith('/api/v2/runs')) {
            const one = allRuns.find((r) => u.pathname.endsWith(`/${r.id}`));
            return json(one ? runBody(one) : allRuns.map(runBody));
        }
        if (method !== 'GET') return json({ detail: 'Method Not Allowed' }, 405);
        const limit = Number(u.searchParams.get('limit') ?? '100');
        const offset = Number(u.searchParams.get('offset') ?? '0');

        const deploymentsPath = ls.selfHosted ? '/api-host/v2/deployments' : '/v2/deployments';
        if (u.pathname === deploymentsPath) {
            const page = ls.deployments.slice(offset, offset + limit).map((d) => ({
                id: d.id,
                name: LANGSMITH_MARKERS.deploymentName,
                tenant_id: LANGSMITH_WORKSPACE_ID,
                source: 'github',
                source_config: { integration_id: null, repo_url: `https://github.com/acme/${LANGSMITH_MARKERS.deploymentSource}` },
                source_revision_config: { repo_ref: 'main', langgraph_config_path: 'langgraph.json' },
                secrets: [{ name: 'OPENAI_API_KEY', value: LANGSMITH_MARKERS.deploymentSecretValue }],
                status: 'READY',
                tracer_session_id: d.tracerSessionId,
                created_at: '2026-06-01T00:00:00Z',
                updated_at: '2026-06-01T00:00:00Z',
                latest_revision_id: null,
                active_revision_id: null,
            }));
            return json({ resources: page, offset: offset + page.length });
        }

        if (u.pathname === '/api/v1/sessions') {
            const since = Date.parse(u.searchParams.get('stats_start_time') ?? '');
            const filter = u.searchParams.get('stats_filter');
            const listed = ls.projects
                .filter((p) => u.searchParams.get('reference_free') !== 'true' || !p.referenceDatasetId)
                .sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));
            const page = listed.slice(offset, offset + limit).map((p) => {
                const counted = p.runs.filter(
                    (r) => Date.parse(r.startTime) >= since && (filter !== 'eq(run_type, "tool")' || r.runType === 'tool'),
                );
                const byName = new Map<string, number>();
                for (const r of counted) byName.set(r.name, (byName.get(r.name) ?? 0) + 1);
                return {
                    id: p.id,
                    tenant_id: LANGSMITH_WORKSPACE_ID,
                    name: LANGSMITH_MARKERS.projectName,
                    description: LANGSMITH_MARKERS.projectDescription,
                    extra: { metadata: { note: LANGSMITH_MARKERS.projectExtra } },
                    start_time: p.startTime,
                    reference_dataset_id: p.referenceDatasetId ?? null,
                    run_count: counted.length,
                    run_facets: counted.length === 0
                        ? []
                        : [
                            { key: 'run_type', value: 'tool', query: 'eq(run_type, "tool")', n: counted.length },
                            ...[...byName].map(([value, n]) => ({ key: 'name', value, query: `eq(name, "${value}")`, n })),
                            { key: 'metadata_value', value: LANGSMITH_MARKERS.facetMetadata, n: 1 },
                            { key: 'tag', value: LANGSMITH_MARKERS.facetTag, n: 1 },
                        ],
                };
            });
            return json(page);
        }
        return json({ detail: 'Not Found' }, 404);
    }

    return fakes;
}

/** Every string a run must never let into a report or a log line. */
export const NEVER_REPORTED = [
    OKTA_TOKEN_VALUE,
    AZURE_CLIENT_SECRET_VALUE,
    AZURE_ACCESS_TOKEN_VALUE,
    VAULT_SECRET_VALUE,
    OKTA_CLIENT_SECRET_VALUE,
    LANGSMITH_API_KEY_VALUE,
    ...Object.values(LANGSMITH_MARKERS),
] as const;
