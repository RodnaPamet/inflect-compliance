/**
 * The scanner's MCP source over two fixture servers (#3686, part b).
 *
 *   1. THE THREE MESSAGES, by the request log (DPIA condition 1 as amended by
 *      owner decision 5): `initialize`, `notifications/initialized`,
 *      `tools/list` — and never `tools/call`, which the fake would answer.
 *   2. WHAT A TOOL CARRIES: its name, the configured URL, the declared
 *      `readOnlyHint`, a hash of its definition — never the definition's text —
 *      and `pinned` only while the live listing matches the estate's pin.
 *   3. WHICH AGENT (owner decision 2): the agents the configuration lists, and
 *      a `code` agent's `<key>:*` placeholder for the same URL, replaced in the
 *      report by the tools the server serves.
 *   4. THE READ TOKEN (owner decision 6): sent to its own server, with the
 *      three messages; missing, it leaves that server unread and the others not.
 *   5. A read that stops is INCOMPLETE with the contract's reason.
 *   6. Through the runner: a signed report the ingest verifies.
 */
import { generateKeyPairSync } from 'crypto';

import {
    createSourceFakes,
    INGEST,
    MCP_CRM,
    MCP_MARKERS,
    MCP_TICKETS,
    MCP_TOKEN_VALUE,
    mcpFixtures,
    NEVER_REPORTED,
    type Fakes,
    type McpServerFixture,
} from '../../helpers/agent-harness-source-fakes';
import { verifyAndParseHarnessReport } from '@/lib/agentic/harness-contract';
import { ConfigError, credentialEnvNames, parseScannerConfig } from '../../../packages/agent-harness-scanner/src/config';
import { createSourceWire } from '../../../packages/agent-harness-scanner/src/http';
import { jsonLineLog } from '../../../packages/agent-harness-scanner/src/log';
import { buildReportBody, rawPublicKeyHex } from '../../../packages/agent-harness-scanner/src/report';
import { runScan } from '../../../packages/agent-harness-scanner/src/scan';
import { isDeclaredMcpMessage, isDeclaredRequest } from '../../../packages/agent-harness-scanner/src/scanner-surface';
import { mcpListingHash, mcpSource, mcpToolHash, type McpServerOptions } from '../../../packages/agent-harness-scanner/src/sources/mcp';
import type { SourceRead } from '../../../packages/agent-harness-scanner/src/source';

const ASOF = new Date('2026-10-19T03:00:00.000Z');
const PUBLIC = async () => ['203.0.113.10'];
const CRM_AGENT = 'entra:sp:a0000001-0000-4000-8000-000000003686';
const TICKETS_AGENT = 'okta:app:0oaService1';

function server(url: string, over: Partial<McpServerOptions> = {}): McpServerOptions {
    return {
        label: url === MCP_CRM ? 'crm' : 'tickets',
        url,
        agents: [url === MCP_CRM ? CRM_AGENT : TICKETS_AGENT],
        pinnedManifestHash: null,
        token: url === MCP_TICKETS ? { value: MCP_TOKEN_VALUE } : null,
        egressPrivateCidrAllowlist: [],
        ...over,
    };
}

async function read(
    fakes: Fakes,
    servers: McpServerOptions[] = [server(MCP_CRM), server(MCP_TICKETS)],
    resolveHost = PUBLIC,
    deadline = ASOF.getTime() + 60_000,
): Promise<SourceRead> {
    const wire = createSourceWire({ fetchImpl: fakes.fetchImpl, deadline, now: () => ASOF.getTime() });
    return mcpSource({ servers, resolveHost }).read({ asOf: ASOF, deadline, now: () => ASOF.getTime(), ...wire });
}

/** The CRM fixture's listing, hashed as the source hashes it: what an estate would pin. */
function crmListingHash(): string {
    const tools = mcpFixtures()[MCP_CRM].tools.flat() as { name: string }[];
    return mcpListingHash(tools.map((t) => ({ name: t.name, manifestHash: mcpToolHash(t) })));
}

describe('1. the three messages, by the request log', () => {
    it('initialize, the initialized notification, then tools/list paged — and never tools/call', async () => {
        const fakes = createSourceFakes();
        const result = await read(fakes);
        expect(result).toMatchObject({ kind: 'mcp', status: 'COMPLETE', rows: 4 });

        const crm = fakes.log.filter((r) => `https://${r.host}${r.path}` === MCP_CRM);
        expect(crm.map((r) => r.rpc)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list']);
        const tickets = fakes.log.filter((r) => `https://${r.host}${r.path}` === MCP_TICKETS);
        expect(tickets.map((r) => r.rpc)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);

        for (const r of fakes.log) {
            expect(r.method).toBe('POST');
            expect(isDeclaredMcpMessage(r.body ?? '')).toBe(true);
        }
        expect(fakes.log.some((r) => r.rpc === 'tools/call')).toBe(false);
        expect(JSON.stringify(result)).not.toContain(MCP_MARKERS.toolCallResult);
    });

    it('the declared surface admits the three messages and nothing else', () => {
        for (const method of ['initialize', 'notifications/initialized', 'tools/list']) {
            expect(isDeclaredMcpMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method }))).toBe(true);
        }
        for (const method of ['tools/call', 'resources/read', 'prompts/get', 'sampling/createMessage']) {
            expect(isDeclaredMcpMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method }))).toBe(false);
        }
        // A POST to an MCP host is not a GET read, an ingest post or a token exchange.
        expect(isDeclaredRequest('POST', MCP_CRM)).toBe(false);
    });
});

