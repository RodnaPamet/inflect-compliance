/**
 * The scanner's LangSmith source over a fixture workspace (#3738).
 *
 *   1. A FIXTURE ESTATE produces the expected agents with their tools and call
 *      counts — deployments always, projects only when they called a tool in
 *      the window — and the report it signs verifies, with the tools in it.
 *   2. READ-ONLY, by the request log: every request is a GET to a declared
 *      path on the configured host, and no run is ever fetched — the fake
 *      would hand over its content if one were.
 *   3. NO CONTENT in the report: run inputs, outputs and trace events, and
 *      every member the listings carry that the source must not keep, hold
 *      marker strings that appear nowhere in the signed report or the log.
 *      The API key appears in neither, and is sent to LangSmith alone.
 *   4. INCOMPLETE WITH A NAMED REASON: an unreachable API, an expired key and a
 *      truncated page each stop the read with a reason of its own, and so do
 *      the ways an aggregate can fail to vouch for the calls it counts.
 *   5. AN EMPTY WINDOW IS EMPTY_SCAN, not a clean bill.
 *   6. A SELF-HOSTED HOST is a customer-named host: refused at configuration
 *      unless it is a public https origin, and re-resolved before every
 *      request, so a name that turns private stops the read before the key
 *      leaves. An estate may name private ranges its host resolves into;
 *      metadata, loopback and link-local stay refused inside them.
 *   8. DEPLOYMENTS ARE OPT-IN: the default configuration lists none, by
 *      request log, and an estate that opts in lists them.
 *   7. Tools merge into the report by (server, name), and a cap is reported.
 */
import { generateKeyPairSync } from 'crypto';

import {
    createSourceFakes,
    INGEST,
    LANGSMITH_API_KEY_VALUE,
    LANGSMITH_EU,
    LANGSMITH_MARKERS,
    LANGSMITH_SELF_HOSTED,
    LANGSMITH_US,
    LANGSMITH_WORKSPACE_ID,
    langSmithFixture,
    LS,
    NEVER_REPORTED,
    type Fakes,
    type LangSmithFixture,
} from '../../helpers/agent-harness-source-fakes';
import { MAX_TOOLS_PER_AGENT, verifyAndParseHarnessReport } from '@/lib/agentic/harness-contract';
import { planHarnessScan } from '@/lib/agentic/harness-findings';
import { isPrivateAddress as appIsPrivateAddress } from '@/app-layer/automation/webhook-safety';
import { isNeverAllowlistable as appIsNeverAllowlistable } from '@/lib/security/egress-allowlist';
import { ConfigError, credentialEnvNames, parseScannerConfig } from '../../../packages/agent-harness-scanner/src/config';
import {
    addressReachable,
    customerOriginProblem,
    isNeverAllowlistable,
    isPrivateAddress,
    parsePrivateCidrAllowlist,
    type ResolveHost,
} from '../../../packages/agent-harness-scanner/src/customer-host';
import { createSourceWire } from '../../../packages/agent-harness-scanner/src/http';
import { jsonLineLog } from '../../../packages/agent-harness-scanner/src/log';
import { buildReportBody, rawPublicKeyHex } from '../../../packages/agent-harness-scanner/src/report';
import { runScan, scanAndPost } from '../../../packages/agent-harness-scanner/src/scan';
import { isDeclaredRequest, SCANNER_SURFACE } from '../../../packages/agent-harness-scanner/src/scanner-surface';
import {
    langSmithSource,
    LANGSMITH_READ_PATHS,
    reportableToolName,
    type LangSmithEndpoint,
} from '../../../packages/agent-harness-scanner/src/sources/langsmith';
import { toolCallsOf, type SourceRead } from '../../../packages/agent-harness-scanner/src/source';

const ASOF = new Date('2026-10-19T03:00:00.000Z');
const SELF_HOST = new URL(LANGSMITH_SELF_HOSTED).hostname;
const publicDns: ResolveHost = async () => ['203.0.113.10'];

interface ReadOpts {
    endpoint?: LangSmithEndpoint;
    key?: string;
    windowDays?: number;
    readDeployments?: boolean;
    workspaceId?: string | null;
    resolveHost?: ResolveHost;
    now?: () => number;
    caps?: { response?: number; source?: number };
}

async function read(fakes: Fakes, o: ReadOpts = {}): Promise<SourceRead> {
    const now = o.now ?? (() => ASOF.getTime());
    const wire = createSourceWire({ fetchImpl: fakes.fetchImpl, deadline: ASOF.getTime() + 60_000, now }, o.caps);
    const source = langSmithSource({
        endpoint: o.endpoint ?? { cloud: 'us' },
        apiKey: o.key ?? LANGSMITH_API_KEY_VALUE,
        workspaceId: o.workspaceId === undefined ? null : o.workspaceId,
        windowDays: o.windowDays ?? 7,
        readDeployments: o.readDeployments ?? true,
        resolveHost: o.resolveHost ?? publicDns,
    });
    return source.read({ asOf: ASOF, ...wire });
}

const toolsOf = (r: SourceRead, id: string) =>
    r.observations.find((o) => o.discoveredId === id)?.tools?.map((t) => [t.tool.name, t.calls]);

const DIGEST = reportableToolName(LANGSMITH_MARKERS.dynamicRunName);

