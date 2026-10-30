/**
 * WHAT THE CONNECT WIZARD HANDS A CUSTOMER (Step 3a, #4155).
 *
 * "Connect an agent you run", on a registered agent's page, mints an API key
 * bound to that agent and shows the configuration that points the customer's
 * own agent at Inflect's `/api/mcp`:
 *
 *   • for code written on the Claude Agent SDK, TypeScript and Python options;
 *   • for an agent built in Anthropic's Console (Managed Agents), the MCP server
 *     entry, the vault credential and the toolset, to paste.
 *
 * Pure and client-safe: the wizard renders all of it in the browser, so the key
 * never travels back to the server inside a snippet.
 *
 * Four rules, each tested in `tests/unit/agentic/connect-wizard.test.ts`:
 *
 *   • THE KEY'S SCOPES ARE THE GRANTS', AND NO MORE (owner decision 2026-10-29
 *     on #4155). `mcp:read`, `mcp:propose` only when a propose tool is granted,
 *     and each granted tool's own resource scope, which `/api/mcp` checks on
 *     top of `mcp:read`. A key with only `mcp:read` is refused every tool.
 *   • THE TOOL LIST IS THE GRANTS, EXACTLY. `allowedTools` and the Console's
 *     toolset name each granted tool and nothing else: no wildcard, no
 *     server-level entry. `/api/mcp` refuses an ungranted tool anyway; the
 *     list keeps the customer's agent from asking.
 *   • NO KEY IN THE CODE. The snippets read it from `INFLECT_API_KEY`, so code
 *     that is committed carries a reference, not a credential. The Console's
 *     vault credential is the one place the key is pasted, and it is a vault.
 *   • THE PRODUCT SAYS "AGENT". Nothing here names a Claude product the
 *     customer is not using (global rule 12).
 */
import { EXTERNAL_TOOL_PREFIX } from '@/lib/mcp/external-tool-name';
import {
    EXTERNAL_TOOL_KEY_SCOPE,
    MCP_TOOL_KEY_SCOPE,
    isKnownMcpTool,
    mcpToolCapabilityClass,
} from '@/lib/mcp/tool-catalogue';

/** The name the customer's agent gives Inflect's MCP server. */
export const INFLECT_MCP_SERVER_NAME = 'inflect';

/** The environment variable the snippets read the key from. */
export const INFLECT_KEY_ENV = 'INFLECT_API_KEY';

/** The placeholder the Console's vault credential shows where the key goes. */
export const KEY_PLACEHOLDER = '<paste the key shown above>';

/** Inflect's MCP endpoint on the origin the customer reaches Inflect at. */
export function mcpEndpointFor(origin: string): string {
    return `${origin.replace(/\/+$/, '')}/api/mcp`;
}

/** The scope a granted tool needs, or null for a name this build does not know. */
function keyScopeOf(tool: string): string | null {
    if (tool.startsWith(EXTERNAL_TOOL_PREFIX)) return EXTERNAL_TOOL_KEY_SCOPE;
    return isKnownMcpTool(tool) ? MCP_TOOL_KEY_SCOPE[tool as keyof typeof MCP_TOOL_KEY_SCOPE] : null;
}

/**
 * The scopes the wizard's key carries for these grants. A grant this build
 * does not know adds no scope, so the key cannot call it: the wizard says so
 * rather than guessing one.
 */
export function connectKeyScopes(grantedTools: readonly string[]): string[] {
    const scopes = new Set<string>(['mcp:read']);
    for (const tool of grantedTools) {
        if (mcpToolCapabilityClass(tool) === 'propose' && isKnownMcpTool(tool)) scopes.add('mcp:propose');
        const scope = keyScopeOf(tool);
        if (scope !== null) scopes.add(scope);
    }
    return [...scopes].sort();
}

/** Grants the wizard cannot scope a key for: names this build does not know. */
export function unscopedGrants(grantedTools: readonly string[]): string[] {
    return grantedTools.filter((tool) => keyScopeOf(tool) === null);
}

/** The granted tools, sorted, once each: the order every snippet lists them in. */
function toolList(grantedTools: readonly string[]): string[] {
    return [...new Set(grantedTools)].sort();
}

/** The Agent SDK's name for each granted tool on Inflect's server: `mcp__inflect__<tool>`. */
export function sdkAllowedTools(grantedTools: readonly string[]): string[] {
    return toolList(grantedTools).map((tool) => `mcp__${INFLECT_MCP_SERVER_NAME}__${tool}`);
}

