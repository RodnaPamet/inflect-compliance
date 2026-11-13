/**
 * Agents built directly on a model provider's SDK, in the scanner's `code`
 * source: Anthropic, OpenAI and Azure OpenAI, Google Gemini and AWS Bedrock,
 * each in Python and in TypeScript.
 *
 *   1. A model call that is given tools is an agent: its tools, its model and
 *      endpoint, its credential by reference. A model call with no tools, or
 *      an empty tool list, is not one, and records nothing.
 *   2. Tools the reader cannot follow: the agent is reported, and the place is
 *      UNPARSEABLE. Options the reader cannot see: a tool loop is an agent, any
 *      other method is not, and the place is UNPARSEABLE either way.
 *   3. A client that is a parameter, in a file that imports the package for
 *      its types alone, is found; its endpoint is not known, and no
 *      credential is claimed.
 *   4. The same method shapes in a file that does not import the package are
 *      ordinary code: no agent, and no place that failed to resolve. Ordinary
 *      code beside an agent changes nothing.
 *   5. Credentials by reference only, over the whole signed report.
 *   6. `providerSdks: false`: none of it, and the files are not even parsed.
 *   7. The file markers cover every package the recogniser knows.
 *   8. Each method shape, each form a tool takes and each client, one small
 *      case at a time.
 *   9. This scanner's own facts: the file gate, and the payment capability of
 *      `inflect-agent-harness/4`, hold for a provider agent as for any other.
 *
 * A URL is reported as this scanner reports one: with its path, never with
 * its query, and not at all when it looks like a secret.
 */
import { generateKeyPairSync } from 'crypto';
import { rmSync } from 'fs';
import { lstat, readdir, readFile } from 'fs/promises';

import { HARNESS_CONTRACT_V4, looksLikeSecret, verifyAndParseHarnessReport } from '@/lib/agentic/harness-contract';
import { firstSecretShapedMember } from '@/lib/agentic/harness-findings';
import { parseScannerConfig } from '../../../packages/agent-harness-scanner/src/config';
import { jsonLineLog } from '../../../packages/agent-harness-scanner/src/log';
import { rawPublicKeyHex } from '../../../packages/agent-harness-scanner/src/report';
import { runScan } from '../../../packages/agent-harness-scanner/src/scan';
import { FRAMEWORK_MARKERS, markersFor, PROVIDER_SDK_MARKERS, readCodeFiles, type CodeFs } from '../../../packages/agent-harness-scanner/src/sources/code/files';
import { readJavaScript } from '../../../packages/agent-harness-scanner/src/sources/code/javascript';
import { isProviderSdkModule, PROVIDER_SDK_MODULE_EXAMPLES } from '../../../packages/agent-harness-scanner/src/sources/code/provider-sdk';
import { readPython } from '../../../packages/agent-harness-scanner/src/sources/code/python';
import { recognizeAgents, type DetectedAgent } from '../../../packages/agent-harness-scanner/src/sources/code/recognize';
import { langchainCodeSource, observationOf, scanLangChainCode } from '../../../packages/agent-harness-scanner/src/sources/langchain';
import type { SourceContext } from '../../../packages/agent-harness-scanner/src/source';
import { fakeAnthropicKey, fakeOpenAiKey, LANGCHAIN_JS, LANGCHAIN_PYTHON, PLAIN_LITERAL_KEY, writeCodeEstate } from '../../helpers/agent-harness-code-fixtures';
import {
    ANTHROPIC_HANDED_TS,
    ANTHROPIC_PY,
    ANTHROPIC_TS,
    BEDROCK_PY,
    BEDROCK_TS,
    GEMINI_LEGACY_PY,
    GEMINI_LEGACY_TS,
    GEMINI_PY,
    GEMINI_TS,
    lineOf,
    NOT_PROVIDER_SDK,
    OPENAI_PY,
    OPENAI_TS,
    ORDINARY_PY,
    ORDINARY_TS,
    plantedLiterals,
    PROVIDER_SDKS,
    providerSdkLiteralCredentials,
} from '../../helpers/agent-harness-provider-sdk-fixtures';

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

async function scanOf(trees: Readonly<Record<string, string>>[], options: { providerSdks?: boolean } = {}) {
    return scanLangChainCode([{ label: 'acme', path: estate(...trees) }], REAL_FS, { ...LATER, ...options });
}

/** One file's agents by name, and the lines of it that did not resolve. */
async function fileOf(path: string, text: string) {
    const scan = await scanOf([{ [path]: text }]);
    return {
        scan,
        byName: new Map(scan.agents.map((a) => [a.name, a])),
        names: scan.agents.map((a) => a.name),
        unresolved: scan.problems.map((p) => `${p.reason}@${p.at?.line}`),
    };
}

const loc = (path: string, line: number) => `code://acme/${path}#L${line}`;
const toolsOf = (a: DetectedAgent) => a.tools.map((t) => [t.kind, t.name, t.server]);
const modelsOf = (a: DetectedAgent) => a.models.map((m) => [m.model, m.endpoint, m.endpointBasis]);
const credentialsOf = (a: DetectedAgent) => a.credentials.map((c) => [c.ref, c.basis]);
const context = () => ({ asOf: new Date(), deadline: Number.MAX_SAFE_INTEGER, now: Date.now }) as unknown as SourceContext;

