/**
 * The LangChain and LangGraph detector — the scanner's `code` source (#3737).
 *
 *   1. Each fixture estate — LangChain Python, LangChain JS, LangGraph —
 *      yields the expected agents, with their tools, their model endpoints and
 *      their credentials.
 *   2. The detector never executes or imports what it reads: definitions whose
 *      import would have a side effect are read, recognised, and never run.
 *   3. Credentials appear by reference only, over the whole signed report.
 *   4. An unreadable location or an unresolvable definition is INCOMPLETE with
 *      a named reason; nothing is left out.
 *   5. Its reports verify under `inflect-agent-harness/2`, beside the other
 *      sources, with no change to the contract.
 */
import { execFileSync } from 'child_process';
import { existsSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { lstat, readdir, readFile } from 'fs/promises';
import { generateKeyPairSync } from 'crypto';
import { join } from 'path';

import {
    LANGCHAIN_JS,
    LANGCHAIN_PYTHON,
    LANGGRAPH,
    NOT_LANGCHAIN,
    PLAIN_LITERAL_KEY,
    SIDE_EFFECT,
    SIDE_EFFECT_ENV,
    UNPARSEABLE,
    fakeOpenAiKey,
    literalCredentials,
    writeCodeEstate,
} from '../../helpers/agent-harness-code-fixtures';
import { HARNESS_CONTRACT_V2, looksLikeSecret, verifyAndParseHarnessReport } from '@/lib/agentic/harness-contract';
import { parseScannerConfig } from '../../../packages/agent-harness-scanner/src/config';
import { jsonLineLog } from '../../../packages/agent-harness-scanner/src/log';
import { rawPublicKeyHex } from '../../../packages/agent-harness-scanner/src/report';
import { runScan } from '../../../packages/agent-harness-scanner/src/scan';
import { scannerManifestHash, SCANNER_SURFACE } from '../../../packages/agent-harness-scanner/src/scanner-surface';
import type { CodeFs } from '../../../packages/agent-harness-scanner/src/sources/code/files';
import { MAX_FILE_BYTES } from '../../../packages/agent-harness-scanner/src/sources/code/files';
import type { DetectedAgent } from '../../../packages/agent-harness-scanner/src/sources/code/recognize';
import { langchainCodeSource, scanLangChainCode } from '../../../packages/agent-harness-scanner/src/sources/langchain';
import type { ReadOnlyHttp, TokenExchange } from '../../../packages/agent-harness-scanner/src/http';
import type { SourceRead } from '../../../packages/agent-harness-scanner/src/source';

const REAL_FS: CodeFs = { lstat: (p) => lstat(p), readdir: (p) => readdir(p), readFile: (p) => readFile(p) };
const LATER = { deadline: Number.MAX_SAFE_INTEGER, now: Date.now };
const made: string[] = [];

function estate(...trees: Readonly<Record<string, string>>[]): string {
    const dir = writeCodeEstate(...trees);
    made.push(dir);
    return dir;
}
afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

async function agentsIn(...trees: Readonly<Record<string, string>>[]) {
    const scan = await scanLangChainCode([{ label: 'acme', path: estate(...trees) }], REAL_FS, LATER);
    return { scan, byName: new Map(scan.agents.map((a) => [a.name, a])) };
}

/** A wire that fails the test if the code source ever touches it. */
const NO_WIRE: { http: ReadOnlyHttp; tokens: TokenExchange } = {
    http: {
        getJson: async () => {
            throw new Error('the code source makes no request');
        },
    },
    tokens: {
        clientCredentials: async () => {
            throw new Error('the code source exchanges no token');
        },
    },
};

function read(source: ReturnType<typeof langchainCodeSource>, deadline = Number.MAX_SAFE_INTEGER): Promise<SourceRead> {
    return source.read({ asOf: new Date(), deadline, now: Date.now, ...NO_WIRE });
}

const summary = (a: DetectedAgent) => ({
    framework: a.framework,
    language: a.language,
    discoveredId: a.discoveredId,
    tools: a.tools.map((t) => [t.kind, t.name, t.server]),
    models: a.models.map((m) => [m.provider, m.model, m.endpoint, m.endpointBasis]),
    credentials: a.credentials.map((c) => [c.ref, c.basis]),
});

describe('1. each fixture estate yields its agents, tools, model endpoints and credentials', () => {
    it('LangChain Python: an executor absorbs the agent it wraps, and is reported once', async () => {
        const { scan, byName } = await agentsIn(LANGCHAIN_PYTHON);
        expect(scan.problems).toEqual([]);
        expect([...byName.keys()]).toEqual(['support_executor']);
        expect(summary(byName.get('support_executor')!)).toEqual({
            framework: 'langchain',
            language: 'python',
            discoveredId: 'code:acme/support/agent.py#support_executor',
            tools: [
                ['function', 'lookup_order', 'code://acme/support/agent.py#L11'],
                ['function', 'refund_order', 'code://acme/support/agent.py#L17'],
                ['function', 'escalate_ticket', 'code://acme/support/agent.py#L26'],
                ['builtin', 'TavilySearchResults', 'code://acme/support/agent.py#L35'],
            ],
            models: [['openai', 'gpt-4o-mini', 'https://llm-gateway.acme.example/v1', 'explicit']],
            credentials: [
                ['env://SUPPORT_OPENAI_KEY', 'environment'],
                ['env://TAVILY_API_KEY', 'provider-default'],
            ],
        });
    });

    it('LangChain JS, and LangGraph JS\'s prebuilt agent beside it', async () => {
        const { scan, byName } = await agentsIn(LANGCHAIN_JS);
        expect(scan.problems).toEqual([]);
        expect(summary(byName.get('researchExecutor')!)).toEqual({
            framework: 'langchain',
            language: 'javascript',
            discoveredId: 'code:acme/research/agent.ts#researchExecutor',
            tools: [
                ['function', 'search_papers', 'code://acme/research/agent.ts#L7'],
                ['function', 'save_note', 'code://acme/research/agent.ts#L13'],
            ],
            models: [['anthropic', 'research-model-v1', 'https://api.anthropic.com', 'provider-default']],
            credentials: [['env://RESEARCH_ANTHROPIC_KEY', 'environment']],
        });
        expect(summary(byName.get('triageAgent')!)).toEqual({
            framework: 'langgraph',
            language: 'javascript',
            discoveredId: 'code:acme/research/triage.js#triageAgent',
            tools: [['builtin', 'TavilySearchResults', 'code://acme/research/triage.js#L6']],
            models: [['openai', 'gpt-4o', 'env://TRIAGE_LLM_URL', 'environment']],
            credentials: [
                ['env://OPENAI_API_KEY', 'provider-default'],
                ['env://TAVILY_API_KEY', 'provider-default'],
            ],
        });
        expect(byName.size).toBe(2);
    });

    it('LangGraph: a compiled StateGraph with a ToolNode and a bound model, and a prebuilt agent over an MCP server', async () => {
        const { scan, byName } = await agentsIn(LANGGRAPH);
        expect(scan.problems).toEqual([]);
        expect(summary(byName.get('ops_graph')!)).toEqual({
            framework: 'langgraph',
            language: 'python',
            discoveredId: 'code:acme/ops/graph.py#ops_graph',
            tools: [
                ['function', 'restart_service', 'code://acme/ops/graph.py#L11'],
                ['function', 'read_metrics', 'code://acme/ops/graph.py#L17'],
            ],
            models: [['anthropic', 'ops-model-v1', 'https://api.anthropic.com', 'provider-default']],
            credentials: [['env://OPS_ANTHROPIC_KEY', 'environment']],
        });
        expect(summary(byName.get('oncall_agent')!)).toEqual({
            framework: 'langgraph',
            language: 'python',
            discoveredId: 'code:acme/ops/graph.py#oncall_agent',
            tools: [
                ['mcp', 'tickets:*', 'https://mcp.acme.example/tickets/mcp'],
                ['function', 'read_metrics', 'code://acme/ops/graph.py#L17'],
            ],
            models: [['openai', 'gpt-4.1', 'https://api.openai.com/v1', 'provider-default']],
            credentials: [
                ['env://OPENAI_API_KEY', 'provider-default'],
                ['env://TICKETS_MCP_TOKEN', 'environment'],
            ],
        });
        expect(byName.size).toBe(2);
    });

    it('a name that only LOOKS like the framework\'s is not an agent', async () => {
        const { scan } = await agentsIn(NOT_LANGCHAIN);
        expect(scan.agents).toEqual([]);
        expect(scan.problems).toEqual([]);
    });
});

describe('2. the detector never executes or imports scanned code', () => {
    it('reads and recognises definitions whose import would have a side effect, and the side effect never happens', async () => {
        const dir = estate(SIDE_EFFECT);
        const marker = join(dir, 'side-effect-happened');
        const before = process.env[SIDE_EFFECT_ENV];
        process.env[SIDE_EFFECT_ENV] = marker;
        try {
            const scan = await scanLangChainCode([{ label: 'acme', path: dir }], REAL_FS, LATER);
            // The files WERE read: each agent in them was recognised…
            expect(scan.agents.map((a) => a.name).sort()).toEqual(['executed_agent', 'importedAgent', 'loadedAgent']);
            // …and nothing in them ran: no marker file, no global.
            expect(existsSync(marker)).toBe(false);
            expect((globalThis as { __harnessSideEffect?: unknown }).__harnessSideEffect).toBeUndefined();
            // The proof is live: loading one of them for real — in a separate
            // Node process, from this test and never from the scanner — DOES
            // leave the mark before it fails on the package it cannot find.
            expect(() =>
                execFileSync(process.execPath, [join(dir, 'side-effect/agent.js')], {
                    env: { ...process.env, [SIDE_EFFECT_ENV]: marker },
                    stdio: 'ignore',
                }),
            ).toThrow();
            expect(existsSync(marker)).toBe(true);
        } finally {
            delete (globalThis as { __harnessSideEffect?: unknown }).__harnessSideEffect;
            if (before === undefined) delete process.env[SIDE_EFFECT_ENV];
            else process.env[SIDE_EFFECT_ENV] = before;
        }
    });

    it('declares the file reads in the manifest it hashes, and says it executes nothing', () => {
        expect(SCANNER_SURFACE.readsFiles).toEqual([
            expect.objectContaining({ source: 'code', operations: ['lstat', 'readdir', 'readFile'], followsSymlinks: false, executes: false }),
        ]);
        expect(scannerManifestHash()).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
});

describe('3. credentials by reference only', () => {
    it('a literal in the code is reported as where it is written, never as what it is', async () => {
        const { byName } = await agentsIn(literalCredentials());
        expect(byName.get('hardcoded_py')!.credentials).toEqual([
            { ref: 'code://acme/hardcoded/agent.py#L4', basis: 'literal', at: { label: 'acme', path: 'hardcoded/agent.py', line: 4 } },
        ]);
        expect(byName.get('hardcodedJs')!.credentials.map((c) => c.ref)).toEqual(['code://acme/hardcoded/agent.js#L4']);
    });

    it('no literal value reaches the signed report, secret-shaped or not', async () => {
        expect(looksLikeSecret(fakeOpenAiKey())).toBe(true);
        expect(looksLikeSecret(PLAIN_LITERAL_KEY)).toBe(false);
        const dir = estate(LANGCHAIN_PYTHON, literalCredentials());
        const { privateKey, publicKey } = generateKeyPairSync('ed25519');
        const { raw, body } = await runScan({
            config: parseScannerConfig({
                estate: 'acme-code',
                scanner: { agentId: 'agt_scanner_code', signingKeyEnv: 'SCANNER_SIGNING_KEY' },
                inflect: { baseUrl: 'https://inflect.example.com', tenantSlug: 'acme', apiKeyEnv: 'INFLECT_INGEST_KEY' },
                schedule: { everyHours: 24 },
                sources: [{ kind: 'code', product: 'langchain', roots: [{ label: 'acme', path: dir }] }],
            }),
            env: { SCANNER_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
            log: jsonLineLog(() => undefined),
            fetchImpl: async () => {
                throw new Error('the code source makes no request');
            },
        });
        for (const literal of [fakeOpenAiKey(), PLAIN_LITERAL_KEY]) expect(raw).not.toContain(literal);
        // The absolute path is not in it either: only the root's label.
        expect(raw).not.toContain(dir);
        expect(verifyAndParseHarnessReport(raw, [rawPublicKeyHex(publicKey)])).toMatchObject({ ok: true, complete: true });
        expect(body.agents.map((a) => a.discoveredId)).toContain('code:acme/hardcoded/agent.py#hardcoded_py');
    });
});

describe('4. what cannot be read or resolved is INCOMPLETE with its reason, never left out', () => {
    it('a definition built from what the reader cannot see: UNPARSEABLE, and the agent is still reported', async () => {
        const source = langchainCodeSource({ roots: [{ label: 'acme', path: estate({ 'dynamic/assistant.py': UNPARSEABLE['dynamic/assistant.py'] }) }] });
        const result = await read(source);
        expect(result).toMatchObject({ kind: 'code', status: 'INCOMPLETE', reason: 'UNPARSEABLE', rows: 1 });
        expect(result.observations.map((o) => o.discoveredId)).toEqual(['code:acme/dynamic/assistant.py#assistant']);
    });

    it('a file that does not parse: UNPARSEABLE, and the other files are still read', async () => {
        const source = langchainCodeSource({
            roots: [{ label: 'acme', path: estate(LANGGRAPH, { 'broken/agent.py': UNPARSEABLE['broken/agent.py'] }) }],
        });
        const result = await read(source);
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'UNPARSEABLE', rows: 2 });
        expect(result.observations.map((o) => o.discoveredId).sort()).toEqual([
            'code:acme/ops/graph.py#oncall_agent',
            'code:acme/ops/graph.py#ops_graph',
        ]);
    });

    it('a root that does not exist: UNREACHABLE', async () => {
        const result = await read(langchainCodeSource({ roots: [{ label: 'gone', path: '/nonexistent/harness-code-root' }] }));
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'UNREACHABLE', rows: 0, observations: [] });
    });

    it('a file the operating system refuses: AUTH_FAILED, beside what was read', async () => {
        const dir = estate(LANGCHAIN_PYTHON, LANGGRAPH);
        const denying: CodeFs = {
            ...REAL_FS,
            readFile: async (p) => {
                if (p.endsWith('ops/graph.py')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
                return REAL_FS.readFile(p);
            },
        };
        const result = await read(langchainCodeSource({ roots: [{ label: 'acme', path: dir }], fs: denying }));
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'AUTH_FAILED' });
        expect(result.observations.map((o) => o.discoveredId)).toEqual(['code:acme/support/agent.py#support_executor']);
    });

    it('a symbolic link is not followed, and the location it names is UNREACHABLE', async () => {
        const dir = estate(LANGCHAIN_PYTHON);
        symlinkSync('/etc', join(dir, 'outside'));
        const result = await read(langchainCodeSource({ roots: [{ label: 'acme', path: dir }] }));
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'UNREACHABLE' });
        expect(result.observations).toHaveLength(1);
    });

    it('a file over the size cap: BYTE_CAP', async () => {
        const dir = estate(LANGCHAIN_PYTHON);
        writeFileSync(join(dir, 'huge.py'), `# langchain\n${'x = 1\n'.repeat(Math.ceil(MAX_FILE_BYTES / 6) + 10)}`);
        const result = await read(langchainCodeSource({ roots: [{ label: 'acme', path: dir }] }));
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'BYTE_CAP' });
        expect(result.observations).toHaveLength(1);
    });

    it('the scan\'s deadline: TIME_BOX', async () => {
        const result = await read(langchainCodeSource({ roots: [{ label: 'acme', path: estate(LANGCHAIN_PYTHON) }] }), Date.now() - 1);
        expect(result).toMatchObject({ status: 'INCOMPLETE', reason: 'TIME_BOX' });
    });

    it('a deadline that passes mid-read stops between files, keeping what was read', async () => {
        const dir = estate(LANGCHAIN_PYTHON, LANGGRAPH, LANGCHAIN_JS);
        let tick = 0;
        const scan = await scanLangChainCode([{ label: 'acme', path: dir }], REAL_FS, { deadline: 4, now: () => tick++ });
        expect(scan.problems).toContainEqual({ reason: 'TIME_BOX', at: null });
        expect(scan.agents.length).toBeGreaterThan(0);
        expect(scan.agents.length).toBeLessThan(5);
    });

    it('a tree with no agent in it is a COMPLETE read of nothing — the ingest calls an empty scan EMPTY_SCAN', async () => {
        const result = await read(langchainCodeSource({ roots: [{ label: 'acme', path: estate({ 'README.py': '# nothing here\n' }) }] }));
        expect(result).toEqual({ kind: 'code', status: 'COMPLETE', rows: 1, observations: [] });
    });
});