const quoted = (values: readonly string[], indent: string): string =>
    values.length === 0 ? '[]' : `[\n${values.map((v) => `${indent}    ${JSON.stringify(v)},`).join('\n')}\n${indent}]`;

/** The TypeScript options for `query()` from `@anthropic-ai/claude-agent-sdk`. */
export function agentSdkTypeScript(input: { origin: string; grantedTools: readonly string[] }): string {
    return [
        `import { env, stdout } from "node:process";`,
        `import { query } from "@anthropic-ai/claude-agent-sdk";`,
        ``,
        `const options = {`,
        `  mcpServers: {`,
        `    ${INFLECT_MCP_SERVER_NAME}: {`,
        `      type: "http",`,
        `      url: ${JSON.stringify(mcpEndpointFor(input.origin))},`,
        `      headers: { Authorization: "Bearer " + env.${INFLECT_KEY_ENV} },`,
        `    },`,
        `  },`,
        `  allowedTools: ${quoted(sdkAllowedTools(input.grantedTools), '  ')},`,
        `  tools: [],`,
        `  settingSources: [],`,
        `  strictMcpConfig: true,`,
        `  permissionMode: "dontAsk",`,
        `};`,
        ``,
        `for await (const message of query({ prompt: "Summarise our open risks.", options })) {`,
        `  if (message.type === "result") stdout.write(JSON.stringify(message) + "\\n");`,
        `}`,
        ``,
    ].join('\n');
}

/** The Python `ClaudeAgentOptions` for `query()` from `claude_agent_sdk`. */
export function agentSdkPython(input: { origin: string; grantedTools: readonly string[] }): string {
    return [
        `import os`,
        ``,
        `from claude_agent_sdk import ClaudeAgentOptions, query`,
        ``,
        `options = ClaudeAgentOptions(`,
        `    mcp_servers={`,
        `        ${JSON.stringify(INFLECT_MCP_SERVER_NAME)}: {`,
        `            "type": "http",`,
        `            "url": ${JSON.stringify(mcpEndpointFor(input.origin))},`,
        `            "headers": {"Authorization": "Bearer " + os.environ[${JSON.stringify(INFLECT_KEY_ENV)}]},`,
        `        }`,
        `    },`,
        `    allowed_tools=${quoted(sdkAllowedTools(input.grantedTools), '    ')},`,
        `    tools=[],`,
        `    setting_sources=[],`,
        `    strict_mcp_config=True,`,
        `    permission_mode="dontAsk",`,
        `)`,
        ``,
        ``,
        `async def main() -> None:`,
        `    async for message in query(prompt="Summarise our open risks.", options=options):`,
        `        print(message)`,
        ``,
    ].join('\n');
}

/** What to paste into the Console for a Managed Agent, one object per field. */
export interface ManagedAgentConfig {
    /** The agent's `mcp_servers` entry. */
    readonly mcpServer: { type: 'url'; name: string; url: string };
    /** The vault credential: a static bearer token for exactly that URL. */
    readonly vaultCredential: {
        display_name: string;
        auth: { type: 'static_bearer'; mcp_server_url: string; token: string };
    };
    /**
     * The agent's toolset for Inflect's server: every tool off by default, and
     * each granted tool turned on, a read running on its own and a propose
     * paused for a person's approval.
     */
    readonly mcpToolset: {
        type: 'mcp_toolset';
        mcp_server_name: string;
        default_config: { enabled: false; permission_policy: { type: 'always_ask' } };
        configs: Array<{ name: string; enabled: true; permission_policy: { type: 'always_allow' | 'always_ask' } }>;
    };
}

export function managedAgentConfig(input: { origin: string; grantedTools: readonly string[] }): ManagedAgentConfig {
    const url = mcpEndpointFor(input.origin);
    return {
        mcpServer: { type: 'url', name: INFLECT_MCP_SERVER_NAME, url },
        vaultCredential: {
            display_name: 'Inflect',
            auth: { type: 'static_bearer', mcp_server_url: url, token: KEY_PLACEHOLDER },
        },
        mcpToolset: {
            type: 'mcp_toolset',
            mcp_server_name: INFLECT_MCP_SERVER_NAME,
            default_config: { enabled: false, permission_policy: { type: 'always_ask' } },
            configs: toolList(input.grantedTools).map((name) => ({
                name,
                enabled: true as const,
                // A propose tool queues a proposal in Inflect, and a person decides it
                // there; asking first in the Console too keeps a person in front of
                // the call itself.
                permission_policy: { type: mcpToolCapabilityClass(name) === 'read' ? ('always_allow' as const) : ('always_ask' as const) },
            })),
        },
    };
}