describe('1. a fixture estate: the expected agents, with tools and counts', () => {
    it('reports every deployment, and each project that called a tool in the window', async () => {
        const result = await read(createSourceFakes());

        // Two deployments and four non-experiment projects listed; the experiment is filtered by the service.
        expect(result).toMatchObject({ kind: 'runtime', status: 'COMPLETE', rows: 6 });
        expect(result.observations.map((o) => o.discoveredId).sort()).toEqual([
            `langsmith:deployment:${LS.deploymentSupport}`,
            `langsmith:deployment:${LS.deploymentIdle}`,
            `langsmith:project:${LS.projectResearch}`,
        ]);
        // The support deployment carries its tracing project's tool calls; the
        // call outside the window is neither counted nor named.
        expect(toolsOf(result, `langsmith:deployment:${LS.deploymentSupport}`)).toEqual([
            ['refund_order', 1],
            ['search_orders', 3],
        ]);
        // Idle over the window, and still a deployment: reported, with no tools.
        expect(toolsOf(result, `langsmith:deployment:${LS.deploymentIdle}`)).toEqual([]);
        // A run name set at call time is reported by digest.
        expect(toolsOf(result, `langsmith:project:${LS.projectResearch}`)).toEqual([
            [DIGEST, 1],
            ['web_search', 2],
        ]);
        expect(toolCallsOf(result)).toBe(7);

        const support = result.observations.find((o) => o.discoveredId === `langsmith:deployment:${LS.deploymentSupport}`);
        expect(support).toMatchObject({ owner: null, credentials: [], verdicts: [] });
        expect(support?.tools?.[0].tool).toEqual({
            server: `langsmith://api.smith.langchain.com/projects/${LS.projectSupport}`,
            name: 'refund_order',
            manifestHash: null,
            pinned: false,
            readOnlyHint: null,
        });
        // A deployment's own project is the deployment, not a second agent.
        expect(result.observations.some((o) => o.discoveredId === `langsmith:project:${LS.projectSupport}`)).toBe(false);
    });

    it('reads the EU host when the configuration names it', async () => {
        const fakes = createSourceFakes({ langsmith: { [LANGSMITH_EU]: langSmithFixture() } });
        const result = await read(fakes, { endpoint: { cloud: 'eu' } });
        expect(result.status).toBe('COMPLETE');
        expect(new Set(fakes.log.map((r) => r.host))).toEqual(new Set(['eu.api.smith.langchain.com']));
    });

    it('without the control plane, projects are still read and each tool-calling one is an agent', async () => {
        const fakes = createSourceFakes();
        const result = await read(fakes, { readDeployments: false });
        expect(result).toMatchObject({ status: 'COMPLETE', rows: 4 });
        expect(result.observations.map((o) => o.discoveredId).sort()).toEqual([
            `langsmith:project:${LS.projectSupport}`,
            `langsmith:project:${LS.projectResearch}`,
        ]);
        expect(fakes.log.some((r) => r.path.includes('deployments'))).toBe(false);
    });

    it('a tool name that is an identifier is kept; anything else is a digest', () => {
        expect(reportableToolName('search_orders')).toBe('search_orders');
        expect(reportableToolName('mcp.github:create-issue')).toBe('mcp.github:create-issue');
        expect(reportableToolName('look up order 4471')).toMatch(/^tool-sha256:[0-9a-f]{16}$/);
        expect(reportableToolName('x'.repeat(129))).toMatch(/^tool-sha256:/);
        // A secret's shape is never a name the report carries. Built from fragments.
        expect(reportableToolName(['sk', '-', 'A'.repeat(24)].join(''))).toMatch(/^tool-sha256:/);
    });
});

describe('2. read-only, by the request log', () => {
    it('every request is a GET to a declared path on the configured host; no run is ever fetched', async () => {
        const fakes = createSourceFakes();
        const result = await read(fakes);

        expect(fakes.log.map((r) => `${r.method} ${r.host}${r.path}`)).toEqual([
            'GET api.smith.langchain.com/v2/deployments',
            'GET api.smith.langchain.com/api/v1/sessions',
        ]);
        for (const r of fakes.log) {
            expect(r.method).toBe('GET');
            expect(isDeclaredRequest(r.method, `https://${r.host}${r.path}${r.query}`)).toBe(true);
            expect(r.path).not.toMatch(/\/runs/);
        }
        // The window and the aggregate are asked for in the query, nothing else.
        const sessions = new URL(`https://x${fakes.log[1].path}${fakes.log[1].query}`).searchParams;
        expect(sessions.get('stats_start_time')).toBe('2026-10-12T03:00:00.000Z');
        expect(sessions.get('stats_filter')).toBe('eq(run_type, "tool")');
        expect(sessions.getAll('stats_select')).toEqual(['run_count', 'run_facets']);
        expect(sessions.get('reference_free')).toBe('true');
        expect(fakes.log[1].query).toContain('stats_filter=eq(run_type%2C%20%22tool%22)');
        expect(JSON.stringify(result)).not.toContain(LANGSMITH_MARKERS.runInput);
    });

    it('declares exactly the three paths of the endpoint table on the surface', () => {
        const runtime = SCANNER_SURFACE.reads.find((r) => r.source === 'runtime');
        expect(runtime).toMatchObject({ product: 'langsmith', method: 'GET' });
        expect([...(runtime?.paths ?? [])].sort()).toEqual(['/api-host/v2/deployments', '/api/v1/sessions', '/v2/deployments']);
        expect(LANGSMITH_READ_PATHS.cloud.projects).toBe('/api/v1/sessions');
        expect(isDeclaredRequest('GET', `${LANGSMITH_US}/api/v1/runs/r-1`)).toBe(false);
        expect(isDeclaredRequest('POST', `${LANGSMITH_US}/api/v1/runs/query`)).toBe(false);
    });

    it('pages both listings by offset, and a full page is followed by the next', async () => {
        const fixture = langSmithFixture();
        for (let i = 0; i < 150; i++) {
            fixture.projects.push({ id: `bulk-${String(i).padStart(3, '0')}`, startTime: '2026-01-01T00:00:00.000Z', runs: [] });
        }
        for (let i = 0; i < 100; i++) fixture.deployments.push({ id: `dep-bulk-${i}`, tracerSessionId: null });
        const fakes = createSourceFakes({ langsmith: { [LANGSMITH_US]: fixture } });
        const result = await read(fakes);
        expect(result).toMatchObject({ status: 'COMPLETE', rows: 102 + 154 });
        expect(fakes.log.map((r) => `${r.path} ${new URLSearchParams(r.query).get('offset')}`)).toEqual([
            '/v2/deployments 0',
            '/v2/deployments 100',
            '/api/v1/sessions 0',
            '/api/v1/sessions 100',
        ]);
    });
});