describe('2. what a tool carries', () => {
    it('its name, the configured URL, the declared hint and a hash of its definition — never its text', async () => {
        const result = await read(createSourceFakes());
        const crm = result.observations.find((o) => o.discoveredId === CRM_AGENT);
        const [first] = mcpFixtures()[MCP_CRM].tools[0] as Record<string, unknown>[];
        expect(crm?.tools?.map((t) => t.tool)).toEqual([
            { server: MCP_CRM, name: 'list_pipelines', manifestHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), pinned: false, readOnlyHint: null },
            { server: MCP_CRM, name: 'lookup_account', manifestHash: mcpToolHash(first), pinned: false, readOnlyHint: true },
            { server: MCP_CRM, name: 'update_opportunity', manifestHash: expect.stringMatching(/^sha256:/), pinned: false, readOnlyHint: false },
        ]);
        expect(JSON.stringify(result)).not.toContain(MCP_MARKERS.toolDescription);
        expect(JSON.stringify(result)).not.toContain(MCP_MARKERS.serverInstructions);
    });

    it('pinned only while the live listing matches the estate\'s pin, and a changed tool unpins every one', async () => {
        const pinned = await read(createSourceFakes(), [server(MCP_CRM, { pinnedManifestHash: crmListingHash() })]);
        expect(pinned.observations[0].tools?.every((t) => t.tool.pinned)).toBe(true);
        expect(pinned.mcpServers?.[0].manifestHash).toBe(crmListingHash());

        const changed = mcpFixtures();
        (changed[MCP_CRM].tools[1][0] as Record<string, unknown>).annotations = { readOnlyHint: true };
        const after = await read(createSourceFakes({ mcp: changed }), [server(MCP_CRM, { pinnedManifestHash: crmListingHash() })]);
        expect(after.observations[0].tools?.some((t) => t.tool.pinned)).toBe(false);
    });

    it('a server that declares no tools capability lists none, and is still read in full', async () => {
        const fixtures = mcpFixtures();
        fixtures[MCP_CRM].capabilities = { resources: {} };
        const fakes = createSourceFakes({ mcp: fixtures });
        const result = await read(fakes, [server(MCP_CRM)]);
        expect(result).toMatchObject({ status: 'COMPLETE', rows: 0 });
        expect(fakes.log.map((r) => r.rpc)).toEqual(['initialize', 'notifications/initialized']);
    });
});

describe('3. which agent a server\'s tools belong to', () => {
    it('the agents the configuration lists, each with the server\'s tools', async () => {
        const result = await read(createSourceFakes());
        expect(result.observations.map((o) => [o.discoveredId, o.tools?.map((t) => t.tool.name)])).toEqual([
            [CRM_AGENT, ['list_pipelines', 'lookup_account', 'update_opportunity']],
            [TICKETS_AGENT, ['search_tickets']],
        ]);
        expect(result.observations.every((o) => o.credentials.length === 0 && o.owner === null)).toBe(true);
    });

    it('a code agent\'s <key>:* placeholder for a server read in full becomes the server\'s tools, via mcp', async () => {
        const mcpRead = await read(createSourceFakes(), [server(MCP_CRM, { agents: [] })]);
        const codeRead: SourceRead = {
            kind: 'code',
            status: 'COMPLETE',
            rows: 1,
            observations: [
                {
                    discoveredId: 'code:acme/ops/graph.py#ops_graph',
                    owner: null,
                    credentials: [],
                    verdicts: [],
                    tools: [
                        // The same URL spelt with a trailing slash is the same endpoint.
                        { tool: { server: `${MCP_CRM}/`, name: 'crm:*', manifestHash: null, pinned: false, readOnlyHint: null } },
                        { tool: { server: 'code://acme/ops/graph.py#L17', name: 'read_metrics', manifestHash: null, pinned: false, readOnlyHint: null } },
                    ],
                },
            ],
        };
        const body = buildReportBody({ scanId: 'scan-1', asOf: ASOF, scannerAgentId: 'agt_scanner' }, [codeRead, mcpRead]);
        const [agent] = body.agents;
        expect(agent.discoveredVia).toEqual(['mcp', 'code']);
        expect(agent.tools.map((t) => t.name).sort()).toEqual(['list_pipelines', 'lookup_account', 'read_metrics', 'update_opportunity']);
        expect(agent.tools.some((t) => t.name.endsWith(':*'))).toBe(false);
    });

    it('a server read in part replaces nothing: the placeholder, which counts as a write, stays', async () => {
        const fakes = createSourceFakes();
        fakes.override = (r) => (r.rpc === 'tools/list' && r.body?.includes('"cursor"') ? { status: 503 } : undefined);
        const mcpRead = await read(fakes, [server(MCP_CRM, { agents: [] })]);
        expect(mcpRead).toMatchObject({ status: 'INCOMPLETE', reason: 'UNREACHABLE', mcpServers: [] });
        const placeholder = { server: MCP_CRM, name: 'crm:*', manifestHash: null, pinned: false, readOnlyHint: null };
        const codeRead: SourceRead = {
            kind: 'code',
            status: 'COMPLETE',
            rows: 1,
            observations: [{ discoveredId: 'code:a.py#x', owner: null, credentials: [], verdicts: [], tools: [{ tool: placeholder }] }],
        };
        const body = buildReportBody({ scanId: 'scan-2', asOf: ASOF, scannerAgentId: 'agt_scanner' }, [codeRead, mcpRead]);
        expect(body.agents[0].tools).toEqual([placeholder]);
        expect(body.agents[0].discoveredVia).toEqual(['code']);
    });
});

