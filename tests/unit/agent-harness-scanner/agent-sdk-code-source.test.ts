/**
 * The Claude Agent SDK in the scanner's `code` source (#4156).
 *
 *   1. Each fixture yields its SDK agents, in TypeScript and Python, with their
 *      tools, model endpoint, credentials and options — and the options the
 *      owner mapped become NOT MET ladder verdicts, with the option's locator
 *      as evidence. The agent the connect wizard's hardening describes raises
 *      none.
 *   2. A `query` that is not imported from the SDK is not an agent, in either
 *      language.
 *   3. Every shape the reader cannot resolve is UNPARSEABLE at its line; the
 *      agent is still reported with what did resolve, and an option the reader
 *      could not read concludes nothing.
 *   4. Credentials by reference only, over the whole signed report.
 */
import { generateKeyPairSync } from 'crypto';
import { rmSync } from 'fs';
import { lstat, readdir, readFile } from 'fs/promises';

import {
    AGENT_SDK_PY,
    AGENT_SDK_TS,
    AGENT_SDK_UNRESOLVED,
    NOT_AGENT_SDK,
    PLAIN_LITERAL_KEY,
    agentSdkLiteralCredentials,
    fakeAnthropicKey,
    writeCodeEstate,
} from '../../helpers/agent-harness-code-fixtures';
import { looksLikeSecret, verifyAndParseHarnessReport } from '@/lib/agentic/harness-contract';
import { AGENT_SDK_OPTION_CRITERIA, firstSecretShapedMember } from '@/lib/agentic/harness-findings';
import { agentSdkPython, agentSdkTypeScript } from '@/lib/agentic/connect-wizard';
import { isHarnessCriterionId } from '@/lib/agentic/harness-ladder';
import { parseScannerConfig } from '../../../packages/agent-harness-scanner/src/config';
import { jsonLineLog } from '../../../packages/agent-harness-scanner/src/log';
import { rawPublicKeyHex } from '../../../packages/agent-harness-scanner/src/report';
import { runScan } from '../../../packages/agent-harness-scanner/src/scan';
import type { CodeFs } from '../../../packages/agent-harness-scanner/src/sources/code/files';
import type { DetectedAgent } from '../../../packages/agent-harness-scanner/src/sources/code/recognize';
import { langchainCodeSource, observationOf, scanLangChainCode } from '../../../packages/agent-harness-scanner/src/sources/langchain';
import type { SourceContext } from '../../../packages/agent-harness-scanner/src/source';

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

const loc = (path: string, line: number) => `code://acme/${path}#L${line}`;
const verdictsOf = (a: DetectedAgent) => observationOf(a).verdicts.map((v) => [v.criterion, v.met, v.evidence]);
const toolsOf = (a: DetectedAgent) => a.tools.map((t) => [t.kind, t.name, t.server]);
const DEFAULT_BUILTINS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'Skill'];

/** Sign one report over `trees` with the real scanner. */
async function signedReport(...trees: Readonly<Record<string, string>>[]) {
    const dir = estate(...trees);
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
    return { raw, body, dir, publicKeyHex: rawPublicKeyHex(publicKey) };
}

