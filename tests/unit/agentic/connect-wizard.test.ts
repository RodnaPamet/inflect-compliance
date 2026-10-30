/**
 * What the connect wizard hands a customer (Step 3a, #4155): the key's scopes,
 * the Agent SDK options and the Console configuration, built from the agent's
 * grants and nothing else.
 */
import {
    INFLECT_KEY_ENV,
    agentSdkPython,
    agentSdkTypeScript,
    connectKeyScopes,
    managedAgentConfig,
    mcpEndpointFor,
    sdkAllowedTools,
    unscopedGrants,
} from '@/lib/agentic/connect-wizard';
import { MCP_PROPOSE_TOOL_NAMES, MCP_READ_TOOL_NAMES, MCP_TOOL_KEY_SCOPE } from '@/lib/mcp/tool-catalogue';
import { validateScopes } from '@/lib/auth/api-key-auth';

const ORIGIN = 'https://app.acme.example';
const EXTERNAL = 'mcp__conn_123__create_issue';
const GRANTS = ['list_risks', 'propose_risks', 'list_controls', EXTERNAL];

describe('the key carries exactly the scopes its grants need', () => {
    it('read grants: mcp:read and each tool\'s resource scope, and never mcp:propose', () => {
        expect(connectKeyScopes(['list_risks', 'list_findings'])).toEqual(['audits:read', 'mcp:read', 'risks:read']);
    });

    it('a propose grant adds mcp:propose; an external tool adds admin:external_tools', () => {
        expect(connectKeyScopes(GRANTS)).toEqual(['admin:external_tools', 'controls:read', 'mcp:propose', 'mcp:read', 'risks:read']);
    });

    it('every scope is one a granted tool checks: no wildcard, no scope without a grant', () => {
        for (const tool of [...MCP_READ_TOOL_NAMES, ...MCP_PROPOSE_TOOL_NAMES]) {
            const scopes = connectKeyScopes([tool]);
            expect(scopes.some((s) => s.includes('*'))).toBe(false);
            expect(scopes.filter((s) => !s.startsWith('mcp:'))).toEqual([MCP_TOOL_KEY_SCOPE[tool]]);
        }
    });

    it('a grant this build does not know adds no scope, and is reported', () => {
        expect(connectKeyScopes(['a_tool_from_later'])).toEqual(['mcp:read']);
        expect(unscopedGrants(['list_risks', 'a_tool_from_later'])).toEqual(['a_tool_from_later']);
    });

    it('no grants: the bare door scope, which reaches no tool', () => {
        expect(connectKeyScopes([])).toEqual(['mcp:read']);
    });
});

describe('the Agent SDK options', () => {
    const ts = agentSdkTypeScript({ origin: `${ORIGIN}/`, grantedTools: GRANTS });
    const py = agentSdkPython({ origin: ORIGIN, grantedTools: GRANTS });

    it('allowedTools is exactly the grants, each named mcp__inflect__<tool>, with no wildcard', () => {
        const allowed = sdkAllowedTools([...GRANTS, 'list_risks']);
        expect(allowed).toEqual([
            'mcp__inflect__list_controls',
            'mcp__inflect__list_risks',
            `mcp__inflect__${EXTERNAL}`,
            'mcp__inflect__propose_risks',
        ]);
        expect(allowed.map((t) => t.replace(/^mcp__inflect__/, '')).sort()).toEqual([...new Set(GRANTS)].sort());
        expect(allowed.some((t) => t.includes('*'))).toBe(false);
    });

    it('both languages list the same tools, point at /api/mcp, and read the key from the environment', () => {
        const snippets = [ts, py];
        for (const tool of sdkAllowedTools(GRANTS)) {
            expect(snippets.map((s) => s.includes(JSON.stringify(tool)))).toEqual([true, true]);
        }
        expect(snippets.map((s) => s.includes(JSON.stringify(mcpEndpointFor(ORIGIN))))).toEqual([true, true]);
        expect(snippets.map((s) => s.includes(INFLECT_KEY_ENV))).toEqual([true, true]);
        expect(snippets.map((s) => s.includes('*'))).toEqual([false, false]);
    });

    it('carry the hardening: no built-ins, no host settings, only the servers given, an explicit mode', () => {
        expect(ts).toContain('tools: [],');
        expect(ts).toContain('settingSources: [],');
        expect(ts).toContain('strictMcpConfig: true,');
        expect(ts).toContain('permissionMode: "dontAsk",');
        expect(py).toContain('tools=[],');
        expect(py).toContain('setting_sources=[],');
        expect(py).toContain('strict_mcp_config=True,');
        expect(py).toContain('permission_mode="dontAsk",');
    });

    it('the TypeScript options are typed by the SDK\'s own Options, so a type-checked project accepts them', () => {
        // Untyped, `"http"` and `"dontAsk"` widen to `string` and `query({ options })`
        // does not compile (checked against @anthropic-ai/claude-agent-sdk 0.3.301, Step 3H).
        expect(ts).toContain('import { query, type Options } from "@anthropic-ai/claude-agent-sdk";');
        expect(ts).toContain('const options: Options = {');
    });

    it('never name "Claude Code", and never carry a key', () => {
        const ma = JSON.stringify(managedAgentConfig({ origin: ORIGIN, grantedTools: GRANTS }));
        expect([ts, py, ma].map((text) => text.includes('Claude Code'))).toEqual([false, false, false]);
        expect([ts, py, ma].map((text) => text.includes('iflk_'))).toEqual([false, false, false]);
    });
});

describe('the Console configuration for a Managed Agent', () => {
    const config = managedAgentConfig({ origin: ORIGIN, grantedTools: GRANTS });

    it('one URL server, and a static bearer credential for exactly that URL', () => {
        expect(config.mcpServer).toEqual({ type: 'url', name: 'inflect', url: `${ORIGIN}/api/mcp` });
        expect(config.vaultCredential.auth).toMatchObject({ type: 'static_bearer', mcp_server_url: `${ORIGIN}/api/mcp` });
    });

    it('the toolset turns on exactly the grants, a read allowed and a propose asked', () => {
        expect(config.mcpToolset.default_config).toEqual({ enabled: false, permission_policy: { type: 'always_ask' } });
        expect(config.mcpToolset.configs).toEqual([
            { name: 'list_controls', enabled: true, permission_policy: { type: 'always_allow' } },
            { name: 'list_risks', enabled: true, permission_policy: { type: 'always_allow' } },
            { name: EXTERNAL, enabled: true, permission_policy: { type: 'always_ask' } },
            { name: 'propose_risks', enabled: true, permission_policy: { type: 'always_ask' } },
        ]);
    });
});

describe('the minted key is one the api-keys route accepts', () => {
    it('every scope the wizard can ask for is a valid key scope', () => {
        const everyTool = [...MCP_READ_TOOL_NAMES, ...MCP_PROPOSE_TOOL_NAMES, EXTERNAL];
        expect(validateScopes(connectKeyScopes(everyTool))).toEqual([]);
    });
});