describe('3. no content, and no key, in the report or the log', () => {
    function langSmithOnly(extra: Record<string, unknown> = {}) {
        const { privateKey, publicKey } = generateKeyPairSync('ed25519');
        const lines: string[] = [];
        const config = parseScannerConfig({
            estate: 'acme-agents',
            scanner: { agentId: 'agt_scanner_acme', signingKeyEnv: 'SCANNER_SIGNING_KEY' },
            inflect: { baseUrl: INGEST, tenantSlug: 'acme', apiKeyEnv: 'INFLECT_INGEST_KEY' },
            schedule: { everyHours: 24 },
            sources: [{ kind: 'runtime', product: 'langsmith', endpoint: { cloud: 'us' }, apiKeyEnv: 'LANGSMITH_API_KEY', ...extra }],
        });
        const fakes = createSourceFakes();
        const deps = {
            config,
            env: {
                SCANNER_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
                INFLECT_INGEST_KEY: 'iflk_fake-ingest-key-3738',
                LANGSMITH_API_KEY: LANGSMITH_API_KEY_VALUE,
            },
            log: jsonLineLog((l) => lines.push(l)),
            fetchImpl: fakes.fetchImpl,
            now: () => ASOF.getTime(),
        };
        return { deps, fakes, lines, publicKeyHex: rawPublicKeyHex(publicKey) };
    }

    it('the signed report carries the agents and tool names, and no marker of run content or of a member not kept', async () => {
        // Opted in to deployments, so the secrets-bearing listing is read and its markers are tested too.
        const { deps, lines, publicKeyHex } = langSmithOnly({ workspaceId: LANGSMITH_WORKSPACE_ID, readDeployments: true });
        const { raw, body } = await runScan(deps);

        expect(verifyAndParseHarnessReport(raw, [publicKeyHex])).toMatchObject({ ok: true, complete: true });
        expect(body.population.sources).toEqual([{ kind: 'runtime', status: 'COMPLETE', rows: 6 }]);
        expect(body.agents.map((a) => [a.discoveredId, a.discoveredVia, a.tools.map((t) => t.name)])).toEqual([
            [`langsmith:deployment:${LS.deploymentSupport}`, ['runtime'], ['refund_order', 'search_orders']],
            [`langsmith:deployment:${LS.deploymentIdle}`, ['runtime'], []],
            [`langsmith:project:${LS.projectResearch}`, ['runtime'], [DIGEST, 'web_search']],
        ]);
        expect(body.agents.every((a) => a.registeredAgentId === null && a.owner === null)).toBe(true);

        // The whole report, and every log line, against every marker and the key.
        const logs = lines.join('');
        for (const marker of [...Object.values(LANGSMITH_MARKERS), LANGSMITH_API_KEY_VALUE, LANGSMITH_WORKSPACE_ID]) {
            expect(raw).not.toContain(marker);
            expect(logs).not.toContain(marker);
        }
        // Counts reach the log as a total, which is the one place the contract leaves them.
        expect(lines.find((l) => l.includes('"source read"'))).toContain('"toolCalls":7');
    });

    it('the key is sent to LangSmith in X-Api-Key and nowhere else, and the run posts only the unchanged report', async () => {
        const { deps, fakes } = langSmithOnly();
        const seen: { host: string; apiKey: string | null; auth: string | null }[] = [];
        const inner = fakes.fetchImpl;
        const spy: typeof inner = async (url, init) => {
            const h = new Headers(init.headers);
            seen.push({ host: new URL(url).host, apiKey: h.get('x-api-key'), auth: h.get('authorization') });
            return inner(url, init);
        };
        expect(await scanAndPost({ ...deps, fetchImpl: spy })).toMatchObject({ ok: true });
        for (const s of seen) {
            if (s.host === 'api.smith.langchain.com') expect(s.apiKey).toBe(LANGSMITH_API_KEY_VALUE);
            else expect([s.apiKey, s.auth]).not.toContain(LANGSMITH_API_KEY_VALUE);
        }
        expect(fakes.posted).toHaveLength(1);
        expect(fakes.posted[0]).not.toContain(LANGSMITH_API_KEY_VALUE);
        expect(fakes.log.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.host}`)).toEqual(['POST inflect.example.com']);
    });

    it('a missing key is AUTH_FAILED with nothing sent, and the source is still listed', async () => {
        const { deps, fakes } = langSmithOnly();
        const { body } = await runScan({ ...deps, env: { ...deps.env, LANGSMITH_API_KEY: undefined } });
        expect(body.population.sources).toEqual([{ kind: 'runtime', status: 'INCOMPLETE', reason: 'AUTH_FAILED', rows: 0 }]);
        expect(fakes.log).toHaveLength(0);
    });

    it('nothing a stopped read collected carries a marker either', async () => {
        const fakes = createSourceFakes();
        fakes.override = (r) => (r.path === '/api/v1/sessions' ? { status: 503 } : undefined);
        const result = await read(fakes);
        for (const marker of NEVER_REPORTED) expect(JSON.stringify(result)).not.toContain(marker);
    });
});

describe('4. INCOMPLETE, each with a reason of its own', () => {
    it('an unreachable API, an expired key and a truncated page stop the read with three different reasons', async () => {
        const down = createSourceFakes();
        down.override = () => 'throw';
        const unreachable = await read(down);

        const expired = await read(createSourceFakes(), { key: 'fake-langsmith-api-key-expired-3738' });

        const cut = createSourceFakes();
        cut.override = (r) =>
            r.path === '/api/v1/sessions'
                ? { status: 200, raw: `[{"id":"${LS.projectSupport}","run_count":4,"run_fac`, headers: { 'content-type': 'application/json' } }
                : undefined;
        const truncated = await read(cut);

        expect(unreachable).toMatchObject({ status: 'INCOMPLETE', reason: 'UNREACHABLE', rows: 0 });
        expect(expired).toMatchObject({ status: 'INCOMPLETE', reason: 'AUTH_FAILED', rows: 0, observations: [] });
        expect(truncated).toMatchObject({ status: 'INCOMPLETE', reason: 'PAGINATION_TORN' });
        expect(new Set([unreachable.reason, expired.reason, truncated.reason]).size).toBe(3);
    });

    it('a truncated page keeps the deployments read before it — without tools it could not vouch for', async () => {
        const fakes = createSourceFakes();
        fakes.override = (r) => (r.path === '/api/v1/sessions' ? { status: 200, raw: '[{"id":', headers: {} } : undefined);
        const result = await read(fakes);
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'PAGINATION_TORN', rows: 2 });
        expect(result.observations.map((o) => [o.discoveredId, o.tools?.length])).toEqual([
            [`langsmith:deployment:${LS.deploymentSupport}`, 0],
            [`langsmith:deployment:${LS.deploymentIdle}`, 0],
        ]);
    });

    it.each([
        ['rate limiting', { status: 429 }, 'RATE_LIMITED'],
        ['a server error', { status: 502 }, 'UNREACHABLE'],
        ['a key without rights to the listing', { status: 403, body: { detail: 'Forbidden' } }, 'AUTH_FAILED'],
        ['a listing that is not an array', { status: 200, body: { items: [] } }, 'PAGINATION_TORN'],
    ] as const)('%s → %s', async (_label, answer, reason) => {
        const fakes = createSourceFakes();
        fakes.override = (r) => (r.path === '/api/v1/sessions' ? answer : undefined);
        expect(await read(fakes)).toMatchObject({ status: 'INCOMPLETE', reason });
    });

    it.each([
        ['facets that account for fewer calls than the count (a cut top-k)', (p: Record<string, unknown>) => {
            p.run_facets = (p.run_facets as { key: string }[]).filter((f) => !(f.key === 'name' && (f as { value?: string }).value === 'refund_order'));
        }],
        ['facets that account for more calls than the count', (p: Record<string, unknown>) => {
            p.run_count = 1;
        }],
        ['no count at all', (p: Record<string, unknown>) => {
            p.run_count = null;
        }],
        ['a name facet that is not a count', (p: Record<string, unknown>) => {
            p.run_facets = (p.run_facets as Record<string, unknown>[]).map((f) => (f.key === 'name' ? { ...f, n: '3' } : f));
        }],
        ['no facets for a project that counted calls', (p: Record<string, unknown>) => {
            p.run_facets = null;
        }],
    ])('stats that cannot vouch for the calls they count are PAGINATION_TORN: %s', async (_label, edit) => {
        const fakes = createSourceFakes();
        const inner = fakes.fetchImpl;
        const tamper: typeof inner = async (url, init) => {
            const res = await inner(url, init);
            if (!url.includes('/api/v1/sessions')) return res;
            const page = (await res.json()) as Record<string, unknown>[];
            for (const p of page) if (p.id === LS.projectSupport) edit(p);
            return new Response(JSON.stringify(page), { status: 200 });
        };
        const wire = createSourceWire({ fetchImpl: tamper, deadline: ASOF.getTime() + 60_000, now: () => ASOF.getTime() });
        const source = langSmithSource({
            endpoint: { cloud: 'us' },
            apiKey: LANGSMITH_API_KEY_VALUE,
            workspaceId: null,
            windowDays: 7,
            readDeployments: true,
        });
        expect(await source.read({ asOf: ASOF, ...wire })).toMatchObject({ status: 'INCOMPLETE', reason: 'PAGINATION_TORN' });
    });

    it('a project listed twice across offsets — the listing shifted under the reader — is PAGINATION_TORN', async () => {
        const fixture = langSmithFixture();
        for (let i = 0; i < 100; i++) fixture.projects.push({ id: `bulk-${i}`, startTime: '2026-01-01T00:00:00.000Z', runs: [] });
        const fakes = createSourceFakes({ langsmith: { [LANGSMITH_US]: fixture } });
        // A project created between the two pages pushes the first page's last item onto the second.
        let pages = 0;
        const inner = fakes.fetchImpl;
        const shifting: typeof inner = async (url, init) => {
            if (url.includes('/api/v1/sessions') && pages++ === 1) {
                fixture.projects.push({ id: 'created-mid-read', startTime: '2026-10-18T00:00:00.000Z', runs: [] });
            }
            return inner(url, init);
        };
        const wire = createSourceWire({ fetchImpl: shifting, deadline: ASOF.getTime() + 60_000, now: () => ASOF.getTime() });
        const result = await langSmithSource({
            endpoint: { cloud: 'us' },
            apiKey: LANGSMITH_API_KEY_VALUE,
            workspaceId: null,
            windowDays: 7,
            readDeployments: false,
        }).read({ asOf: ASOF, ...wire });
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'PAGINATION_TORN' });
    });

    it('a deployments page that does not advance, or is not the listing, is PAGINATION_TORN', async () => {
        const fixture = langSmithFixture();
        for (let i = 0; i < 100; i++) fixture.deployments.push({ id: `dep-bulk-${i}`, tracerSessionId: null });
        const stuck = createSourceFakes({ langsmith: { [LANGSMITH_US]: fixture } });
        const inner = stuck.fetchImpl;
        const noAdvance: typeof inner = async (url, init) => {
            const res = await inner(url, init);
            if (!url.includes('/v2/deployments')) return res;
            const body = (await res.json()) as { resources: unknown[] };
            return new Response(JSON.stringify({ resources: body.resources, offset: 0 }), { status: 200 });
        };
        const wire = createSourceWire({ fetchImpl: noAdvance, deadline: ASOF.getTime() + 60_000, now: () => ASOF.getTime() });
        const source = langSmithSource({ endpoint: { cloud: 'us' }, apiKey: LANGSMITH_API_KEY_VALUE, workspaceId: null, windowDays: 7, readDeployments: true });
        expect(await source.read({ asOf: ASOF, ...wire })).toMatchObject({ status: 'INCOMPLETE', reason: 'PAGINATION_TORN' });

        const shapeless = createSourceFakes();
        shapeless.override = (r) => (r.path === '/v2/deployments' ? { status: 200, body: [] } : undefined);
        expect(await read(shapeless)).toMatchObject({ status: 'INCOMPLETE', reason: 'PAGINATION_TORN', rows: 0 });
    });

    it('a response past the byte cap is BYTE_CAP, and a read past its time box TIME_BOX', async () => {
        expect(await read(createSourceFakes(), { caps: { response: 64 } })).toMatchObject({ status: 'INCOMPLETE', reason: 'BYTE_CAP' });

        let t = ASOF.getTime();
        const fakes = createSourceFakes();
        const inner = fakes.fetchImpl;
        // Each request advances the clock 70 s against a 60 s time box: the
        // second is never started.
        const slow: typeof inner = async (url, init) => {
            t += 70_000;
            return inner(url, init);
        };
        const wire = createSourceWire({ fetchImpl: slow, deadline: ASOF.getTime() + 60_000, now: () => t });
        const result = await langSmithSource({
            endpoint: { cloud: 'us' },
            apiKey: LANGSMITH_API_KEY_VALUE,
            workspaceId: null,
            windowDays: 7,
            readDeployments: true,
        }).read({ asOf: ASOF, ...wire });
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'TIME_BOX', rows: 2 });
    });
});