describe('4. the read token', () => {
    it('is sent to its own server only, as a bearer token', async () => {
        const fakes = createSourceFakes();
        const seen: Record<string, string | null> = {};
        const inner = fakes.fetchImpl;
        const wrapped: Fakes = {
            ...fakes,
            fetchImpl: async (url, init) => {
                seen[url] = new Headers(init.headers).get('authorization');
                return inner(url, init);
            },
        };
        await read(wrapped);
        expect(seen[MCP_TICKETS]).toBe(`Bearer ${MCP_TOKEN_VALUE}`);
        expect(seen[MCP_CRM]).toBeNull();
    });

    it('missing from the environment: that server is unread (AUTH_FAILED), and the other is still read', async () => {
        const fakes = createSourceFakes();
        const result = await read(fakes, [server(MCP_TICKETS, { token: 'MISSING' }), server(MCP_CRM)]);
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'AUTH_FAILED' });
        expect(fakes.log.some((r) => r.path === '/tickets/mcp')).toBe(false);
        expect(result.mcpServers?.map((s) => s.label)).toEqual(['crm']);
    });

    it('refused by the server: AUTH_FAILED', async () => {
        const result = await read(createSourceFakes(), [server(MCP_TICKETS, { token: { value: 'not-the-token' } })]);
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'AUTH_FAILED', mcpServers: [] });
    });
});

describe('5. a read that stops is INCOMPLETE, with its reason', () => {
    it('a host that resolves to a private address is never sent anything', async () => {
        const fakes = createSourceFakes();
        const result = await read(fakes, [server(MCP_CRM)], async () => ['10.0.0.5']);
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'UNREACHABLE' });
        expect(fakes.log).toHaveLength(0);
    });

    it('a cursor the listing already served is PAGINATION_TORN', async () => {
        const fixtures: Record<string, McpServerFixture> = mcpFixtures();
        fixtures[MCP_CRM].tools = [[{ name: 'a', inputSchema: {} }], [{ name: 'b', inputSchema: {} }]];
        const fakes = createSourceFakes({ mcp: fixtures });
        // Every page points back at page 1.
        fakes.override = (r) =>
            r.rpc === 'tools/list' && r.body?.includes('"cursor"')
                ? { status: 200, headers: { 'content-type': 'application/json' }, raw: JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(r.body ?? '{}').id, result: { tools: [{ name: 'c', inputSchema: {} }], nextCursor: '1' } }) }
                : undefined;
        expect(await read(fakes, [server(MCP_CRM)])).toMatchObject({ status: 'INCOMPLETE', reason: 'PAGINATION_TORN' });
    });

    it('an answer in a content type MCP does not use is PAGINATION_TORN, and one tool named twice is too', async () => {
        const fakes = createSourceFakes();
        fakes.override = (r) => (r.rpc === 'initialize' ? { status: 200, headers: { 'content-type': 'text/html' }, raw: '<html></html>' } : undefined);
        expect(await read(fakes, [server(MCP_CRM)])).toMatchObject({ status: 'INCOMPLETE', reason: 'PAGINATION_TORN' });

        const twice = mcpFixtures();
        twice[MCP_CRM].tools = [[{ name: 'dup', inputSchema: {} }, { name: 'dup', inputSchema: { type: 'object' } }]];
        expect(await read(createSourceFakes({ mcp: twice }), [server(MCP_CRM)])).toMatchObject({ status: 'INCOMPLETE', reason: 'PAGINATION_TORN' });
    });

    it('a response past the byte cap is BYTE_CAP, and the time box is TIME_BOX', async () => {
        const fakes = createSourceFakes();
        fakes.override = (r) =>
            r.rpc === 'tools/list' ? { status: 200, headers: { 'content-type': 'application/json' }, raw: 'x'.repeat(5 * 1024 * 1024) } : undefined;
        expect(await read(fakes, [server(MCP_CRM)])).toMatchObject({ status: 'INCOMPLETE', reason: 'BYTE_CAP' });

        expect(await read(createSourceFakes(), [server(MCP_CRM)], PUBLIC, ASOF.getTime() - 1)).toMatchObject({
            status: 'INCOMPLETE',
            reason: 'TIME_BOX',
        });
    });
});