describe('1. SDK agents, their tools, model, credentials and option verdicts', () => {
    it('TypeScript: the wizard\'s hardened agent raises no option verdict', async () => {
        const { byName } = await agentsIn(AGENT_SDK_TS);
        const support = byName.get('options')!;
        expect(support).toMatchObject({
            framework: 'claude-agent-sdk',
            language: 'javascript',
            discoveredId: 'code:acme/support-bot/agent.ts#options',
            subagents: 0,
        });
        // `tools: []` turns every built-in off; the MCP servers and the names
        // `allowedTools` approves on them are what it can call.
        expect(toolsOf(support)).toEqual([
            ['mcp', 'inflect:*', 'https://inflect.acme.example/api/mcp'],
            ['mcp', 'notes:*', loc('support-bot/agent.ts', 20)],
            ['mcp', 'list_risks', 'https://inflect.acme.example/api/mcp'],
            ['mcp', 'list_controls', 'https://inflect.acme.example/api/mcp'],
            ['mcp', 'save_note', loc('support-bot/agent.ts', 20)],
        ]);
        expect(support.models.map((m) => [m.provider, m.model, m.endpoint, m.endpointBasis])).toEqual([
            ['anthropic', 'claude-sonnet-5-5', 'https://api.anthropic.com', 'provider-default'],
        ]);
        expect(support.credentials.map((c) => [c.ref, c.basis])).toEqual([
            ['env://INFLECT_API_KEY', 'environment'],
            ['env://ANTHROPIC_API_KEY', 'provider-default'],
        ]);
        expect(support.sdkOptions).toEqual({
            permissionMode: { mode: 'dontAsk', at: loc('support-bot/agent.ts', 22) },
            settingSources: { state: 'EMPTY', at: loc('support-bot/agent.ts', 23) },
            allowedToolsWildcard: { present: false, at: loc('support-bot/agent.ts', 13) },
            shellOrFetch: { names: [], at: loc('support-bot/agent.ts', 12) },
            hooks: { present: true, at: loc('support-bot/agent.ts', 25) },
        });
        expect(verdictsOf(support)).toEqual([]);
    });

    it('the connect wizard\'s own snippets are each found as one SDK agent, naming Inflect and only the granted tools (Step 3H)', async () => {
        // The REAL generator output (Step 3a), not a fixture written to resemble
        // it: what a customer pastes is what the scanner reads.
        const input = { origin: 'https://inflect.acme.example', grantedTools: ['list_risks', 'propose_risks'] };
        const { scan, byName } = await agentsIn({
            'wizard/agent.ts': agentSdkTypeScript(input),
            'wizard/agent.py': agentSdkPython(input),
        });
        expect(scan.agents.map((a) => [a.discoveredId, a.framework])).toEqual(
            expect.arrayContaining([
                ['code:acme/wizard/agent.ts#options', 'claude-agent-sdk'],
                ['code:acme/wizard/agent.py#options', 'claude-agent-sdk'],
            ]),
        );
        expect(scan.agents).toHaveLength(2);
        const ts = byName.get('options')!;
        for (const agent of scan.agents) {
            // The server it is configured with, then the names `allowedTools`
            // approves on it: Inflect's, and no other server's.
            expect(agent.tools.map((t) => [t.kind, t.name, t.server])).toEqual([
                ['mcp', 'inflect:*', 'https://inflect.acme.example/api/mcp'],
                ['mcp', 'list_risks', 'https://inflect.acme.example/api/mcp'],
                ['mcp', 'propose_risks', 'https://inflect.acme.example/api/mcp'],
            ]);
            expect(agent.credentials.map((c) => c.ref)).toContain('env://INFLECT_API_KEY');
        }
        // The wizard turns off every option the owner mapped to a criterion;
        // what code cannot see, a hook, is the one verdict it draws.
        expect(ts.sdkOptions).toMatchObject({
            permissionMode: { mode: 'dontAsk' },
            settingSources: { state: 'EMPTY' },
            allowedToolsWildcard: { present: false },
            shellOrFetch: { names: [] },
        });
        for (const agent of scan.agents) {
            expect(observationOf(agent).verdicts.map((v) => [v.criterion, v.met])).toEqual([['H3.payloads_guarded', false]]);
        }
    });

    it('a key read from Node\'s process module is the environment however it is imported, and a local `env` is not', async () => {
        const agent = (prelude: string, read: string) =>
            [
                prelude,
                `import { query } from "@anthropic-ai/claude-agent-sdk";`,
                `const options = { mcpServers: { inflect: { type: "http", url: "https://inflect.acme.example/api/mcp",`,
                `  headers: { Authorization: "Bearer " + ${read} } } }, allowedTools: ["mcp__inflect__list_risks"], tools: [] };`,
                `for await (const m of query({ prompt: "x", options })) {}`,
            ].join('\n');
        const { scan } = await agentsIn({
            'forms/named.ts': agent(`import { env } from "node:process";`, 'env.INFLECT_API_KEY'),
            'forms/aliased.ts': agent(`import { env as e } from "process";`, 'e["INFLECT_API_KEY"]'),
            'forms/namespace.ts': agent(`import * as p from "node:process";`, 'p.env.INFLECT_API_KEY'),
            'forms/default.ts': agent(`import proc from "node:process";`, 'proc.env.INFLECT_API_KEY'),
            'forms/required.js': agent(`const { env } = require("node:process");`, 'env.INFLECT_API_KEY'),
            'forms/global.ts': agent('', 'process.env.INFLECT_API_KEY'),
            'forms/local.ts': agent(`const env = { INFLECT_API_KEY: "not the environment" };`, 'env.INFLECT_API_KEY'),
        });
        const inflectKey = new Map(
            scan.agents.map((a) => [a.discoveredId.split('/')[2].split('#')[0], a.credentials.some((c) => c.ref === 'env://INFLECT_API_KEY')]),
        );
        expect(Object.fromEntries(inflectKey)).toEqual({
            'named.ts': true,
            'aliased.ts': true,
            'namespace.ts': true,
            'default.ts': true,
            'required.js': true,
            'global.ts': true,
            'local.ts': false,
        });
    });

    it('TypeScript: an agent left at the SDK\'s defaults fails every option the owner mapped', async () => {
        const { byName } = await agentsIn(AGENT_SDK_TS);
        const ops = byName.get('opsRun')!;
        // `tools` left out: every built-in is on, reported where the call is.
        expect(toolsOf(ops)).toEqual([
            ['mcp', 'ops:*', loc('ops-bot/agent.ts', 7)],
            ...DEFAULT_BUILTINS.map((n) => ['builtin', n, loc('ops-bot/agent.ts', 3)]),
        ]);
        expect(ops.credentials.map((c) => c.ref)).toEqual(['env://OPS_TOKEN', 'env://ANTHROPIC_API_KEY']);
        expect(verdictsOf(ops)).toEqual([
            ['H3.propose_not_commit', false, loc('ops-bot/agent.ts', 8)],
            ['H3.skills_declared', false, loc('ops-bot/agent.ts', 3)],
            ['H2.tools_allowlisted', false, loc('ops-bot/agent.ts', 3)],
            ['H2.tools_allowlisted', false, loc('ops-bot/agent.ts', 6)],
            ['H2.tools_allowlisted', false, loc('ops-bot/agent.ts', 3)],
        ]);
    });

    it('Python: a ClaudeSDKClient with settings off and no hook fails only H3.payloads_guarded', async () => {
        const { byName } = await agentsIn(AGENT_SDK_PY);
        const triage = byName.get('options')!;
        expect(triage).toMatchObject({ language: 'python', discoveredId: 'code:acme/triage/agent.py#options', subagents: 1 });
        expect(toolsOf(triage)).toEqual([
            ['mcp', 'inflect:*', 'https://inflect.acme.example/api/mcp'],
            ['builtin', 'Read', loc('triage/agent.py', 7)],
            ['builtin', 'Grep', loc('triage/agent.py', 7)],
            ['mcp', 'list_findings', 'https://inflect.acme.example/api/mcp'],
        ]);
        expect(triage.models.map((m) => m.model)).toEqual(['claude-opus-5-5']);
        expect(verdictsOf(triage)).toEqual([['H3.payloads_guarded', false, loc('triage/agent.py', 24)]]);
    });

    it('Python: `async for … in query(...)` is an agent, and its options fail what they set', async () => {
        const { byName } = await agentsIn(AGENT_SDK_PY);
        const digest = byName.get('L5')!;
        expect(digest.discoveredId).toBe('code:acme/digest/agent.py#L5');
        expect(toolsOf(digest).map(([kind, name]) => [kind, name])).toEqual(DEFAULT_BUILTINS.map((n) => ['builtin', n]));
        expect(verdictsOf(digest).map(([criterion]) => criterion)).toEqual([
            'H3.propose_not_commit',
            'H3.skills_declared',
            'H2.tools_allowlisted',
            'H2.tools_allowlisted',
            'H2.tools_allowlisted',
        ]);
    });

    it('Python: a ClaudeAgentOptions no call in its file consumes is an agent of its own', async () => {
        const { scan, byName } = await agentsIn(AGENT_SDK_PY);
        expect(scan.agents.map((a) => a.discoveredId).sort()).toEqual([
            'code:acme/digest/agent.py#L5',
            'code:acme/shared/options.py#support_options',
            'code:acme/triage/agent.py#options',
        ]);
        // A hook that is present is no evidence that it guards anything, and
        // no verdict says it is met.
        expect(byName.get('support_options')!.sdkOptions?.hooks).toEqual({ present: true, at: loc('shared/options.py', 3) });
        expect(verdictsOf(byName.get('support_options')!)).toEqual([]);
    });

    it('disallowedTools removes a built-in by its bare name; a scoped rule narrows one and removes nothing', async () => {
        const { byName } = await agentsIn({
            'narrowed/agent.py': `from claude_agent_sdk import ClaudeAgentOptions

narrowed_options = ClaudeAgentOptions(disallowed_tools=["Bash", "WebFetch", "Write(*.env)"], setting_sources=[], hooks={"PreToolUse": []})
`,
        });
        const agent = byName.get('narrowed_options')!;
        expect(agent.tools.map((t) => t.name)).toEqual(DEFAULT_BUILTINS.filter((n) => n !== 'Bash' && n !== 'WebFetch'));
        expect(agent.sdkOptions?.shellOrFetch).toEqual({ names: [], at: loc('narrowed/agent.py', 3) });
        expect(verdictsOf(agent)).toEqual([]);
    });

    it('every option verdict is NOT MET, on a criterion the ladder holds', async () => {
        const { scan } = await agentsIn(AGENT_SDK_TS, AGENT_SDK_PY, AGENT_SDK_UNRESOLVED);
        const verdicts = scan.agents.flatMap((a) => observationOf(a).verdicts);
        expect(verdicts.length).toBeGreaterThan(0);
        for (const v of verdicts) {
            expect(v.met).toBe(false);
            expect(isHarnessCriterionId(v.criterion)).toBe(true);
            expect(Object.values(AGENT_SDK_OPTION_CRITERIA)).toContain(v.criterion);
        }
    });
});