describe('5. an empty window is EMPTY_SCAN, not a clean bill', () => {
    function quietWorkspace(): LangSmithFixture {
        const fixture = langSmithFixture();
        fixture.deployments = [];
        for (const p of fixture.projects) {
            for (const r of p.runs) (r as { startTime: string }).startTime = '2026-01-01T00:00:00.000Z';
        }
        return fixture;
    }

    it('a workspace whose window holds no tool call and no deployment reports no agent, read in full', async () => {
        const result = await read(createSourceFakes({ langsmith: { [LANGSMITH_US]: quietWorkspace() } }));
        expect(result).toMatchObject({ status: 'COMPLETE', rows: 4, observations: [] });

        const body = buildReportBody({ scanId: 's-empty', asOf: ASOF, scannerAgentId: 'agt_scanner' }, [result]);
        expect(body.agents).toEqual([]);
        const plan = planHarnessScan(body, {
            previousLevels: new Map(),
            registeredAgentIds: new Set(),
            acceptedShortfalls: new Set(),
            intakeClaims: new Map(),
        });
        expect(plan.assert.map((f) => f.code)).toEqual(['EMPTY_SCAN']);
        expect(plan.resolve).not.toContain('EMPTY_SCAN:agt_scanner');
    });
});

describe('6. a self-hosted LangSmith is a customer-named host', () => {
    const selfHosted = (): Fakes => createSourceFakes({ langsmith: { [LANGSMITH_SELF_HOSTED]: { ...langSmithFixture(), selfHosted: true } } });

    it('reads the control plane under /api-host, re-resolving the host before every request', async () => {
        const fakes = selfHosted();
        const lookups: string[] = [];
        const result = await read(fakes, {
            endpoint: { selfHosted: LANGSMITH_SELF_HOSTED },
            resolveHost: async (h) => {
                lookups.push(h);
                return ['203.0.113.10', '2001:db8::10'];
            },
        });
        expect(result).toMatchObject({ status: 'COMPLETE', rows: 6 });
        expect(fakes.log.map((r) => `${r.host}${r.path}`)).toEqual([
            `${SELF_HOST}/api-host/v2/deployments`,
            `${SELF_HOST}/api/v1/sessions`,
        ]);
        expect(lookups).toEqual([SELF_HOST, SELF_HOST]);
        expect(result.observations[0].tools?.[0].tool.server).toBe(`langsmith://${SELF_HOST}/projects/${LS.projectSupport}`);
    });

    it.each([
        ['cloud metadata', ['169.254.169.254']],
        ['a private range', ['10.0.0.12']],
        ['loopback', ['127.0.0.1']],
        ['one private address among public ones', ['203.0.113.10', '192.168.1.5']],
        ['an IPv6 unique-local address', ['fd00::1']],
        ['nothing at all', []],
    ])('a host that resolves to %s is UNREACHABLE, and the key is never sent', async (_label, addresses) => {
        const fakes = selfHosted();
        const result = await read(fakes, { endpoint: { selfHosted: LANGSMITH_SELF_HOSTED }, resolveHost: async () => addresses });
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'UNREACHABLE', rows: 0 });
        expect(fakes.log).toHaveLength(0);
    });

    it('a name that turns private between two requests stops the read at the second', async () => {
        const fakes = selfHosted();
        let n = 0;
        const result = await read(fakes, {
            endpoint: { selfHosted: LANGSMITH_SELF_HOSTED },
            resolveHost: async () => (n++ === 0 ? ['203.0.113.10'] : ['169.254.169.254']),
        });
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'UNREACHABLE', rows: 2 });
        expect(fakes.log.map((r) => r.path)).toEqual(['/api-host/v2/deployments']);
    });

    it('a lookup that fails is UNREACHABLE', async () => {
        const result = await read(selfHosted(), {
            endpoint: { selfHosted: LANGSMITH_SELF_HOSTED },
            resolveHost: async () => {
                throw new Error('ENOTFOUND');
            },
        });
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'UNREACHABLE' });
    });

    it('the cloud hosts are fixed by kind and not re-resolved', async () => {
        const lookups: string[] = [];
        await read(createSourceFakes(), {
            resolveHost: async (h) => {
                lookups.push(h);
                return ['10.0.0.1'];
            },
        });
        expect(lookups).toEqual([]);
    });

    it.each([
        ['an http origin', 'http://langsmith.acme.example'],
        ['a path', 'https://langsmith.acme.example/api/v1'],
        ['credentials in the URL', 'https://user:pass@langsmith.acme.example'],
        ['localhost', 'https://localhost'],
        ['a metadata name', 'https://metadata.google.internal'],
        ['an .internal name', 'https://langsmith.corp.internal'],
        ['a .local name', 'https://langsmith.local'],
        ['a private literal', 'https://10.1.2.3'],
        ['a link-local literal', 'https://169.254.169.254'],
        ['an IPv6 loopback literal', 'https://[::1]'],
    ])('the configuration refuses %s', (_label, url) => {
        expect(customerOriginProblem(url)).not.toBeNull();
    });

    it('accepts a public https origin, with a port', () => {
        expect(customerOriginProblem(LANGSMITH_SELF_HOSTED)).toBeNull();
        expect(customerOriginProblem('https://langsmith.acme.example:8443')).toBeNull();
    });

    it('agrees with the application on every address in the table, so the copy cannot drift', () => {
        const table = [
            '10.0.0.1', '127.0.0.1', '0.0.0.0', '169.254.169.254', '192.168.0.1', '172.16.0.1', '172.31.255.255',
            '172.32.0.1', '100.64.0.1', '100.127.255.255', '100.128.0.1', '203.0.113.10', '8.8.8.8', '::1', '::',
            'fe80::1', 'fc00::1', 'fd12::1', '2001:db8::1', '::ffff:10.0.0.1', '::ffff:8.8.8.8', '[::1]',
        ];
        for (const address of table) expect([address, isPrivateAddress(address)]).toEqual([address, appIsPrivateAddress(address)]);
    });
});