describe('6. through the runner', () => {
    function mcpConfig(servers: Record<string, unknown>[]) {
        return {
            estate: 'acme-mcp',
            scanner: { agentId: 'agt_scanner_acme', signingKeyEnv: 'SCANNER_SIGNING_KEY' },
            inflect: { baseUrl: INGEST, tenantSlug: 'acme', apiKeyEnv: 'INFLECT_INGEST_KEY' },
            schedule: { everyHours: 24 },
            sources: [{ kind: 'mcp', servers }],
        };
    }
    const servers = () => [
        { label: 'crm', url: MCP_CRM, agents: [CRM_AGENT], pinnedManifestHash: crmListingHash() },
        { label: 'tickets', url: MCP_TICKETS, agents: [TICKETS_AGENT], readTokenEnv: 'MCP_TICKETS_TOKEN' },
    ];

    it('a signed report the ingest verifies, with each server\'s pin hash in the log and no token anywhere', async () => {
        const { privateKey, publicKey } = generateKeyPairSync('ed25519');
        const fakes = createSourceFakes();
        const lines: string[] = [];
        const { raw, body } = await runScan({
            config: parseScannerConfig(mcpConfig(servers())),
            env: {
                SCANNER_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
                INFLECT_INGEST_KEY: 'iflk_fake-ingest-key-3686',
                MCP_TICKETS_TOKEN: MCP_TOKEN_VALUE,
            },
            log: jsonLineLog((l) => lines.push(l)),
            fetchImpl: fakes.fetchImpl,
            resolveHost: PUBLIC,
            now: () => ASOF.getTime(),
        });
        expect(verifyAndParseHarnessReport(raw, [rawPublicKeyHex(publicKey)])).toMatchObject({ ok: true, complete: true });
        expect(body.population.sources).toEqual([{ kind: 'mcp', status: 'COMPLETE', rows: 4 }]);
        const crm = body.agents.find((a) => a.discoveredId === CRM_AGENT);
        expect(crm?.tools.every((t) => t.pinned)).toBe(true);
        expect(crm?.discoveredVia).toEqual(['mcp']);

        const logText = lines.join('\n');
        expect(logText).toContain(crmListingHash());
        expect(logText).not.toContain(MCP_CRM);
        for (const never of NEVER_REPORTED) {
            expect(raw).not.toContain(never);
            expect(logText).not.toContain(never);
        }
    });

    it('the configuration takes https endpoints the scanner may reach, read tokens by name, and nothing else', () => {
        expect(credentialEnvNames(parseScannerConfig(mcpConfig(servers())))).toContain('MCP_TICKETS_TOKEN');
        const refused = (over: Record<string, unknown>) => () => parseScannerConfig(mcpConfig([{ ...servers()[0], ...over }]));
        expect(refused({ url: 'http://mcp.acme.example/crm/mcp' })).toThrow(ConfigError);
        expect(refused({ url: 'https://user:pw@mcp.acme.example/crm/mcp' })).toThrow(ConfigError);
        expect(refused({ url: 'https://10.0.0.5/mcp' })).toThrow(ConfigError);
        expect(refused({ url: 'https://169.254.169.254/mcp', egressPrivateCidrAllowlist: ['0.0.0.0/0'] })).toThrow(ConfigError);
        expect(refused({ writeTokenEnv: 'MCP_WRITE' })).toThrow(ConfigError);
        expect(refused({ agents: ['not a discovered id'] })).toThrow(ConfigError);
        // A private endpoint is accepted only inside the estate's own allowlist.
        expect(() => parseScannerConfig(mcpConfig([{ ...servers()[0], url: 'https://10.0.0.5/mcp', egressPrivateCidrAllowlist: ['10.0.0.0/8'] }]))).not.toThrow();
    });
});