describe('2. a `query` not imported from the SDK is not an agent', () => {
    it('in Python and in TypeScript, though each file imports from the SDK and is read', async () => {
        const { scan } = await agentsIn(NOT_AGENT_SDK);
        expect(scan.agents).toEqual([]);
        expect(scan.problems).toEqual([]);
    });

    it('the same Python file with the SDK\'s `query` imported is one (the positive control)', async () => {
        const imported = {
            'lookalike/query.py': NOT_AGENT_SDK['lookalike/query.py'].replace(
                'from acme.db import query as db_query',
                'from claude_agent_sdk import query as db_query',
            ),
        };
        expect(imported['lookalike/query.py']).not.toEqual(NOT_AGENT_SDK['lookalike/query.py']);
        const { scan } = await agentsIn(imported);
        expect(scan.agents.map((a) => a.discoveredId)).toEqual(['code:acme/lookalike/query.py#rows']);
    });

    it('the same TypeScript file with the SDK\'s `query` imported is one (the positive control)', async () => {
        const imported = {
            'lookalike/query.ts': NOT_AGENT_SDK['lookalike/query.ts'].replace(
                'import { query as dbQuery } from "./db";',
                'import { query as dbQuery } from "@anthropic-ai/claude-agent-sdk";',
            ),
        };
        expect(imported['lookalike/query.ts']).not.toEqual(NOT_AGENT_SDK['lookalike/query.ts']);
        const { scan } = await agentsIn(imported);
        // `dbQuery("select 1")` passes no options object the reader can see.
        expect(scan.agents.map((a) => a.discoveredId)).toEqual(['code:acme/lookalike/query.ts#rows']);
    });
});