describe('6b. a private-range allowlist for a self-hosted LangSmith', () => {
    const PRIVATE_HOST = 'https://langsmith.corp.internal';
    const selfHostedAt = (origin: string): Fakes =>
        createSourceFakes({ langsmith: { [origin]: { ...langSmithFixture(), selfHosted: true } } });
    const readSelfHosted = (fakes: Fakes, origin: string, allowlist: string[] | undefined, addresses: string[]) =>
        read(fakes, {
            endpoint: { selfHosted: origin, ...(allowlist ? { egressPrivateCidrAllowlist: allowlist } : {}) },
            resolveHost: async () => addresses,
        });

    it('a host resolving inside an allowed range is read', async () => {
        const fakes = selfHostedAt(PRIVATE_HOST);
        const result = await readSelfHosted(fakes, PRIVATE_HOST, ['10.20.0.0/16'], ['10.20.4.7']);
        expect(result).toMatchObject({ status: 'COMPLETE', rows: 6 });
        expect(fakes.log.map((r) => r.path)).toEqual(['/api-host/v2/deployments', '/api/v1/sessions']);
    });

    it('the same host without the allowlist is refused, and no request carries the key', async () => {
        const fakes = selfHostedAt(PRIVATE_HOST);
        const result = await readSelfHosted(fakes, PRIVATE_HOST, undefined, ['10.20.4.7']);
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'UNREACHABLE', rows: 0 });
        expect(fakes.log).toHaveLength(0);
    });

    it.each([
        ['cloud metadata', ['169.254.0.0/16', '0.0.0.0/0'], ['169.254.169.254']],
        ['loopback', ['127.0.0.0/8', '0.0.0.0/0'], ['127.0.0.1']],
        ['v6 link-local', ['fe80::/10', '::/0'], ['fe80::1']],
        ['v6 loopback', ['::1/128', '::/0'], ['::1']],
        ['metadata written as v4-mapped v6', ['::/0', '0.0.0.0/0'], ['::ffff:169.254.169.254']],
    ])('%s is refused even when the allowlist lists it, and nothing is sent', async (_label, allowlist, addresses) => {
        const fakes = selfHostedAt(PRIVATE_HOST);
        const result = await readSelfHosted(fakes, PRIVATE_HOST, allowlist, addresses);
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'UNREACHABLE', rows: 0 });
        expect(fakes.log).toHaveLength(0);
    });

    it('a host that resolves outside the allowlist at use time sends no request and no key', async () => {
        const fakes = selfHostedAt(PRIVATE_HOST);
        const sent: (string | null)[] = [];
        const inner = fakes.fetchImpl;
        const spy: typeof inner = async (url, init) => {
            sent.push(new Headers(init.headers).get('x-api-key'));
            return inner(url, init);
        };
        const wire = createSourceWire({ fetchImpl: spy, deadline: ASOF.getTime() + 60_000, now: () => ASOF.getTime() });
        const result = await langSmithSource({
            endpoint: { selfHosted: PRIVATE_HOST, egressPrivateCidrAllowlist: ['10.20.0.0/16'] },
            apiKey: LANGSMITH_API_KEY_VALUE,
            workspaceId: null,
            windowDays: 7,
            readDeployments: true,
            // Inside the range when the file was written; outside it tonight.
            resolveHost: async () => ['10.99.0.3'],
        }).read({ asOf: ASOF, ...wire });
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'UNREACHABLE', rows: 0 });
        expect(sent).toEqual([]);
        expect(fakes.log).toHaveLength(0);
    });

    it('one address outside the allowlist among allowed ones is enough to refuse', async () => {
        const fakes = selfHostedAt(PRIVATE_HOST);
        const result = await readSelfHosted(fakes, PRIVATE_HOST, ['10.20.0.0/16'], ['10.20.4.7', '192.168.1.9']);
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'UNREACHABLE' });
        expect(fakes.log).toHaveLength(0);
    });

    it('the configuration accepts a private host inside an allowed range, and refuses it without one', () => {
        const allow = parsePrivateCidrAllowlist(['10.20.0.0/16', 'fd00::/8']) ?? [];
        expect(customerOriginProblem('https://10.20.0.5', allow)).toBeNull();
        expect(customerOriginProblem('https://10.20.0.5')).not.toBeNull();
        expect(customerOriginProblem('https://[fd00::5]', allow)).toBeNull();
        expect(customerOriginProblem('https://10.21.0.5', allow)).not.toBeNull();
        // With an allowlist the question is the address, so an internal NAME is accepted.
        expect(customerOriginProblem(PRIVATE_HOST, allow)).toBeNull();
        expect(customerOriginProblem(PRIVATE_HOST)).not.toBeNull();
    });

    it('the configuration refuses metadata, loopback and the blocked names even when the allowlist covers them', () => {
        const everything = parsePrivateCidrAllowlist(['0.0.0.0/0', '::/0', '169.254.0.0/16', '127.0.0.0/8']) ?? [];
        expect(everything).toHaveLength(4);
        for (const origin of ['https://169.254.169.254', 'https://127.0.0.1', 'https://[::1]', 'https://[fe80::1]', 'https://localhost', 'https://metadata.google.internal']) {
            expect([origin, customerOriginProblem(origin, everything)]).toEqual([origin, expect.any(String)]);
        }
    });

    it('agrees with the application on which addresses no allowlist may admit', () => {
        const table = [
            '127.0.0.1', '127.255.255.254', '0.0.0.0', '169.254.169.254', '169.254.0.1', '::1', '::', 'fe80::1',
            '::ffff:169.254.169.254', '::ffff:127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', 'fd00::1', '8.8.8.8',
        ];
        for (const address of table) {
            expect([address, isNeverAllowlistable(address)]).toEqual([address, appIsNeverAllowlistable(address)]);
        }
        expect(addressReachable('203.0.113.10', [])).toBe(true);
        expect(addressReachable('10.0.0.1', [])).toBe(false);
    });

    it('through the configuration: the allowlist is parsed, refused when it is not CIDRs, and used by the scan', async () => {
        const config = (endpoint: Record<string, unknown>) => ({
            estate: 'acme-agents',
            scanner: { agentId: 'agt_scanner', signingKeyEnv: 'SCANNER_SIGNING_KEY' },
            inflect: { baseUrl: INGEST, tenantSlug: 'acme', apiKeyEnv: 'INFLECT_INGEST_KEY' },
            schedule: { everyHours: 24 },
            sources: [{ kind: 'runtime', product: 'langsmith', apiKeyEnv: 'LANGSMITH_API_KEY', endpoint }],
        });
        expect(() => parseScannerConfig(config({ selfHosted: PRIVATE_HOST, egressPrivateCidrAllowlist: ['10.20.0.0'] }))).toThrow(ConfigError);
        expect(() => parseScannerConfig(config({ selfHosted: 'https://10.20.0.5' }))).toThrow(ConfigError);
        expect(() => parseScannerConfig(config({ selfHosted: 'https://169.254.169.254', egressPrivateCidrAllowlist: ['0.0.0.0/0'] }))).toThrow(ConfigError);
        const parsed = parseScannerConfig(config({ selfHosted: PRIVATE_HOST, egressPrivateCidrAllowlist: ['10.20.0.0/16'] }));

        const { privateKey } = generateKeyPairSync('ed25519');
        const fakes = selfHostedAt(PRIVATE_HOST);
        const { body } = await runScan({
            config: parsed,
            env: {
                SCANNER_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
                LANGSMITH_API_KEY: LANGSMITH_API_KEY_VALUE,
            },
            log: jsonLineLog(() => undefined),
            fetchImpl: fakes.fetchImpl,
            resolveHost: async () => ['10.20.4.7'],
            now: () => ASOF.getTime(),
        });
        expect(body.population.sources).toEqual([{ kind: 'runtime', status: 'COMPLETE', rows: 4 }]);
        expect(fakes.log.map((r) => r.path)).toEqual(['/api/v1/sessions']);
    });
});

