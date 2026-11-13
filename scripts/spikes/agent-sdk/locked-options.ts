/**
 * `lockedOptions(run)` as the design's table states it
 * (docs/claude-agent-sdk-design.md, "The locked options builder"), for the
 * spike only. Step 4b writes the product's copy in
 * `src/lib/agentic/claude-sdk/options.ts`; nothing here is imported by `src/`.
 *
 * Every row of the table is set here and nowhere else. The additions the
 * spike found necessary, each named where it is made (the implementation note
 * lists them as differences from the design):
 *   - `HOME` is in the built `env`. The table's env omits it, and a child with
 *     no `HOME` resolves its home from the passwd entry: the worker's real home.
 *   - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`: without it the subprocess
 *     sends a session-title request carrying the prompt to the model endpoint,
 *     and telemetry to api.anthropic.com even when ANTHROPIC_BASE_URL is set.
 *   - `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`, and the `skills` option naming
 *     the mounted skills: without `skills`, every bundled skill is listed to
 *     the model and invocable through `Skill`.
 *   - `ENABLE_TOOL_SEARCH=false`: `alwaysLoad: true` alone still lets the CLI
 *     add a `DeferredToolPlaceholder` tool to the request for models that
 *     support tool search, so the model would see a tool outside the set.
 *   - `plugins`: the one skill path that loads under `settingSources: []`.
 *   - `onFailure: 'block'` and a `timeout` on the catch-all hook: a hook that
 *     throws otherwise lets the call run.
 *   - `spikeEnv` lets the harness add instrumentation (a refusing egress
 *     proxy). It is never a product input.
 *
 * `SPIKE_MUTATE` removes named rows, so the lockdown test can be run against a
 * builder that has lost one: `SPIKE_MUTATE=settingSources npm test` must fail.
 * `env.<NAME>` removes one variable from the built env; `hooks.onFailure`
 * removes the hook's fail-closed setting.
 */
import { createSdkMcpServer, tool, type HookCallback, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { ZodRawShape } from 'zod';

export const SERVER = 'inflect';
export const toolPrefix = `mcp__${SERVER}__`;

export interface SpikeTool {
    name: string;
    description: string;
    shape: ZodRawShape;
    handler: (args: Record<string, unknown>) => Promise<string>;
}

export interface SpikeRun {
    /** The resolved, narrowed set: what offerToolSet would hand over. */
    tools: SpikeTool[];
    /** Skill names to enable, and where their SKILL.md files were materialised. */
    skills?: { names: string[]; pluginDir?: string };
    systemPrompt: string;
    model: string;
    maxTurns: number;
    maxBudgetUsd: number;
    apiKey: string;
    baseUrl?: string;
    configDir: string;
    cwd: string;
    home: string;
    abortController: AbortController;
    /** The run's own kill / budget answer, asked by the catch-all hook. */
    gate?: (toolName: string) => { allow: true } | { allow: false; reason: string; defer?: boolean };
    spikeEnv?: Record<string, string>;
}

export const HOOK_TIMEOUT_SECONDS = 30;

export const DISALLOWED = ['Agent', 'Agent(fork)', 'WebFetch', 'WebSearch', 'Bash'] as const;

/** The names `system/init` must report and nothing else. */
export function expectedInitTools(run: Pick<SpikeRun, 'tools' | 'skills'>): string[] {
    const names = run.tools.map((t) => `${toolPrefix}${t.name}`);
    if (run.skills?.names.length) names.push('Skill');
    return names.sort();
}

export function lockedOptions(run: SpikeRun): Options {
    const resolved = new Set(run.tools.map((t) => `${toolPrefix}${t.name}`));
    const skillsMounted = Boolean(run.skills?.names.length);

    // One catch-all PreToolUse hook, no matcher: anything outside the resolved
    // set is denied, and the run's own gate (kill switch, budget) is asked.
    const preToolUse: HookCallback = async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return {};
        const name = input.tool_name;
        const inSet = resolved.has(name) || (skillsMounted && name === 'Skill');
        if (!inSet) {
            return {
                hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: `tool ${name} is not in the run's resolved set`,
                },
            };
        }
        const verdict = run.gate?.(name) ?? { allow: true as const };
        if (!verdict.allow) {
            return {
                hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    // `defer` ends the turn with the call held for a person (need 1 of the Phase 4 trigger).
                    permissionDecision: verdict.defer ? 'defer' : 'deny',
                    permissionDecisionReason: verdict.reason,
                },
            };
        }
        return {};
    };

    const env: Record<string, string> = {
        ANTHROPIC_API_KEY: run.apiKey,
        ...(run.baseUrl ? { ANTHROPIC_BASE_URL: run.baseUrl } : {}),
        CLAUDE_CONFIG_DIR: run.configDir,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
        CLAUDE_CODE_FORK_SUBAGENT: '0',
        // Additions to the table, see the module comment.
        HOME: run.home,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
        ENABLE_TOOL_SEARCH: 'false',
        ...(run.spikeEnv ?? {}),
    };

    const options: Options = {
        tools: skillsMounted ? ['Skill'] : [],
        mcpServers: {
            [SERVER]: createSdkMcpServer({
                name: SERVER,
                alwaysLoad: true,
                tools: run.tools.map((t) =>
                    tool(t.name, t.description, t.shape, async (args) => ({
                        content: [{ type: 'text', text: await t.handler(args as Record<string, unknown>) }],
                    })),
                ),
            }),
        },
        allowedTools: [...resolved].sort(),
        disallowedTools: [...DISALLOWED],
        permissionMode: 'dontAsk',
        // `onFailure: 'block'`: a hook that throws (a kill-switch read that failed) otherwise lets the
        // call RUN; the default is "continue". `timeout`: the default for PreToolUse is 600 s.
        hooks: { PreToolUse: [{ hooks: [preToolUse], onFailure: 'block', timeout: HOOK_TIMEOUT_SECONDS }] },
        settingSources: [],
        strictMcpConfig: true,
        env,
        cwd: run.cwd,
        persistSession: false,
        systemPrompt: run.systemPrompt,
        model: run.model,
        maxTurns: run.maxTurns,
        maxBudgetUsd: run.maxBudgetUsd,
        abortController: run.abortController,
        includePartialMessages: false,
        ...(skillsMounted ? { skills: run.skills!.names } : {}),
        ...(run.skills?.pluginDir ? { plugins: [{ type: 'local' as const, path: run.skills.pluginDir, skipMcpDiscovery: true }] } : {}),
    };

    const mutate = process.env.SPIKE_MUTATE;
    if (mutate) {
        for (const raw of mutate.split(',')) {
            const key = raw.trim();
            if (key.startsWith('env.')) delete env[key.slice(4)];
            else if (key === 'hooks.onFailure') delete options.hooks!.PreToolUse![0].onFailure;
            else delete (options as Record<string, unknown>)[key];
        }
    }
    return options;
}