describe('3. what the reader cannot resolve is UNPARSEABLE, and concludes nothing', () => {
    const problemsAt = (scan: Awaited<ReturnType<typeof agentsIn>>['scan']) =>
        scan.problems.map((p) => [p.reason, p.at?.path, p.at?.line]).sort();

    it('each unresolved shape is reported at its line, and its agent is still reported', async () => {
        const { scan } = await agentsIn(AGENT_SDK_UNRESOLVED);
        expect(problemsAt(scan)).toEqual([
            ['UNPARSEABLE', 'computed/agent.py', 5],
            ['UNPARSEABLE', 'json-servers/agent.py', 3],
            ['UNPARSEABLE', 'passed-in/agent.ts', 4],
            ['UNPARSEABLE', 'spread/agent.py', 5],
        ]);
        expect(scan.agents.map((a) => a.discoveredId).sort()).toEqual([
            'code:acme/computed/agent.py#computed_options',
            'code:acme/json-servers/agent.py#json_options',
            'code:acme/passed-in/agent.ts#options',
            'code:acme/spread/agent.py#spread_options',
        ]);
    });

    it('options passed in from elsewhere: every option is unknown, and no verdict is drawn', async () => {
        const { byName } = await agentsIn({ 'passed-in/agent.ts': AGENT_SDK_UNRESOLVED['passed-in/agent.ts'] });
        const agent = byName.get('options')!;
        expect(agent.sdkOptions).toEqual({ permissionMode: null, settingSources: null, allowedToolsWildcard: null, shellOrFetch: null, hooks: null });
        expect(agent.tools).toEqual([]);
        // Not the SDK's defaults: options the reader cannot see could set `env`.
        expect(agent.models.map((m) => [m.endpoint, m.endpointBasis])).toEqual([[null, 'unknown']]);
        expect(agent.credentials).toEqual([]);
        expect(verdictsOf(agent)).toEqual([]);
    });

    it('`**kwargs`: what is written still resolves, and nothing else is assumed', async () => {
        const { byName } = await agentsIn({ 'spread/agent.py': AGENT_SDK_UNRESOLVED['spread/agent.py'] });
        const agent = byName.get('spread_options')!;
        expect(agent.models.map((m) => m.model)).toEqual(['claude-sonnet-5-5']);
        expect(agent.sdkOptions?.settingSources).toBeNull();
        expect(verdictsOf(agent)).toEqual([]);
    });

    it('a computed tool list: the shell-or-fetch option is unknown, and the options that were read still speak', async () => {
        const { byName } = await agentsIn({ 'computed/agent.py': AGENT_SDK_UNRESOLVED['computed/agent.py'] });
        const agent = byName.get('computed_options')!;
        expect(agent.sdkOptions?.shellOrFetch).toBeNull();
        expect(verdictsOf(agent).map(([criterion]) => criterion)).toEqual(['H3.payloads_guarded']);
    });

    it('MCP servers in a file the code names: an approved name on an unknown server is not attributed', async () => {
        const { byName } = await agentsIn({ 'json-servers/agent.py': AGENT_SDK_UNRESOLVED['json-servers/agent.py'] });
        expect(byName.get('json_options')!.tools).toEqual([]);
    });

    it('the source reports INCOMPLETE UNPARSEABLE', async () => {
        const source = langchainCodeSource({ roots: [{ label: 'acme', path: estate(AGENT_SDK_UNRESOLVED) }] });
        const context = { asOf: new Date(), deadline: Number.MAX_SAFE_INTEGER, now: Date.now } as unknown as SourceContext;
        const result = await source.read(context);
        expect(result).toMatchObject({ kind: 'code', status: 'INCOMPLETE', reason: 'UNPARSEABLE', rows: 4 });
        expect(result.observations).toHaveLength(4);
    });
});