describe('8. deployments are opt-in', () => {
    function scanWith(readDeployments: boolean | undefined) {
        const { privateKey } = generateKeyPairSync('ed25519');
        const fakes = createSourceFakes();
        const config = parseScannerConfig({
            estate: 'acme-agents',
            scanner: { agentId: 'agt_scanner', signingKeyEnv: 'SCANNER_SIGNING_KEY' },
            inflect: { baseUrl: INGEST, tenantSlug: 'acme', apiKeyEnv: 'INFLECT_INGEST_KEY' },
            schedule: { everyHours: 24 },
            sources: [
                {
                    kind: 'runtime',
                    product: 'langsmith',
                    endpoint: { cloud: 'us' },
                    apiKeyEnv: 'LANGSMITH_API_KEY',
                    ...(readDeployments === undefined ? {} : { readDeployments }),
                },
            ],
        });
        return runScan({
            config,
            env: {
                SCANNER_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
                LANGSMITH_API_KEY: LANGSMITH_API_KEY_VALUE,
            },
            log: jsonLineLog(() => undefined),
            fetchImpl: fakes.fetchImpl,
            now: () => ASOF.getTime(),
        }).then(({ raw, body }) => ({ raw, body, fakes }));
    }

    it('the default configuration issues no deployments request: projects only', async () => {
        const { raw, body, fakes } = await scanWith(undefined);
        expect(fakes.log.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/v1/sessions']);
        expect(body.population.sources).toEqual([{ kind: 'runtime', status: 'COMPLETE', rows: 4 }]);
        expect(body.agents.map((a) => a.discoveredId)).toEqual([
            `langsmith:project:${LS.projectSupport}`,
            `langsmith:project:${LS.projectResearch}`,
        ]);
        // Nothing of the secrets-bearing listing was even received.
        expect(raw).not.toContain(LANGSMITH_MARKERS.deploymentSecretValue);
    });

    it('an estate that opts in lists its deployments, and their projects are no longer agents of their own', async () => {
        const { body, fakes } = await scanWith(true);
        expect(fakes.log.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v2/deployments', 'GET /api/v1/sessions']);
        expect(body.agents.map((a) => a.discoveredId)).toEqual([
            `langsmith:deployment:${LS.deploymentSupport}`,
            `langsmith:deployment:${LS.deploymentIdle}`,
            `langsmith:project:${LS.projectResearch}`,
        ]);
    });

    it('opting out explicitly is the default', async () => {
        const { fakes } = await scanWith(false);
        expect(fakes.log.some((r) => r.path.includes('deployments'))).toBe(false);
    });
});

describe('7. the configuration, and the report merge', () => {
    const base = (source: Record<string, unknown>) => ({
        estate: 'acme-agents',
        scanner: { agentId: 'agt_scanner', signingKeyEnv: 'SCANNER_SIGNING_KEY' },
        inflect: { baseUrl: INGEST, tenantSlug: 'acme', apiKeyEnv: 'INFLECT_INGEST_KEY' },
        schedule: { everyHours: 24 },
        sources: [{ kind: 'runtime', product: 'langsmith', apiKeyEnv: 'LANGSMITH_API_KEY', ...source }],
    });

    it('names the key by environment variable, and applies the window and deployment defaults', () => {
        const config = parseScannerConfig(base({ endpoint: { cloud: 'eu' } }));
        expect(credentialEnvNames(config)).toEqual(['SCANNER_SIGNING_KEY', 'INFLECT_INGEST_KEY', 'LANGSMITH_API_KEY']);
        expect(config.sources[0]).toMatchObject({ kind: 'runtime', windowDays: 7, readDeployments: false });
        expect(parseScannerConfig(base({ endpoint: { selfHosted: LANGSMITH_SELF_HOSTED } })).sources[0]).toMatchObject({
            endpoint: { selfHosted: LANGSMITH_SELF_HOSTED },
        });
    });

    it.each([
        ['a cloud region that is not US or EU', { endpoint: { cloud: 'apac' } }],
        ['both a cloud and a self-hosted host', { endpoint: { cloud: 'us', selfHosted: LANGSMITH_SELF_HOSTED } }],
        ['no endpoint', {}],
        ['a self-hosted host on a private address', { endpoint: { selfHosted: 'https://10.0.0.5' } }],
        ['a window past thirty days', { endpoint: { cloud: 'us' }, windowDays: 31 }],
        ['a key given inline', { endpoint: { cloud: 'us' }, apiKey: 'value' }],
        ['another runtime product', { endpoint: { cloud: 'us' }, product: 'langfuse' }],
    ])('refuses %s', (_label, source) => {
        expect(() => parseScannerConfig(base(source))).toThrow(ConfigError);
    });

    it('refuses a credential pasted into the source, by path and never by value', () => {
        const pasted = ['gh', 'p_', 'L'.repeat(36)].join('');
        let message = '';
        try {
            parseScannerConfig(base({ endpoint: { cloud: 'us' }, apiKeyEnv: pasted }));
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).toContain('sources[0].apiKeyEnv');
        expect(message).not.toContain(pasted);
    });

    it('tools merge by (server, name) across sources, and tools past the per-agent cap are cut and marked BYTE_CAP', () => {
        const tool = (name: string) => ({
            tool: { server: 'langsmith://api.smith.langchain.com/projects/p1', name, manifestHash: null, pinned: false, readOnlyHint: null },
            calls: 1,
        });
        const many = Array.from({ length: MAX_TOOLS_PER_AGENT + 1 }, (_, i) => tool(`t${String(i).padStart(3, '0')}`));
        const body = buildReportBody({ scanId: 's1', asOf: ASOF, scannerAgentId: 'agt' }, [
            { kind: 'runtime', status: 'COMPLETE', rows: 1, observations: [{ discoveredId: 'langsmith:project:p1', owner: null, credentials: [], verdicts: [], tools: many }] },
        ]);
        expect(body.agents[0].tools).toHaveLength(MAX_TOOLS_PER_AGENT);
        expect(body.population.sources).toEqual([{ kind: 'runtime', status: 'INCOMPLETE', reason: 'BYTE_CAP', rows: 1 }]);

        const merged = buildReportBody({ scanId: 's2', asOf: ASOF, scannerAgentId: 'agt' }, [
            { kind: 'runtime', status: 'COMPLETE', rows: 1, observations: [{ discoveredId: 'x', owner: null, credentials: [], verdicts: [], tools: [tool('b'), tool('a')] }] },
            { kind: 'mcp', status: 'COMPLETE', rows: 1, observations: [{ discoveredId: 'x', owner: null, credentials: [], verdicts: [], tools: [tool('a')] }] },
        ]);
        expect(merged.agents[0]).toMatchObject({ discoveredVia: ['mcp', 'runtime'] });
        expect(merged.agents[0].tools.map((t) => t.name)).toEqual(['a', 'b']);
    });
});