describe('5. its reports verify under inflect-agent-harness/2, with no change to the contract', () => {
    it('every fixture estate in one signed report: `code` source, tools, references', async () => {
        const dir = estate(LANGCHAIN_PYTHON, LANGCHAIN_JS, LANGGRAPH);
        const { privateKey, publicKey } = generateKeyPairSync('ed25519');
        const { raw, body } = await runScan({
            config: parseScannerConfig({
                estate: 'acme-code',
                scanner: { agentId: 'agt_scanner_code', signingKeyEnv: 'SCANNER_SIGNING_KEY' },
                inflect: { baseUrl: 'https://inflect.example.com', tenantSlug: 'acme', apiKeyEnv: 'INFLECT_INGEST_KEY' },
                schedule: { everyHours: 24 },
                sources: [{ kind: 'code', product: 'langchain', roots: [{ label: 'acme', path: dir }] }],
            }),
            env: { SCANNER_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
            log: jsonLineLog(() => undefined),
            fetchImpl: async () => {
                throw new Error('the code source makes no request');
            },
        });
        const verdict = verifyAndParseHarnessReport(raw, [rawPublicKeyHex(publicKey)]);
        expect(verdict).toMatchObject({ ok: true, complete: true, body: { contract: HARNESS_CONTRACT_V2 } });
        expect(body.population.sources).toEqual([{ kind: 'code', status: 'COMPLETE', rows: 4 }]);
        expect(body.agents.map((a) => a.discoveredId)).toEqual([
            'code:acme/ops/graph.py#oncall_agent',
            'code:acme/ops/graph.py#ops_graph',
            'code:acme/research/agent.ts#researchExecutor',
            'code:acme/research/triage.js#triageAgent',
            'code:acme/support/agent.py#support_executor',
        ]);
        const support = body.agents.find((a) => a.discoveredId.endsWith('#support_executor'))!;
        expect(support).toMatchObject({ discoveredVia: ['code'], registeredAgentId: null, owner: null, verdicts: [] });
        expect(support.tools).toContainEqual({
            server: 'code://acme/support/agent.py#L11',
            name: 'lookup_order',
            manifestHash: null,
            pinned: false,
            readOnlyHint: null,
        });
        expect(support.credentials).toContainEqual({ ref: 'env://SUPPORT_OPENAI_KEY', ageDays: null, expires: null, boundToAgent: false, grant: 'unknown' });
        // The model endpoints each agent calls, in /2's `models[]`, by reference.
        const models = Object.fromEntries(body.agents.map((a) => [a.discoveredId.split('#')[1], a.models]));
        expect(models).toEqual({
            support_executor: [{ endpoint: 'https://llm-gateway.acme.example/v1', model: 'gpt-4o-mini' }],
            researchExecutor: [{ endpoint: 'https://api.anthropic.com', model: 'research-model-v1' }],
            triageAgent: [{ endpoint: 'env://TRIAGE_LLM_URL', model: 'gpt-4o' }],
            ops_graph: [{ endpoint: 'https://api.anthropic.com', model: 'ops-model-v1' }],
            oncall_agent: [{ endpoint: 'https://api.openai.com/v1', model: 'gpt-4.1' }],
        });
        expect(body.unboundCredentials).toEqual([]);
    });

    it('a model whose endpoint cannot be known statically is reported where it is configured, never dropped', async () => {
        const dir = estate({
            'local/agent.py': `from langgraph.prebuilt import create_react_agent

local_agent = create_react_agent("house-model-7", [])
`,
        });
        const result = await read(langchainCodeSource({ roots: [{ label: 'acme', path: dir }] }));
        expect(result.status).toBe('COMPLETE');
        expect(result.observations[0].models).toEqual([{ endpoint: 'code://acme/local/agent.py#L3', model: 'house-model-7' }]);
    });

    it('the configuration takes no credential for the code source, and refuses a relative or escaping root', () => {
        const base = {
            estate: 'acme-code',
            scanner: { agentId: 'agt', signingKeyEnv: 'SCANNER_SIGNING_KEY' },
            inflect: { baseUrl: 'https://inflect.example.com', tenantSlug: 'acme', apiKeyEnv: 'INFLECT_INGEST_KEY' },
            schedule: { everyHours: 24 },
        };
        for (const path of ['relative/repo', '/estate/../etc', '/estate/repo\u0000x']) {
            expect(() =>
                parseScannerConfig({ ...base, sources: [{ kind: 'code', product: 'langchain', roots: [{ label: 'acme', path }] }] }),
            ).toThrow(/sources\.0\.roots\.0\.path/);
        }
        expect(() =>
            parseScannerConfig({ ...base, sources: [{ kind: 'code', product: 'langchain', roots: [{ label: 'a', path: '/x' }], tokenEnv: 'X' }] }),
        ).toThrow(/unrecognized_keys/);
    });
});