describe('4. credentials by reference only', () => {
    it('a key written into the code is reported as where it is written', async () => {
        const { byName } = await agentsIn(agentSdkLiteralCredentials());
        expect(byName.get('hardcodedSdkTs')!.credentials.map((c) => [c.ref, c.basis])).toEqual([
            [loc('hardcoded-sdk/agent.ts', 3), 'literal'],
        ]);
        expect(byName.get('hardcoded_sdk_py')!.credentials.map((c) => [c.ref, c.basis])).toEqual([
            [loc('hardcoded-sdk/agent.py', 3), 'literal'],
        ]);
    });

    it('no literal reaches the signed report, and no member of it is secret-shaped', async () => {
        expect(looksLikeSecret(fakeAnthropicKey())).toBe(true);
        const { raw, body, dir, publicKeyHex } = await signedReport(AGENT_SDK_TS, AGENT_SDK_PY, AGENT_SDK_UNRESOLVED, agentSdkLiteralCredentials());
        for (const literal of [fakeAnthropicKey(), PLAIN_LITERAL_KEY]) expect(raw).not.toContain(literal);
        expect(raw).not.toContain(dir);
        expect(firstSecretShapedMember(body)).toBeNull();
        expect(verifyAndParseHarnessReport(raw, [publicKeyHex])).toMatchObject({ ok: true, complete: false });
        // One verdict per criterion in the report: the builder collapses an
        // agent's repeats to the least favourable, which for NOT MET is the first.
        const ops = body.agents.find((a) => a.discoveredId === 'code:acme/ops-bot/agent.ts#opsRun')!;
        expect(ops.verdicts).toEqual([
            { criterion: 'H2.tools_allowlisted', met: false, evidence: loc('ops-bot/agent.ts', 3) },
            { criterion: 'H3.propose_not_commit', met: false, evidence: loc('ops-bot/agent.ts', 8) },
            { criterion: 'H3.skills_declared', met: false, evidence: loc('ops-bot/agent.ts', 3) },
        ]);
    });

    it('every fixture report, each estate on its own, carries no secret-shaped member', async () => {
        for (const tree of [AGENT_SDK_TS, AGENT_SDK_PY, AGENT_SDK_UNRESOLVED, NOT_AGENT_SDK, agentSdkLiteralCredentials()]) {
            const { body } = await signedReport(tree);
            expect(firstSecretShapedMember(body)).toBeNull();
        }
    });
});