/** Sign one report over `trees` with the real scanner. */
async function signedReport(trees: Readonly<Record<string, string>>[], source: { providerSdks?: boolean } = {}) {
    const dir = estate(...trees);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const { raw, body } = await runScan({
        config: parseScannerConfig({
            estate: 'acme-code',
            scanner: { agentId: 'agt_scanner_code', signingKeyEnv: 'SCANNER_SIGNING_KEY' },
            inflect: { baseUrl: 'https://inflect.example.com', tenantSlug: 'acme', apiKeyEnv: 'INFLECT_INGEST_KEY' },
            schedule: { everyHours: 24 },
            sources: [{ kind: 'code', product: 'langchain', roots: [{ label: 'acme', path: dir }], ...source }],
        }),
        env: { SCANNER_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
        log: jsonLineLog(() => undefined),
        fetchImpl: async () => {
            throw new Error('the code source makes no request');
        },
    });
    return { raw, body, dir, publicKeyHex: rawPublicKeyHex(publicKey) };
}

describe('1. a model call that is given tools is an agent', () => {
    describe('Anthropic', () => {
        it('Python: tools written out, a provider tool by its type, an MCP server by its URL, a `@beta_tool` function', async () => {
            const path = 'anthropic/agents.py';
            const { byName } = await fileOf(path, ANTHROPIC_PY);
            const support = byName.get('support_agent')!;
            expect(support).toMatchObject({
                framework: 'anthropic-sdk',
                language: 'python',
                discoveredId: 'code:acme/anthropic/agents.py#support_agent',
                sdkOptions: null,
                subagents: null,
            });
            expect(support.at.line).toBe(lineOf(ANTHROPIC_PY, 'def support_agent') + 1);
            // A tool is located where it is defined, as a tool of the other frameworks is.
            expect(toolsOf(support)).toEqual([
                ['function', 'lookup_order', loc(path, lineOf(ANTHROPIC_PY, '"lookup_order"'))],
                ['function', 'refund_order', loc(path, lineOf(ANTHROPIC_PY, '"refund_order"'))],
                ['builtin', 'web_search_20250305', loc(path, lineOf(ANTHROPIC_PY, 'web_search_20250305'))],
            ]);
            // The client's base URL, as this scanner reports a URL: with its path, without a query.
            expect(modelsOf(support)).toEqual([['claude-sonnet-4-5', 'https://llm-gateway.acme.example/v1/route', 'explicit']]);
            expect(credentialsOf(support)).toEqual([['env://SUPPORT_ANTHROPIC_KEY', 'environment']]);

            const crm = byName.get('crm_agent')!;
            // The URL is written with `?tenant=7`: a query is never part of what is reported.
            expect(toolsOf(crm)).toEqual([['mcp', 'crm:*', 'https://mcp.acme.example/crm/sse']]);
            expect(credentialsOf(crm)).toEqual([['env://CRM_MCP_TOKEN', 'environment'], ['env://SUPPORT_ANTHROPIC_KEY', 'environment']]);

            expect(toolsOf(byName.get('weather_loop')!)).toEqual([['function', 'get_weather', loc(path, lineOf(ANTHROPIC_PY, 'def get_weather'))]]);
        });

        it('TypeScript: the same, with a helper-built tool and the SDK\'s default endpoint and key', async () => {
            const path = 'anthropic/agents.ts';
            const { byName } = await fileOf(path, ANTHROPIC_TS);
            const research = byName.get('researchAgent')!;
            expect(research).toMatchObject({ framework: 'anthropic-sdk', language: 'javascript', discoveredId: 'code:acme/anthropic/agents.ts#researchAgent' });
            expect(toolsOf(research)).toEqual([
                ['function', 'save_note', loc(path, lineOf(ANTHROPIC_TS, '"save_note"'))],
                ['builtin', 'bash_20250124', loc(path, lineOf(ANTHROPIC_TS, 'bash_20250124'))],
            ]);
            expect(modelsOf(research)).toEqual([['claude-sonnet-4-5', 'https://api.anthropic.com', 'provider-default']]);
            expect(credentialsOf(research)).toEqual([['env://RESEARCH_ANTHROPIC_KEY', 'environment']]);

            // An arrow function bound to a name, and a method: each agent is named by the function it is written in.
            expect(toolsOf(byName.get('paperLoop')!)).toEqual([['function', 'search_papers', loc(path, lineOf(ANTHROPIC_TS, 'const searchPapers'))]]);
            const crm = byName.get('Desk.crmAgent')!;
            expect(toolsOf(crm)).toEqual([['mcp', 'crm:*', 'https://mcp.acme.example/crm/sse']]);
            expect(credentialsOf(crm)).toEqual([['env://CRM_MCP_TOKEN', 'environment'], ['env://RESEARCH_ANTHROPIC_KEY', 'environment']]);
        });
    });

    describe('OpenAI and Azure OpenAI', () => {
        it('Python: Chat Completions, the Responses API, the older `functions`, an assistant, and an Azure client', async () => {
            const path = 'openai/agents.py';
            const { byName } = await fileOf(path, OPENAI_PY);
            const quote = byName.get('quote_agent')!;
            expect(quote).toMatchObject({ framework: 'openai-sdk', language: 'python', discoveredId: 'code:acme/openai/agents.py#quote_agent' });
            expect(toolsOf(quote)).toEqual([['function', 'price_quote', loc(path, lineOf(OPENAI_PY, 'price_quote'))]]);
            expect(modelsOf(quote)).toEqual([['gpt-4o', 'https://api.openai.com/v1', 'provider-default']]);
            expect(credentialsOf(quote)).toEqual([['env://SALES_OPENAI_KEY', 'environment']]);

            const research = byName.get('research_agent')!;
            expect(toolsOf(research)).toEqual([
                ['builtin', 'web_search', loc(path, lineOf(OPENAI_PY, '"web_search"'))],
                ['function', 'open_ticket', loc(path, lineOf(OPENAI_PY, 'open_ticket'))],
                ['mcp', 'crm:*', 'https://mcp.acme.example/crm/sse'],
            ]);
            expect(credentialsOf(research)).toEqual([['env://CRM_MCP_TOKEN', 'environment'], ['env://SALES_OPENAI_KEY', 'environment']]);

            expect(toolsOf(byName.get('legacy_agent')!).map(([, name]) => name)).toEqual(['legacy_lookup']);
            // A definition at the top level keeps the name it is bound to.
            expect(toolsOf(byName.get('assistant')!).map(([kind, name]) => [kind, name])).toEqual([['builtin', 'code_interpreter'], ['builtin', 'file_search']]);

            const azure = byName.get('azure_agent')!;
            expect(azure.framework).toBe('openai-sdk');
            expect(modelsOf(azure)).toEqual([['sales-gpt-4o', 'https://acme-sales.openai.azure.com', 'explicit']]);
            expect(credentialsOf(azure)).toEqual([['env://AZURE_SALES_KEY', 'environment']]);
        });

        it('TypeScript: a tool list bound to a name, a helper-built tool, the `runTools` loop, and Azure with a token provider', async () => {
            const path = 'openai/agents.ts';
            const { byName } = await fileOf(path, OPENAI_TS);
            const desk = byName.get('deskAgent')!;
            expect(desk).toMatchObject({ framework: 'openai-sdk', language: 'javascript', discoveredId: 'code:acme/openai/agents.ts#deskAgent' });
            expect(toolsOf(desk)).toEqual([
                ['function', 'lookup_order', loc(path, lineOf(OPENAI_TS, 'lookup_order'))],
                ['function', 'refund_order', loc(path, lineOf(OPENAI_TS, 'refund_order'))],
            ]);
            expect(modelsOf(desk)).toEqual([['gpt-4o', 'https://llm-gateway.acme.example/v1/route', 'explicit']]);
            expect(credentialsOf(desk)).toEqual([['env://DESK_OPENAI_KEY', 'environment']]);

            // `runTools` calls a function given no name by the function's own.
            expect(toolsOf(byName.get('weatherLoop')!).map(([, name]) => name)).toEqual(['getWeather']);

            const research = byName.get('researchAgent')!;
            expect(toolsOf(research).map(([kind, name]) => [kind, name])).toEqual([['builtin', 'web_search_preview'], ['function', 'open_ticket']]);
            expect(modelsOf(research)).toEqual([['desk-gpt-4.1', 'env://DESK_AZURE_ENDPOINT', 'environment']]);
            // A token provider is a function: there is no key in the code, and none in the default variable.
            expect(research.credentials).toEqual([]);
        });
    });

    describe('Google Gemini', () => {
        it('Python: a function given as a tool, declarations, and Gemini\'s own tools', async () => {
            const path = 'gemini/agents.py';
            const { byName } = await fileOf(path, GEMINI_PY);
            const travel = byName.get('travel_agent')!;
            expect(travel).toMatchObject({ framework: 'google-genai-sdk', language: 'python', discoveredId: 'code:acme/gemini/agents.py#travel_agent' });
            expect(toolsOf(travel)).toEqual([
                ['function', 'get_exchange_rate', loc(path, lineOf(GEMINI_PY, 'def get_exchange_rate'))],
                ['function', 'book_flight', loc(path, lineOf(GEMINI_PY, 'book_flight'))],
                ['builtin', 'google_search', loc(path, lineOf(GEMINI_PY, 'google_search='))],
                ['builtin', 'code_execution', loc(path, lineOf(GEMINI_PY, 'code_execution='))],
            ]);
            expect(modelsOf(travel)).toEqual([['gemini-2.5-flash', 'https://generativelanguage.googleapis.com', 'provider-default']]);
            expect(credentialsOf(travel)).toEqual([['env://TRAVEL_GEMINI_KEY', 'environment']]);
            // The asynchronous client, and a configuration written as a dictionary.
            expect(toolsOf(byName.get('chat_agent')!).map(([, name]) => name)).toEqual(['find_hotel']);
            expect(modelsOf(byName.get('chat_agent')!)).toEqual([['gemini-2.5-pro', 'https://generativelanguage.googleapis.com', 'provider-default']]);
        });

        it('TypeScript: declarations, Gemini\'s own tools under one name in either language, and an MCP server', async () => {
            const path = 'gemini/agents.ts';
            const { byName } = await fileOf(path, GEMINI_TS);
            const travel = byName.get('travelAgent')!;
            expect(travel).toMatchObject({ framework: 'google-genai-sdk', language: 'javascript', discoveredId: 'code:acme/gemini/agents.ts#travelAgent' });
            expect(toolsOf(travel).map(([kind, name, server]) => [kind, name, server.startsWith('code://') ? 'code' : server])).toEqual([
                ['function', 'book_flight', 'code'],
                ['function', 'find_hotel', 'code'],
                ['builtin', 'google_search', 'code'],
                ['mcp', 'crm:*', 'https://mcp.acme.example/crm/mcp'],
            ]);
            expect(modelsOf(travel)).toEqual([['gemini-2.5-flash', 'https://generativelanguage.googleapis.com', 'provider-default']]);
            expect(credentialsOf(travel)).toEqual([['env://CRM_MCP_TOKEN', 'environment'], ['env://TRAVEL_GEMINI_KEY', 'environment']]);
            expect(toolsOf(byName.get('chatAgent')!).map(([kind, name]) => [kind, name])).toEqual([['builtin', 'code_execution']]);
        });

        it.each([
            ['Python', 'gemini/legacy.py', GEMINI_LEGACY_PY, 'python'],
            ['TypeScript', 'gemini/legacy.ts', GEMINI_LEGACY_TS, 'javascript'],
        ] as const)('the older package, %s: tools where the model is built, or on one call; a prompt is not options', async (_language, path, text, language) => {
            const { byName, names, unresolved } = await fileOf(path, text);
            // `model.generateContent(prompt)`, with tools on neither: not an agent, and nothing that failed to resolve.
            expect(names).toEqual(['model', 'coder']);
            expect(unresolved).toEqual([]);
            expect(byName.get('model')).toMatchObject({ framework: 'google-genai-sdk', language });
            expect(toolsOf(byName.get('model')!).map(([kind, name]) => [kind, name])).toEqual([['function', 'find_theaters']]);
            expect(modelsOf(byName.get('model')!)).toEqual([['gemini-1.5-pro', 'https://generativelanguage.googleapis.com', 'provider-default']]);
            expect(credentialsOf(byName.get('model')!)).toEqual([['env://LEGACY_GEMINI_KEY', 'environment']]);
            // The model is the one the call is made on.
            expect(toolsOf(byName.get('coder')!).map(([kind, name]) => [kind, name])).toEqual([['builtin', 'code_execution']]);
            expect(modelsOf(byName.get('coder')!)).toEqual([['gemini-1.5-flash', 'https://generativelanguage.googleapis.com', 'provider-default']]);
        });
    });

    describe('AWS Bedrock', () => {
        it('Python: `converse` and `converse_stream`, a tool configuration bound to a name, the region\'s endpoint', async () => {
            const path = 'bedrock/agents.py';
            const { byName } = await fileOf(path, BEDROCK_PY);
            const radio = byName.get('radio_agent')!;
            expect(radio).toMatchObject({ framework: 'bedrock-sdk', language: 'python', discoveredId: 'code:acme/bedrock/agents.py#radio_agent' });
            // A cache point sits in the list and is not a tool.
            expect(toolsOf(radio)).toEqual([['function', 'top_song', loc(path, lineOf(BEDROCK_PY, 'top_song'))]]);
            expect(modelsOf(radio)).toEqual([['anthropic.claude-3-5-sonnet-20240620-v1:0', 'https://bedrock-runtime.eu-west-1.amazonaws.com', 'provider-default']]);
            // AWS's default credential chain names no variable the code could be said to read.
            expect(radio.credentials).toEqual([]);
            expect(toolsOf(byName.get('stream_agent')!).map(([, name]) => name)).toEqual(['get_time']);
            expect(modelsOf(byName.get('stream_agent')!)[0][0]).toBe('amazon.nova-pro-v1:0');
        });

        it('TypeScript: a command, the client that sends it, and keys written inline by reference', async () => {
            const path = 'bedrock/agents.ts';
            const { byName } = await fileOf(path, BEDROCK_TS);
            const radio = byName.get('radioAgent')!;
            expect(radio).toMatchObject({ framework: 'bedrock-sdk', language: 'javascript', discoveredId: 'code:acme/bedrock/agents.ts#radioAgent' });
            expect(toolsOf(radio)).toEqual([['function', 'top_song', loc(path, lineOf(BEDROCK_TS, 'top_song'))]]);
            expect(modelsOf(radio)).toEqual([['anthropic.claude-3-5-sonnet-20240620-v1:0', 'https://bedrock-runtime.us-east-1.amazonaws.com', 'provider-default']]);
            expect(credentialsOf(radio)).toEqual([['env://RADIO_AWS_SECRET', 'environment']]);
            // A command built inside `send(…)`, and one of the provider's own tools.
            expect(toolsOf(byName.get('streamAgent')!).map(([kind, name]) => [kind, name])).toEqual([['function', 'get_time'], ['builtin', 'nova_grounding']]);
        });
    });

    it.each([
        ['anthropic/agents.py', ANTHROPIC_PY, ['summarise', 'no_tools_yet']],
        ['anthropic/agents.ts', ANTHROPIC_TS, ['Desk.summarise', 'Desk.noToolsYet']],
        ['openai/agents.py', OPENAI_PY, ['summarise', 'no_tools_yet']],
        ['openai/agents.ts', OPENAI_TS, ['summarise', 'noToolsYet']],
        ['gemini/agents.py', GEMINI_PY, ['summarise', 'tuned', 'no_tools_yet']],
        ['gemini/agents.ts', GEMINI_TS, ['summarise', 'tuned', 'noToolsYet']],
        ['bedrock/agents.py', BEDROCK_PY, ['summarise', 'no_tools_yet']],
        ['bedrock/agents.ts', BEDROCK_TS, ['summarise', 'noToolsYet']],
    ] as const)('%s: a model call with no tools, or an empty tool list, is not an agent and records nothing', async (path, text, notAgents) => {
        const { names, scan } = await fileOf(path, text);
        expect(names.length).toBeGreaterThan(0);
        for (const name of notAgents) expect(names).not.toContain(name);
        // The fixture really holds those calls: each is a function of that name.
        for (const name of notAgents) expect([name, text.includes(` ${name.split('.').pop()}(`)]).toEqual([name, true]);
        // And no line of theirs is among the places that did not resolve.
        const marked = new Set(['@unresolved-tools', '@unread-options', '@unread-loop'].flatMap((m) => text.split('\n').flatMap((l, i) => (l.includes(m) ? [i + 1] : []))));
        expect(scan.problems.map((p) => p.at?.line).filter((line) => !marked.has(line ?? -1))).toEqual([]);
    });

    it('a model call on a provider\'s SDK raises no ladder verdict: only the Agent SDK\'s options are mapped', async () => {
        const scan = await scanOf([PROVIDER_SDKS]);
        expect(scan.agents.length).toBeGreaterThan(30);
        for (const agent of scan.agents) {
            expect(agent.sdkOptions).toBeNull();
            expect(observationOf(agent).verdicts).toEqual([]);
        }
    });
});

describe('2. what the reader cannot follow is recorded, never guessed', () => {
    it.each([
        ['anthropic/agents.py', ANTHROPIC_PY, 'chosen_elsewhere'],
        ['anthropic/agents.ts', ANTHROPIC_TS, 'Desk.chosenElsewhere'],
        ['openai/agents.py', OPENAI_PY, 'chosen_elsewhere'],
        ['gemini/agents.py', GEMINI_PY, 'chosen_elsewhere'],
        ['gemini/agents.ts', GEMINI_TS, 'chosenElsewhere'],
        ['bedrock/agents.py', BEDROCK_PY, 'chosen_elsewhere'],
        ['bedrock/agents.ts', BEDROCK_TS, 'chosenElsewhere'],
    ] as const)('%s: tools from somewhere the file does not show: an agent, its tools not known, UNPARSEABLE at that line', async (path, text, name) => {
        const { byName, unresolved } = await fileOf(path, text);
        const agent = byName.get(name)!;
        expect(agent.tools).toEqual([]);
        // What was written still resolves.
        expect(agent.models[0].model).not.toBeNull();
        expect(unresolved).toContain(`UNPARSEABLE@${lineOf(text, '@unresolved-tools')}`);
        expect(agent.at.line).toBe(lineOf(text, '@unresolved-tools'));
    });

    it('a list that is part written and part not: the tools written are reported, and the place is still UNPARSEABLE', async () => {
        const { byName, unresolved } = await fileOf('openai/agents.ts', OPENAI_TS);
        expect(byName.get('chosenElsewhere')!.tools.map((t) => t.name)).toEqual(['lookup_order', 'refund_order']);
        expect(unresolved).toContain(`UNPARSEABLE@${lineOf(OPENAI_TS, '@unresolved-tools')}`);
    });

    it.each([
        ['anthropic/agents.py', ANTHROPIC_PY, 'passed_through'],
        ['anthropic/handed.ts', ANTHROPIC_HANDED_TS, 'forward'],
        ['openai/agents.py', OPENAI_PY, 'passed_through'],
        ['openai/agents.ts', OPENAI_TS, 'passedThrough'],
        ['gemini/agents.py', GEMINI_PY, 'passed_through'],
        ['gemini/agents.ts', GEMINI_TS, 'passedThrough'],
        ['bedrock/agents.py', BEDROCK_PY, 'passed_through'],
        ['bedrock/agents.ts', BEDROCK_TS, 'passedThrough'],
    ] as const)('%s: options the reader cannot see: not called an agent, and the place is named for a person to look at', async (path, text, name) => {
        const { names, unresolved } = await fileOf(path, text);
        expect(names).not.toContain(name);
        expect(unresolved).toContain(`UNPARSEABLE@${lineOf(text, '@unread-options')}`);
    });

    it.each([
        ['anthropic/agents.py', ANTHROPIC_PY, 'loop_passed_through', 'https://llm-gateway.acme.example/v1/route'],
        ['anthropic/handed.ts', ANTHROPIC_HANDED_TS, 'runLocked', null],
        ['openai/agents.ts', OPENAI_TS, 'loopPassedThrough', 'https://llm-gateway.acme.example/v1/route'],
    ] as const)('%s: a tool loop whose options the reader cannot see is an agent all the same, its tools and model not known', async (path, text, name, endpoint) => {
        const { byName, unresolved } = await fileOf(path, text);
        const agent = byName.get(name)!;
        expect(agent.tools).toEqual([]);
        expect(agent.models.map((m) => [m.model, m.endpoint])).toEqual([[null, endpoint]]);
        expect(unresolved).toContain(`UNPARSEABLE@${lineOf(text, '@unread-loop')}`);
    });

    it('exactly the marked lines are UNPARSEABLE, over every provider and both languages', async () => {
        const scan = await scanOf([PROVIDER_SDKS]);
        const expected = Object.entries(PROVIDER_SDKS).flatMap(([path, text]) =>
            text.split('\n').flatMap((line, i) => (/@(unresolved-tools|unread-options|unread-loop)\b/.test(line) ? [`${path}#${i + 1}`] : [])),
        );
        expect(scan.problems.map((p) => `${p.at?.path}#${p.at?.line}`).sort()).toEqual(expected.sort());
        expect(scan.problems.every((p) => p.reason === 'UNPARSEABLE')).toBe(true);
    });

    it('the source reports INCOMPLETE UNPARSEABLE, and still reports every agent', async () => {
        const result = await langchainCodeSource({ roots: [{ label: 'acme', path: estate(PROVIDER_SDKS) }] }).read(context());
        expect(result).toMatchObject({ kind: 'code', status: 'INCOMPLETE', reason: 'UNPARSEABLE', rows: Object.keys(PROVIDER_SDKS).length });
        expect(result.observations.map((o) => o.discoveredId)).toContain('code:acme/anthropic/handed.ts#runLocked');
        expect(result.observations.length).toBeGreaterThan(30);
    });

    it('a tool list that is added to elsewhere in the file is not all in its binding: reported, and UNPARSEABLE', async () => {
        const text = [
            'import anthropic',
            'client = anthropic.Anthropic()',
            'TOOLS = [{"name": "lookup_order", "input_schema": {}}]',
            'TOOLS.append(load_tool())',
            'def agent(messages):',
            '    return client.messages.create(model="claude-sonnet-4-5", max_tokens=1, tools=TOOLS, messages=messages)',
        ].join('\n');
        const { byName, unresolved } = await fileOf('grown.py', text);
        expect(byName.get('agent')!.tools.map((t) => t.name)).toEqual(['lookup_order']);
        expect(unresolved).toEqual(['UNPARSEABLE@6']);
    });

    it('a client whose options the reader cannot see claims no default endpoint and no default key', async () => {
        const text = [
            'import OpenAI from "openai";',
            'const hidden = new OpenAI(settings);',
            'const spread = new OpenAI({ ...settings, baseURL: "https://llm-gateway.acme.example/v1" });',
            'const tools = [{ type: "function", function: { name: "lookup_order" } }];',
            'export const viaHidden = () => hidden.chat.completions.create({ model: "gpt-4o", messages: [], tools });',
            'export const viaSpread = () => spread.chat.completions.create({ model: "gpt-4o", messages: [], tools });',
        ].join('\n');
        const { byName, unresolved } = await fileOf('clients.ts', text);
        expect(modelsOf(byName.get('viaHidden')!)).toEqual([['gpt-4o', null, 'unknown']]);
        expect(byName.get('viaHidden')!.credentials).toEqual([]);
        // What is written is still reported.
        expect(modelsOf(byName.get('viaSpread')!)).toEqual([['gpt-4o', 'https://llm-gateway.acme.example/v1', 'explicit']]);
        expect(byName.get('viaSpread')!.credentials).toEqual([]);
        expect(unresolved).toEqual(['UNPARSEABLE@2', 'UNPARSEABLE@3']);
    });

    it('a regional service with no region written, and a Gemini client that may be Vertex AI: the endpoint is not known', async () => {
        const text = [
            'import boto3',
            'from google import genai',
            'bedrock = boto3.client("bedrock-runtime")',
            'vertex = genai.Client(vertexai=True, project="p", location="europe-west4")',
            'def nova(messages):',
            '    return bedrock.converse(modelId="amazon.nova-pro-v1:0", messages=messages, toolConfig={"tools": [{"toolSpec": {"name": "get_time"}}]})',
            'def gemini(q):',
            '    return vertex.models.generate_content(model="gemini-2.5-flash", contents=q, config={"tools": [{"google_search": {}}]})',
        ].join('\n');
        const { byName, unresolved } = await fileOf('regional.py', text);
        expect(modelsOf(byName.get('nova')!)).toEqual([['amazon.nova-pro-v1:0', null, 'unknown']]);
        expect(modelsOf(byName.get('gemini')!)).toEqual([['gemini-2.5-flash', null, 'unknown']]);
        expect(byName.get('gemini')!.credentials).toEqual([]);
        // Not knowing is not a failure to read: the report says where the client is built.
        expect(unresolved).toEqual([]);
        expect(observationOf(byName.get('nova')!).models).toEqual([{ endpoint: loc('regional.py', 3), model: 'amazon.nova-pro-v1:0' }]);
    });

    it('Anthropic\'s clients for Bedrock and Vertex AI: the region\'s endpoint, where the region is written', async () => {
        const text = [
            'from anthropic import AnthropicBedrock, AnthropicVertex',
            'bedrock = AnthropicBedrock(aws_region="eu-central-1")',
            'vertex = AnthropicVertex(region="europe-west1", project_id="p")',
            'TOOLS = [{"name": "lookup_order", "input_schema": {}}]',
            'def on_bedrock(messages):',
            '    return bedrock.messages.create(model="anthropic.claude-sonnet-4-5-v1:0", max_tokens=1, tools=TOOLS, messages=messages)',
            'def on_vertex(messages):',
            '    return vertex.messages.create(model="claude-sonnet-4-5", max_tokens=1, tools=TOOLS, messages=messages)',
        ].join('\n');
        const { byName, unresolved } = await fileOf('clouds.py', text);
        expect(byName.get('on_bedrock')!.framework).toBe('anthropic-sdk');
        expect(modelsOf(byName.get('on_bedrock')!)).toEqual([['anthropic.claude-sonnet-4-5-v1:0', 'https://bedrock-runtime.eu-central-1.amazonaws.com', 'provider-default']]);
        expect(modelsOf(byName.get('on_vertex')!)).toEqual([['claude-sonnet-4-5', 'https://europe-west1-aiplatform.googleapis.com', 'provider-default']]);
        expect(unresolved).toEqual([]);
    });
});

describe('3. a client that is handed in', () => {
    it.each([
        ['anthropic/handed.py', 'anthropic-sdk'],
        ['anthropic/handed.ts', 'anthropic-sdk'],
        ['openai/handed.py', 'openai-sdk'],
        ['openai/handed.ts', 'openai-sdk'],
        ['gemini/handed.py', 'google-genai-sdk'],
        ['gemini/handed.ts', 'google-genai-sdk'],
        ['bedrock/handed.py', 'bedrock-sdk'],
        ['bedrock/handed.ts', 'bedrock-sdk'],
    ] as const)('%s: found by the import and the method; its endpoint is not known and no credential is claimed', async (path, framework) => {
        const text = PROVIDER_SDKS[path];
        const { byName } = await fileOf(path, text);
        const agent = byName.get('triage')!;
        expect(agent).toMatchObject({ framework, discoveredId: `code:acme/${path}#triage` });
        expect(agent.tools).toHaveLength(1);
        expect(agent.models).toHaveLength(1);
        expect(agent.models[0]).toMatchObject({ endpoint: null, endpointBasis: 'unknown' });
        expect(agent.models[0].model).not.toBeNull();
        expect(agent.credentials).toEqual([]);
        // In the report: where the call is written stands in for the endpoint.
        expect(observationOf(agent).models).toEqual([{ endpoint: loc(path, agent.at.line), model: agent.models[0].model }]);
    });

    it('TypeScript: the import is for the types alone', () => {
        for (const path of ['anthropic/handed.ts', 'openai/handed.ts', 'gemini/handed.ts', 'bedrock/handed.ts']) {
            expect(PROVIDER_SDKS[path]).toMatch(/^import type /);
            expect(PROVIDER_SDKS[path]).not.toMatch(/\bnew [A-Z]/);
        }
    });
});

describe('4. ordinary code is not a model call', () => {
    it('the same method shapes in files that do not import the package: no agent, and nothing that failed to resolve', async () => {
        const result = await langchainCodeSource({ roots: [{ label: 'acme', path: estate(NOT_PROVIDER_SDK) }] }).read(context());
        expect(result).toEqual({ kind: 'code', status: 'COMPLETE', rows: Object.keys(NOT_PROVIDER_SDK).length, observations: [] });
    });

    it('those files ARE parsed: each names a package, and holds the shapes', () => {
        for (const [path, text] of Object.entries(NOT_PROVIDER_SDK)) {
            expect(markersFor(true).some((m) => text.includes(m))).toBe(true);
            const facts = path.endsWith('.py') ? readPython(text) : readJavaScript(path, text);
            expect(facts.calls.some(({ call }) => call.fn.k === 'attr' && ['create', 'converse', 'generate_content', 'generateContent'].includes(call.fn.name))).toBe(true);
            expect([...facts.modules].some(isProviderSdkModule)).toBe(path === 'gateway/mixed.py');
        }
    });

    it('with the import added, the same file is model calls: the import is what decides', async () => {
        const text = NOT_PROVIDER_SDK['gateway/calls.py'].replace('from gateway import client, tools', 'from gateway import client, tools; import anthropic, openai, boto3; from google import genai');
        const { names, unresolved } = await fileOf('gateway/calls.py', text);
        // Tools written out, and a tool loop; tools from another module; a tool configuration handed in.
        const written = lineOf(text, 'tools=[{"name": "x"}]');
        expect(names).toEqual([`claude@L${written}`, `claude@L${written + 1}`, 'gpt', 'nova']);
        // And every call whose options the reader cannot see is now a place for a person to look at.
        expect(unresolved).toEqual([written + 1, written + 2, lineOf(text, 'tools=tools'), lineOf(text, '**body'), lineOf(text, 'config=config'), lineOf(text, 'toolConfig=tool_config')].map((line) => `UNPARSEABLE@${line}`));
    });

    it.each([
        ['Python', /\.py$/, ORDINARY_PY],
        ['TypeScript', /\.ts$/, ORDINARY_TS],
    ] as const)('ordinary %s beside an agent changes neither the agents nor what was not resolved', async (_language, sourceFile, ordinary) => {
        const withOrdinary = Object.fromEntries(Object.entries(PROVIDER_SDKS).map(([path, text]) => [path, sourceFile.test(path) ? `${text}${ordinary}` : text]));
        const plain = await scanOf([PROVIDER_SDKS]);
        const mixed = await scanOf([withOrdinary]);
        const shape = (scan: typeof plain) => ({
            agents: scan.agents.map((a) => ({ id: a.discoveredId, tools: a.tools.map((t) => t.name), models: a.models.map((m) => m.model) })),
            problems: scan.problems.map((p) => `${p.reason} ${p.at?.path}#${p.at?.line}`),
        });
        expect(plain.agents.length).toBeGreaterThan(30);
        expect(shape(mixed)).toEqual(shape(plain));
    });

    it('agents of the frameworks are what they were: a LangChain estate reads the same with the recognition on and off', async () => {
        const on = await scanOf([LANGCHAIN_PYTHON, LANGCHAIN_JS]);
        const off = await scanOf([LANGCHAIN_PYTHON, LANGCHAIN_JS], { providerSdks: false });
        expect(on.agents.length).toBeGreaterThan(0);
        expect(on).toEqual(off);
    });
});

describe('5. credentials by reference only', () => {
    it('a key written into the code is reported as where it is written', async () => {
        const tree = providerSdkLiteralCredentials();
        const scan = await scanOf([tree]);
        const byName = new Map(scan.agents.map((a) => [a.name, a]));
        const py = tree['hardcoded-provider/agents.py'];
        const ts = tree['hardcoded-provider/agents.ts'];
        expect(credentialsOf(byName.get('hardcoded_claude')!)).toEqual([
            [loc('hardcoded-provider/agents.py', lineOf(py, 'authorization_token')), 'literal'],
            [loc('hardcoded-provider/agents.py', lineOf(py, 'anthropic.Anthropic(')), 'literal'],
        ]);
        expect(credentialsOf(byName.get('hardcoded_gpt')!)).toEqual([
            [loc('hardcoded-provider/agents.py', lineOf(py, 'server_label')), 'literal'],
            [loc('hardcoded-provider/agents.py', lineOf(py, 'OpenAI(api_key')), 'literal'],
        ]);
        // The older Gemini client takes its key by position; the AWS client takes them one level down.
        expect(credentialsOf(byName.get('hardcodedGemini')!)).toEqual([[loc('hardcoded-provider/agents.ts', lineOf(ts, 'new GoogleGenerativeAI(')), 'literal']]);
        expect(credentialsOf(byName.get('hardcodedNova')!)).toEqual([[loc('hardcoded-provider/agents.ts', lineOf(ts, 'secretAccessKey')), 'literal']]);
        expect(credentialsOf(byName.get('hardcodedGpt')!)).toEqual([[loc('hardcoded-provider/agents.ts', lineOf(ts, 'new OpenAI(')), 'literal']]);
        // A key where a model's name goes is not repeated as a model's name; one where a tool's name goes is not a tool.
        expect(byName.get('hardcoded_claude')!.models.map((m) => m.model)).toEqual([null]);
        expect(byName.get('hardcoded_claude')!.tools.map((t) => t.name)).toEqual(['crm:*']);
        // A key in a URL's query is never part of what is reported …
        expect(byName.get('hardcoded_claude')!.tools[0].server).toBe('https://mcp.acme.example/crm/sse');
        expect(byName.get('hardcoded_gpt')!.tools[0].server).toBe('https://mcp.acme.example/crm/mcp');
        // … and a URL with a secret-shaped path is refused whole: the endpoint is not known, and the place is named.
        expect(byName.get('hardcodedGpt')!.models[0]).toMatchObject({ endpoint: null, endpointBasis: 'unknown' });
        expect(scan.problems).toContainEqual({ reason: 'UNPARSEABLE', at: { label: 'acme', path: 'hardcoded-provider/agents.ts', line: lineOf(ts, 'new OpenAI(') } });
    });

    it('no literal is in any observation', async () => {
        const scan = await scanOf([PROVIDER_SDKS, providerSdkLiteralCredentials()]);
        expect(scan.agents.length).toBeGreaterThan(30);
        const observed = JSON.stringify(scan.agents.map(observationOf).map((o) => ({ ...o, tools: (o.tools ?? []).map((t) => t.tool) })));
        for (const literal of plantedLiterals()) expect(observed).not.toContain(literal);
        expect(observed).not.toContain('tenant=7');
    });

    it('no literal reaches the signed report, no member of it is secret-shaped, and it verifies', async () => {
        expect(looksLikeSecret(fakeAnthropicKey())).toBe(true);
        expect(looksLikeSecret(fakeOpenAiKey())).toBe(true);
        const { raw, body, dir, publicKeyHex } = await signedReport([PROVIDER_SDKS, NOT_PROVIDER_SDK, providerSdkLiteralCredentials()]);
        for (const literal of plantedLiterals()) expect(raw).not.toContain(literal);
        expect(raw).not.toContain(PLAIN_LITERAL_KEY);
        expect(raw).not.toContain(dir);
        // A URL's query is never reported.
        expect(raw).not.toContain('tenant=7');
        expect(raw).not.toContain('?key=');
        expect(firstSecretShapedMember(body)).toBeNull();
        expect(verifyAndParseHarnessReport(raw, [publicKeyHex])).toMatchObject({ ok: true, complete: false });
    });

    it('every fixture report, each estate on its own, carries no secret-shaped member', async () => {
        for (const tree of [PROVIDER_SDKS, NOT_PROVIDER_SDK, providerSdkLiteralCredentials()]) {
            const { body } = await signedReport([tree]);
            expect(firstSecretShapedMember(body)).toBeNull();
        }
    });
});

describe('6. its reports verify, and the switch turns all of it off', () => {
    it('one signed report over every provider: each agent, with its tools, model endpoint and credential references', async () => {
        const { raw, body, publicKeyHex } = await signedReport([PROVIDER_SDKS]);
        expect(verifyAndParseHarnessReport(raw, [publicKeyHex])).toMatchObject({ ok: true, complete: false, body: { contract: HARNESS_CONTRACT_V4 } });
        expect(body.population.sources).toEqual([{ kind: 'code', status: 'INCOMPLETE', reason: 'UNPARSEABLE', rows: Object.keys(PROVIDER_SDKS).length }]);
        const ids = body.agents.map((a) => a.discoveredId);
        expect(ids).toEqual([...ids].sort());
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toEqual(expect.arrayContaining([
            'code:acme/anthropic/agents.py#support_agent',
            'code:acme/anthropic/agents.ts#Desk.crmAgent',
            'code:acme/anthropic/handed.ts#runLocked',
            'code:acme/openai/agents.py#azure_agent',
            'code:acme/openai/agents.ts#weatherLoop',
            'code:acme/gemini/agents.py#travel_agent',
            'code:acme/gemini/legacy.ts#model',
            'code:acme/bedrock/agents.py#stream_agent',
            'code:acme/bedrock/agents.ts#radioAgent',
        ]));
        const support = body.agents.find((a) => a.discoveredId === 'code:acme/anthropic/agents.py#support_agent')!;
        // `/4`'s member is stated for a provider agent as for any other: `[]`, no payment client in its file.
        expect(support).toMatchObject({ discoveredVia: ['code'], registeredAgentId: null, owner: null, verdicts: [], paymentCapabilities: [] });
        expect(support.tools).toContainEqual({
            server: loc('anthropic/agents.py', lineOf(ANTHROPIC_PY, '"lookup_order"')),
            name: 'lookup_order',
            manifestHash: null,
            pinned: false,
            readOnlyHint: null,
        });
        expect(support.models).toEqual([{ endpoint: 'https://llm-gateway.acme.example/v1/route', model: 'claude-sonnet-4-5' }]);
        expect(support.credentials).toEqual([{ ref: 'env://SUPPORT_ANTHROPIC_KEY', ageDays: null, expires: null, boundToAgent: false, grant: 'unknown' }]);
    });

    it('`providerSdks: false`: no agent, nothing unresolved, and the files are not parsed at all', async () => {
        const dir = estate(PROVIDER_SDKS, providerSdkLiteralCredentials(), { 'broken/anthropic.py': 'import anthropic\nx = (\n' });
        // A file that names a provider's package and does not parse: UNPARSEABLE while the recognition is on …
        const on = await scanLangChainCode([{ label: 'acme', path: dir }], REAL_FS, LATER);
        expect(on.problems).toContainEqual({ reason: 'UNPARSEABLE', at: expect.objectContaining({ path: 'broken/anthropic.py' }) });
        // … and never handed to a reader while it is off: it is counted, and it is not a file that failed to parse.
        const off = await scanLangChainCode([{ label: 'acme', path: dir }], REAL_FS, { ...LATER, providerSdks: false });
        expect(off).toEqual({ rows: on.rows, agents: [], problems: [] });

        const result = await langchainCodeSource({ roots: [{ label: 'acme', path: dir }], providerSdks: false }).read(context());
        expect(result).toEqual({ kind: 'code', status: 'COMPLETE', rows: on.rows, observations: [] });
    });

    it('the switch is the configuration\'s: absent it is on, `false` turns it off, and nothing else is accepted', async () => {
        const off = await signedReport([PROVIDER_SDKS], { providerSdks: false });
        expect(off.body.agents).toEqual([]);
        expect(off.body.population.sources).toEqual([{ kind: 'code', status: 'COMPLETE', rows: Object.keys(PROVIDER_SDKS).length }]);
        expect(verifyAndParseHarnessReport(off.raw, [off.publicKeyHex])).toMatchObject({ ok: true, complete: true });
        const on = await signedReport([PROVIDER_SDKS], { providerSdks: true });
        expect(on.body.agents.length).toBeGreaterThan(30);

        const config = (source: Record<string, unknown>) => ({
            estate: 'acme-code',
            scanner: { agentId: 'agt_scanner_code', signingKeyEnv: 'SCANNER_SIGNING_KEY' },
            inflect: { baseUrl: 'https://inflect.example.com', tenantSlug: 'acme', apiKeyEnv: 'INFLECT_INGEST_KEY' },
            schedule: { everyHours: 24 },
            sources: [{ kind: 'code', product: 'langchain', roots: [{ label: 'acme', path: '/srv/code' }], ...source }],
        });
        expect(parseScannerConfig(config({})).sources[0]).toEqual({ kind: 'code', product: 'langchain', roots: [{ label: 'acme', path: '/srv/code' }] });
        expect(parseScannerConfig(config({ providerSdks: false })).sources[0]).toMatchObject({ providerSdks: false });
        expect(() => parseScannerConfig(config({ providerSdks: 'no' }))).toThrow();
        expect(() => parseScannerConfig(config({ providerSDKs: false }))).toThrow();
    });

    it('the recogniser itself: off, a file\'s facts yield what they did before', () => {
        const facts = readPython(ANTHROPIC_PY);
        expect(recognizeAgents(facts, { label: 'acme', path: 'a.py' }).agents.length).toBeGreaterThan(0);
        expect(recognizeAgents(facts, { label: 'acme', path: 'a.py' }, { providerSdks: false })).toEqual({ agents: [], unresolved: [] });
    });
});

describe('7. the file gate and the recogniser agree on the packages', () => {
    it('every package the recogniser knows contains a marker the file gate looks for', () => {
        for (const name of PROVIDER_SDK_MODULE_EXAMPLES) {
            expect(isProviderSdkModule(name)).toBe(true);
            expect([name, PROVIDER_SDK_MARKERS.filter((m) => name.includes(m)).length > 0]).toEqual([name, true]);
        }
    });

    it('the markers are added to the frameworks\', and only while the recognition is on', () => {
        expect(markersFor(false)).toEqual(FRAMEWORK_MARKERS);
        expect(markersFor(true)).toEqual([...FRAMEWORK_MARKERS, ...PROVIDER_SDK_MARKERS]);
        expect(PROVIDER_SDK_MARKERS).toEqual(['anthropic', 'openai', 'genai', 'generativeai', 'generative-ai', 'bedrock', 'boto3', 'botocore']);
    });

    it('a framework\'s own package that names a provider is not that provider\'s SDK', () => {
        for (const name of ['@anthropic-ai/claude-agent-sdk', 'claude_agent_sdk', '@langchain/openai', 'langchain_openai', '@langchain/anthropic', 'langchain_aws', 'google', 'openai_agents', 'anthropics']) {
            expect([name, isProviderSdkModule(name)]).toEqual([name, false]);
        }
    });

    it('every fixture file imports what its directory says, under the name the recogniser knows it by', () => {
        for (const [path, text] of Object.entries(PROVIDER_SDKS)) {
            const facts = path.endsWith('.py') ? readPython(text) : readJavaScript(path, text);
            expect([path, [...facts.modules].some(isProviderSdkModule)]).toEqual([path, true]);
        }
    });
});

/**
 * One file's agents as compact text, so a table of small cases reads like the
 * code it is about: `name: tools | models | credentials`, a tool as
 * `<kind's first letter>:<name>@<server>`, with a `code://` locator cut to its
 * line.
 */
function summary(path: string, lines: readonly string[]) {
    const facts = path.endsWith('.py') ? readPython(lines.join('\n')) : readJavaScript(path, lines.join('\n'));
    const found = recognizeAgents(facts, { label: 'acme', path });
    const short = (ref: string) => ref.replace(/^code:\/\/acme\/[^#]*#/, '');
    return {
        agents: found.agents.map((a) => [
            `${a.name}: ${a.tools.map((t) => `${t.kind[0]}:${t.name}@${short(t.server)}`).join(',')}`,
            a.models.map((m) => `${m.model}@${m.endpoint}`).join(','),
            a.credentials.map((c) => short(c.ref)).join(','),
        ].join(' | ')),
        unresolved: found.unresolved.map((u) => u.line).sort((a, b) => a - b),
    };
}

describe('8. each method shape, each form a tool takes, and each client', () => {
    it('OpenAI in TypeScript: the older `beta` path, `stream`, an assistant\'s update, custom and namespace tools, a hosted connector', () => {
        expect(summary('a.ts', [
            /*  1 */ 'import OpenAI from "openai";',
            /*  2 */ 'const c = new OpenAI();',
            /*  3 */ 'const T = [{ type: "function", function: { name: "f" } }];',
            /*  4 */ 'export const a = () => c.beta.chat.completions.parse({ model: "gpt-4o", messages: [], tools: T });',
            /*  5 */ 'export const b = () => c.responses.stream({ model: "gpt-4.1", input: "x", tools: [{ type: "custom", name: "grammar" }, { type: "namespace", name: "crm", tools: [] }] });',
            /*  6 */ 'export const d = () => c.beta.assistants.update("asst_1", { model: "gpt-4o", tools: [{ type: "file_search" }] });',
            /*  7 */ 'export const e = () => c.beta.assistants.update("asst_1", { name: "renamed" });',
            /*  8 */ 'export const f = () => c.chat.completions.create({ model: "gpt-4o", messages: [], tools: [{ type: "custom", custom: { name: "raw" } }, { function: { name: "untyped" } }] });',
            /*  9 */ 'export const g = () => c.responses.create({ model: "gpt-4.1", input: "x", tools: [{ type: "mcp", server_label: "drive", connector_id: "connector_googledrive", authorization: process.env.DRIVE_TOKEN }, { type: "mcp", server_label: "bad", server_url: url }] });',
            /* 10 */ 'export const h = (...args) => c.chat.completions.create(...args);',
            /* 11 */ 'export const i = () => c.beta.threads.messages.create("thread_1", { role: "user", content: "x" });',
        ])).toEqual({
            agents: [
                'a: f:f@L3 | gpt-4o@https://api.openai.com/v1 | env://OPENAI_API_KEY',
                'b: f:grammar@L5,t:crm@L5 | gpt-4.1@https://api.openai.com/v1 | env://OPENAI_API_KEY',
                'd: b:file_search@L6 | gpt-4o@https://api.openai.com/v1 | env://OPENAI_API_KEY',
                // A tool with no `type` is not one this reader can name: the others are still reported.
                'f: f:raw@L8 | gpt-4o@https://api.openai.com/v1 | env://OPENAI_API_KEY',
                // A connector the provider hosts has no URL: it is named where the code configures it.
                'g: m:drive:*@L9 | gpt-4.1@https://api.openai.com/v1 | env://DRIVE_TOKEN,env://OPENAI_API_KEY',
            ],
            unresolved: [8, 9, 10],
        });
    });

    it('OpenAI in Python: a raw-response wrapper, a Pydantic tool, the SDK\'s "not given", `None`, and two calls in one function', () => {
        expect(summary('a.py', [
            /*  1 */ 'import openai',
            /*  2 */ 'from openai import NOT_GIVEN, OpenAI',
            /*  3 */ 'from pydantic import BaseModel',
            /*  4 */ 'c = OpenAI()',
            /*  5 */ 'class GetWeather(BaseModel): pass',
            /*  6 */ 'def a(m):',
            /*  7 */ '    return c.chat.completions.with_raw_response.create(model="gpt-4o", messages=m, tools=[openai.pydantic_function_tool(GetWeather), openai.pydantic_function_tool(GetWeather, name="rain"), openai.pydantic_function_tool(build())])',
            /*  8 */ 'def b(m):',
            /*  9 */ '    return c.chat.completions.create(model="gpt-4o", messages=m, tools=NOT_GIVEN)',
            /* 10 */ 'def d(m):',
            /* 11 */ '    return c.chat.completions.create(model="gpt-4o", messages=m, tools=None, functions=None)',
            /* 12 */ 'def e(m, use):',
            /* 13 */ '    return c.chat.completions.create(model="gpt-4o", messages=m, tools=TOOLS if use else NOT_GIVEN)',
            /* 14 */ 'def f(m):',
            /* 15 */ '    first = c.chat.completions.create(model="gpt-4o", messages=m, tools=[{"type": "function", "function": {"name": "f"}}])',
            /* 16 */ '    return c.chat.completions.create(model="gpt-4o", messages=m, tools=[{"type": "function", "function": {"name": "f"}}])',
        ])).toEqual({
            agents: [
                'a: f:GetWeather@L7,f:rain@L7 | gpt-4o@https://api.openai.com/v1 | env://OPENAI_API_KEY',
                // Which branch runs is not knowable: tools are given, and they are not known.
                'e:  | gpt-4o@https://api.openai.com/v1 | env://OPENAI_API_KEY',
                // One call, one agent: two in one function are told apart by their lines.
                'f@L15: f:f@L15 | gpt-4o@https://api.openai.com/v1 | env://OPENAI_API_KEY',
                'f@L16: f:f@L16 | gpt-4o@https://api.openai.com/v1 | env://OPENAI_API_KEY',
            ],
            unresolved: [7, 13],
        });
    });

    it('Anthropic in TypeScript: a required package, a namespace of helpers, and each tool that does not resolve named at its line', () => {
        expect(summary('a.ts', [
            /*  1 */ 'const Anthropic = require("@anthropic-ai/sdk");',
            /*  2 */ 'import * as helpers from "@anthropic-ai/sdk/helpers/beta/json-schema";',
            /*  3 */ 'const c = new Anthropic({ authToken: process.env.ANT_TOKEN, baseURL: process.env.ANT_URL });',
            /*  4 */ 'const base = { name: "based", input_schema: {} };',
            /*  5 */ 'export const a = () => c.beta.messages.parse({ model: "claude-sonnet-4-5", max_tokens: 1, messages: [], tools: [',
            /*  6 */ '  helpers.betaTool({ name: "json_tool", inputSchema: {}, run }),',
            /*  7 */ '  { type: "custom", name: "typed" },',
            /*  8 */ '  { type: kind, name: "dynamic" },',
            /*  9 */ '  { type: "mcp_toolset", mcp_server_name: "nowhere" },',
            /* 10 */ '  { ...base, cache_control: { type: "ephemeral" } },',
            /* 11 */ '  base,',
            /* 12 */ '  makeTool(),',
            /* 13 */ '  { name: `tool_${i}`, input_schema: {} },',
            /* 14 */ '] });',
            /* 15 */ 'export const b = () => c.beta.threads.messages.create({ tools: [{ name: "x" }] });',
        ])).toEqual({
            agents: ['a: f:json_tool@L6,f:typed@L7,f:based@L4 | claude-sonnet-4-5@env://ANT_URL | env://ANT_TOKEN'],
            unresolved: [8, 9, 10, 12, 13],
        });
    });

    it('Anthropic in Python: a decorator that names its tool, the cloud clients, and options the reader cannot see whole', () => {
        expect(summary('a.py', [
            /*  1 */ 'import anthropic',
            /*  2 */ 'from anthropic import AnthropicFoundry, AnthropicVertex, AsyncAnthropic, beta_async_tool',
            /*  3 */ 'c = AsyncAnthropic(**settings)',
            /*  4 */ 'f = AnthropicFoundry(api_key=key, resource="acme")',
            /*  5 */ 'us = AnthropicVertex(region="us", access_token=tok())',
            /*  6 */ 'g = AnthropicVertex(region="global")',
            /*  7 */ 'nr = AnthropicVertex()',
            /*  8 */ '@beta_async_tool(name="rain_check")',
            /*  9 */ 'async def get_rain(city): return city',
            /* 10 */ '@unrelated',
            /* 11 */ 'def not_a_tool(x): return x',
            /* 12 */ 'T = [get_rain]',
            /* 13 */ 'async def a(m):',
            /* 14 */ '    return await c.messages.create(model="claude-sonnet-4-5", max_tokens=1, messages=m, tools=T + [not_a_tool])',
            /* 15 */ 'def b(m): return f.messages.create(model="claude-sonnet-4-5", max_tokens=1, messages=m, tools=T)',
            /* 16 */ 'def d(m): return us.messages.create(model="claude-sonnet-4-5", max_tokens=1, messages=m, tools=T)',
            /* 17 */ 'def e(m): return g.messages.create(model="claude-sonnet-4-5", max_tokens=1, messages=m, tools=T)',
            /* 18 */ 'def h(m): return nr.messages.create(model=MODEL, max_tokens=1, messages=m, tools=T)',
            /* 19 */ 'def i(m): return c.messages.create(model="claude-sonnet-4-5", max_tokens=1, messages=m, tools=T, **extra)',
            /* 20 */ 'def j(m): return c.messages.create(model="claude-sonnet-4-5", max_tokens=1, messages=m, tools=[], **extra)',
        ])).toEqual({
            agents: [
                // `**settings`: no default endpoint and no default key is claimed for a client whose options are hidden.
                'a: f:rain_check@L9 | claude-sonnet-4-5@null | ',
                // A provider with no fixed endpoint: known only where the code writes one.
                'b: f:rain_check@L9 | claude-sonnet-4-5@null | ',
                'd: f:rain_check@L9 | claude-sonnet-4-5@https://aiplatform.us.rep.googleapis.com | ',
                'e: f:rain_check@L9 | claude-sonnet-4-5@https://aiplatform.googleapis.com | ',
                // A model named by something that is not a literal is not known; it is not a failure to read.
                'h: f:rain_check@L9 | null@null | ',
                'i: f:rain_check@L9 | claude-sonnet-4-5@null | ',
            ],
            // 3: the client's `**settings`. 4, 5: a key from a name and from a call. 14: a function that is no tool.
            // 19: `**extra` beside tools. 20: an empty list `**extra` could replace — named, and not called an agent.
            unresolved: [3, 4, 5, 14, 19, 20],
        });
    });

    it('Gemini in TypeScript: a live session, a base URL one level down, the older package\'s per-model options, and `null`', () => {
        expect(summary('a.ts', [
            /*  1 */ 'import { GoogleGenAI, mcpToTool } from "@google/genai";',
            /*  2 */ 'import { GoogleGenerativeAI } from "@google/generative-ai";',
            /*  3 */ 'const ai = new GoogleGenAI({ apiKey: process.env.K, httpOptions: { baseUrl: "https://gemini-gw.acme.example/v1beta" } });',
            /*  4 */ 'const ai2 = new GoogleGenAI({ httpOptions: opts });',
            /*  5 */ 'export const a = () => ai.live.connect({ model: "gemini-live-2.5-flash", callbacks: {}, config: { tools: [{ functionDeclarations: [{ name: "f" }] }] } });',
            /*  6 */ 'export const b = () => ai2.models.generateContentStream({ model: "gemini-2.5-flash", contents: "x", config: { tools: [mcpToTool(client), {}, { mcpServers: [{ name: "crm" }] }, { googleSearch: {}, ...more }] } });',
            /*  7 */ 'export const d = () => ai.models.generateContent({ model: "gemini-2.5-flash", contents: "x", config: { ...base, temperature: 0 } });',
            /*  8 */ 'const old = new GoogleGenerativeAI(key);',
            /*  9 */ 'const m = old.getGenerativeModel({ model: "gemini-1.5-pro", tools: [{ codeExecution: {} }] }, { baseUrl: process.env.OLD_URL });',
            /* 10 */ 'const m2 = old.getGenerativeModel({ model: "gemini-1.5-pro", tools: [{ googleSearchRetrieval: {} }] }, requestOptions);',
            /* 11 */ 'export const e = () => m.startChat({ tools: [{ functionDeclarations: [{ name: "g" }] }] });',
            /* 12 */ 'export const f = () => m.startChat(params);',
            /* 13 */ 'export const g = () => m.generateContentStream(prompt);',
            /* 14 */ 'export const h = () => ai.models.generateContent({ model: "gemini-2.5-flash", contents: "x", config: null });',
            /* 15 */ 'export const i = () => ai.models.generateContent({ model: "gemini-2.5-flash", contents: "x", config: { tools: null } });',
            /* 16 */ 'export const j = () => ai.models.generateContent({ model: "gemini-2.5-flash", contents: "x", config: { tools: undefined } });',
        ])).toEqual({
            agents: [
                'a: f:f@L5 | gemini-live-2.5-flash@https://gemini-gw.acme.example/v1beta | env://K',
                'b: b:google_search@L6 | gemini-2.5-flash@null | env://GOOGLE_API_KEY',
                'm: b:code_execution@L9 | gemini-1.5-pro@env://OLD_URL | ',
                'm2: b:google_search_retrieval@L10 | gemini-1.5-pro@null | ',
                // A chat on a model: the model's own name and its base URL.
                'e: f:g@L11 | gemini-1.5-pro@env://OLD_URL | ',
            ],
            // 4: HTTP options from a name. 6: three tools that do not resolve, and a spread. 7: a configuration with a
            // spread. 8: a key from a name. 10: per-model options from a name. 12: a chat's options from a name.
            unresolved: [4, 6, 7, 8, 10, 12],
        });
    });

    it('Gemini in Python: the asynchronous client, a live session with an MCP server, and the older package', () => {
        expect(summary('a.py', [
            /*  1 */ 'import os',
            /*  2 */ 'import google.generativeai as legacy',
            /*  3 */ 'from google import genai',
            /*  4 */ 'from google.genai import types',
            /*  5 */ 'client = genai.Client(http_options=types.HttpOptions(base_url=os.environ["GEMINI_URL"]))',
            /*  6 */ 'def find(x): return x',
            /*  7 */ 'async def a(q):',
            /*  8 */ '    return await client.aio.models.generate_content_stream(model="gemini-2.5-flash", contents=q, config=types.GenerateContentConfig(tools=[types.Tool(function_declarations=[find, {"name": "g"}, nope]), types.Tool(), "google_search"]))',
            /*  9 */ 'async def b():',
            /* 10 */ '    return client.aio.live.connect(model="gemini-live-2.5-flash", config={"tools": [{"mcp_servers": [{"name": "crm", "streamable_http_transport": {"url": "https://mcp.acme.example/x", "headers": hdrs}}]}]})',
            /* 11 */ 'm = legacy.GenerativeModel(model_name="gemini-1.5-pro", tools="nonsense")',
            /* 12 */ 'async def d(p):',
            /* 13 */ '    return await m.generate_content_async(p, tools=[legacy.protos.Tool(function_declarations=[legacy.protos.FunctionDeclaration(name="h")])])',
        ])).toEqual({
            agents: [
                'a: f:find@L6,f:g@L8 | gemini-2.5-flash@env://GEMINI_URL | env://GOOGLE_API_KEY',
                'b: m:crm:*@https://mcp.acme.example/x | gemini-live-2.5-flash@env://GEMINI_URL | env://GOOGLE_API_KEY',
                // No `configure(…)` in the file: where the older package is pointed is not known here.
                'm:  | gemini-1.5-pro@null | ',
                'd: f:h@L13 | gemini-1.5-pro@null | ',
            ],
            unresolved: [8, 10, 11],
        });
    });

    it('Bedrock in TypeScript: the client that is called directly, a tool choice alone, and a command nobody sends', () => {
        expect(summary('a.ts', [
            /*  1 */ 'import * as aws from "@aws-sdk/client-bedrock-runtime";',
            /*  2 */ 'const c = new aws.BedrockRuntime({ region: regionProvider, endpoint: "https://vpce-1.bedrock-runtime.eu-west-1.vpce.amazonaws.com/x" });',
            /*  3 */ 'export const a = () => c.converseStream({ modelId: "amazon.nova-pro-v1:0", messages: [], toolConfig: { tools: [{ systemTool: { name: "nova_grounding" } }, { other: {} }, { cachePoint: {}, ...x }] } });',
            /*  4 */ 'export const b = () => c.converse({ modelId: "amazon.nova-pro-v1:0", messages: [], toolConfig: { toolChoice: { auto: {} } } });',
            /*  5 */ 'export const d = () => c.converse({ modelId: "amazon.nova-pro-v1:0", messages: [], toolConfig: { ...shared } });',
            /*  6 */ 'export const e = () => new aws.ConverseCommand({ modelId: "amazon.nova-pro-v1:0", messages: [], toolConfig: { tools: [{ toolSpec: { name: "unsent" } }] } });',
        ])).toEqual({
            agents: [
                'a: b:nova_grounding@L3 | amazon.nova-pro-v1:0@https://vpce-1.bedrock-runtime.eu-west-1.vpce.amazonaws.com/x | ',
                'd:  | amazon.nova-pro-v1:0@https://vpce-1.bedrock-runtime.eu-west-1.vpce.amazonaws.com/x | ',
                'e: f:unsent@L6 | amazon.nova-pro-v1:0@null | ',
            ],
            unresolved: [3, 5],
        });
    });

    it('Bedrock in Python: a session\'s client, a region by position, an endpoint written out, and another service\'s client', () => {
        expect(summary('a.py', [
            /*  1 */ 'import boto3, os',
            /*  2 */ 'session = boto3.Session(profile_name="p")',
            /*  3 */ 'c = session.client("bedrock-runtime", "ap-southeast-2")',
            /*  4 */ 's3 = boto3.client("s3")',
            /*  5 */ 'k = boto3.client(service_name="bedrock-runtime", region_name=REGION, aws_access_key_id="x", aws_secret_access_key=os.environ["AWS_SECRET"], endpoint_url="https://bedrock.internal.acme.example")',
            /*  6 */ 'def a(m): return c.converse(modelId="amazon.nova-pro-v1:0", messages=m, toolConfig={"tools": [{"toolSpec": {"name": "f"}}]})',
            /*  7 */ 'def b(m): return k.converse_stream(modelId="amazon.nova-pro-v1:0", messages=m, toolConfig={"tools": [{"toolSpec": {"name": "f"}}]})',
            /*  8 */ 'def d(m): return s3.converse(modelId="amazon.nova-pro-v1:0", messages=m, toolConfig={"tools": [{"toolSpec": {"name": "f"}}]})',
        ])).toEqual({
            agents: [
                'a: f:f@L6 | amazon.nova-pro-v1:0@https://bedrock-runtime.ap-southeast-2.amazonaws.com | ',
                'b: f:f@L7 | amazon.nova-pro-v1:0@https://bedrock.internal.acme.example | env://AWS_SECRET',
            ],
            unresolved: [],
        });
    });
});

describe('9. this scanner\'s own facts hold for a provider agent', () => {
    it('the file gate hands on a file that names a provider\'s SDK, and only while that is looked for', async () => {
        const dir = estate({
            'claude.ts': 'import type Anthropic from "@anthropic-ai/sdk";\n',
            'gpt.py': 'from openai import OpenAI\n',
            'gemini.py': 'from google import genai\n',
            'gemini-old.py': 'import google.generativeai as genai\n',
            'gemini-old.ts': 'import { GoogleGenerativeAI } from "@google/generative-ai";\n',
            'nova.ts': 'import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";\n',
            'nova.py': 'import boto3\n',
            'errors.py': 'from botocore.exceptions import ClientError\n',
            'agent.py': 'from langchain.agents import AgentExecutor\n',
            'plain.py': 'print("hello")\n',
        });
        const handedOn = async (markers?: readonly string[]) => {
            const paths: string[] = [];
            const read = await readCodeFiles([{ label: 'acme', path: dir }], REAL_FS, { ...LATER, ...(markers ? { markers } : {}) }, (f) => paths.push(f.path));
            return { paths, read };
        };
        const all = await handedOn();
        expect(all.paths).toEqual(['agent.py', 'claude.ts', 'errors.py', 'gemini-old.py', 'gemini-old.ts', 'gemini.py', 'gpt.py', 'nova.py', 'nova.ts']);
        expect(all.read).toEqual({ rows: 10, problems: [] });
        // The frameworks alone: exactly what was handed on before a provider's SDK was looked for.
        const narrowed = await handedOn(markersFor(false));
        expect(narrowed.paths).toEqual(['agent.py']);
        expect(narrowed.read).toEqual({ rows: 10, problems: [] });
    });

    it('a payment client in a provider agent\'s file is that agent\'s capability, as it is for any agent the file defines', async () => {
        const text = [
            /*  1 */ 'import Anthropic from "@anthropic-ai/sdk";',
            /*  2 */ 'import { wrapFetchWithPayment } from "x402-fetch";',
            /*  3 */ 'const client = new Anthropic();',
            /*  4 */ 'const pay = wrapFetchWithPayment(fetch, wallet);',
            /*  5 */ 'export async function buyer(messages: Anthropic.MessageParam[]) {',
            /*  6 */ '  return client.messages.create({ model: "claude-sonnet-4-5", max_tokens: 1, messages, tools: [{ name: "buy", input_schema: {} }] });',
            /*  7 */ '}',
        ].join('\n');
        const scan = await scanOf([{ 'shop/buyer.ts': text }]);
        expect(scan.problems).toEqual([]);
        expect(scan.agents.map((a) => [a.name, a.framework])).toEqual([['buyer', 'anthropic-sdk']]);
        expect(observationOf(scan.agents[0]).paymentCapabilities).toEqual([{ protocol: 'x402', library: 'x402-fetch', at: loc('shop/buyer.ts', 4) }]);
        // With the recognition off the file defines no agent, so there is nobody to attribute the capability to.
        expect((await scanOf([{ 'shop/buyer.ts': text }], { providerSdks: false })).agents).toEqual([]);
    });

    it('a module loaded by a computed name in a provider agent\'s file is out of sight, as in any file that defines an agent', async () => {
        const text = [
            /*  1 */ 'import anthropic',
            /*  2 */ 'import importlib',
            /*  3 */ 'client = anthropic.Anthropic()',
            /*  4 */ 'plugin = importlib.import_module(name)',
            /*  5 */ 'def agent(messages):',
            /*  6 */ '    return client.messages.create(model="claude-sonnet-4-5", max_tokens=1, messages=messages, tools=[{"name": "buy", "input_schema": {}}])',
        ].join('\n');
        const on = await fileOf('shop/agent.py', text);
        expect(on.names).toEqual(['agent']);
        expect(on.unresolved).toEqual(['UNPARSEABLE@4']);
        // Off, the file names no framework and is not parsed: the same line is not a place that failed to resolve.
        expect(await scanOf([{ 'shop/agent.py': text }], { providerSdks: false })).toEqual({ rows: 1, agents: [], problems: [] });
    });
});
