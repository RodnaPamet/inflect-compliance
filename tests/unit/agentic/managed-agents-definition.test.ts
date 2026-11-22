/**
 * What the Managed Agents engine writes to a customer's workspace, value by
 * value, and the client's request rules (Step 5b of
 * `docs/claude-managed-agents-design.md`, #4165).
 */
jest.mock('@/env', () => ({ env: { NODE_ENV: 'test' } }));

import {
    ACTIVATE_SKILL_AGENT_TOOL,
    MANAGED_AGENTS_PREAMBLE,
    agentBodyFor,
    agentDrift,
    agentToolsFor,
    environmentBodyFor,
    sessionBudgetFor,
    sessionSystemFor,
    systemHashOf,
    toolsHashOf,
} from '@/lib/agentic/managed-agents/definition';
import { managedAgentsRequestRefusal } from '@/lib/agentic/tool-runner/client';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';

const schema = { type: 'object', properties: { query: { type: 'string' } } };
const catalogue = [
    { name: 'list_risks', description: 'List risks.', inputSchema: schema },
    { name: 'list_controls', description: 'List controls.', inputSchema: schema },
];

describe('the agent Inflect provisions', () => {
    it('holds exactly name, model, system, tools and metadata: no toolset, MCP, skills or sub-agents', () => {
        const shaped = agentToolsFor({ toolNames: ['list_risks'], catalogue, mountsSkills: true });
        if (!shaped.ok) throw new Error(shaped.reason);
        const body = agentBodyFor({ profileId: 'p1', model: 'claude-sonnet-5-5', tools: shaped.tools });
        expect(Object.keys(body).sort()).toEqual(['metadata', 'model', 'name', 'system', 'tools']);
        expect(body.system).toBe(MANAGED_AGENTS_PREAMBLE);
        expect(body.name).toBe('inflect-profile-p1');
        expect(body.tools.map((t) => [t.type, t.name])).toEqual([
            ['custom', 'activate_skill'],
            ['custom', 'list_risks'],
        ]);
        // The skill tool names no skill: a tenant skill's name is the tenant's text.
        expect(JSON.stringify(ACTIVATE_SKILL_AGENT_TOOL)).not.toMatch(/enum/);
    });

    it('refuses a version naming a tool it cannot express, rather than drop it', () => {
        expect(agentToolsFor({ toolNames: ['list_risks', 'ledger_erp_get_order'], catalogue, mountsSkills: false }))
            .toEqual({ ok: false, reason: 'TOOL_NOT_EXPRESSIBLE', tool: 'ledger_erp_get_order' });
        expect(agentToolsFor({ toolNames: [], catalogue, mountsSkills: false })).toEqual({ ok: false, reason: 'NO_TOOLS' });
    });

    it('the environment is cloud, limited, with no allowed hosts, MCP servers or package managers', () => {
        const env = environmentBodyFor('conn-1');
        expect(env.config).toEqual({ type: 'cloud', networking: { type: 'limited', allow_mcp_servers: false, allow_package_managers: false } });
        expect(env.config.networking).not.toHaveProperty('allowed_hosts');
    });
});

describe('the session override', () => {
    it('is the preamble, then the catalogue, then the instructions fenced as the operator\'s', () => {
        const def = { profile: { instructions: 'Do the thing.' } } as unknown as WorkflowDefinition;
        const text = sessionSystemFor(def, '<skill_catalogue>x</skill_catalogue>');
        expect(text.startsWith(MANAGED_AGENTS_PREAMBLE)).toBe(true);
        expect(text.indexOf('<skill_catalogue>')).toBeLessThan(text.indexOf('Do the thing.'));
        expect(text).toMatch(/<operator_instructions source="agent-profile">\nDo the thing\.\n<\/operator_instructions>$/);
    });
});

describe('drift', () => {
    const tools = [{ type: 'custom', name: 'b', description: 'B', input_schema: schema }, { type: 'custom', name: 'a', description: 'A', input_schema: schema }];
    const recorded = { anthropicAgentId: 'agent_1', anthropicAgentVersion: 3, systemHash: systemHashOf('S'), toolsHash: toolsHashOf(tools) };
    const agent = { id: 'agent_1', version: 3, system: 'S', tools: [...tools].reverse() };

    it('the agent as written does not drift, whatever order its tools come back in', () => {
        expect(agentDrift(agent, recorded)).toBeNull();
    });

    it.each([
        ['another version', { version: 4 }, 'NOT_THE_PINNED_VERSION'],
        ['archived', { archived_at: '2026-11-22T00:00:00Z' }, 'ARCHIVED'],
        ['system', { system: 'S2' }, 'SYSTEM_CHANGED'],
        ['a tool description', { tools: [{ ...tools[0], description: 'changed' }, tools[1]] }, 'TOOLS_CHANGED'],
        ['a toolset', { tools: [...tools, { type: 'agent_toolset_20260401' }] }, 'TOOLS_CHANGED'],
        ['skills', { skills: [{ type: 'anthropic', skill_id: 'x' }] }, 'REACHES_BEYOND_CUSTOM_TOOLS'],
        ['sub-agents', { multiagent: { type: 'multiagent_20261001' } }, 'REACHES_BEYOND_CUSTOM_TOOLS'],
    ])('%s is drift', (_label, edit, reason) => {
        expect(agentDrift({ ...agent, ...edit }, recorded)).toBe(reason);
    });
});

describe('the dollar backstop', () => {
    it('prices every token of the cap at the output rate, plus the session-hours, rounded up', () => {
        // 200,000 tokens × $10/MTok = $2.00; one hour × $0.08 = $0.08 → 208 cents.
        expect(sessionBudgetFor({ model: 'claude-sonnet-5-5', tokensLimit: 200_000, runtimeMsLimit: 3_600_000 }))
            .toEqual({ type: 'limit', max_list_cost: { amount: '208', currency: 'USD' } });
        expect(sessionBudgetFor({ model: 'claude-opus-5-5', tokensLimit: 200_000, runtimeMsLimit: 3_600_000 })?.max_list_cost.amount).toBe('408');
    });

    it('refuses a model with no list price rather than leave the session uncapped', () => {
        expect(sessionBudgetFor({ model: 'claude-unpriced', tokensLimit: 1, runtimeMsLimit: 1 })).toBeNull();
        expect(sessionBudgetFor({ model: 'toString', tokensLimit: 1, runtimeMsLimit: 1 })).toBeNull();
    });
});

describe('managedAgentsRequestRefusal', () => {
    const req = (method: string, path: string, body?: unknown) => ({
        method,
        url: `https://api.anthropic.com${path}`,
        body: body === undefined ? undefined : JSON.stringify(body),
    });

    it('admits the engine\'s own calls (the positive controls)', () => {
        expect(managedAgentsRequestRefusal(req('POST', '/v1/agents', { name: 'a', tools: [{ type: 'custom', name: 'x' }] }))).toBeNull();
        expect(managedAgentsRequestRefusal(req('GET', '/v1/agents/agent_1?version=2'))).toBeNull();
        expect(managedAgentsRequestRefusal(req('POST', '/v1/environments', environmentBodyFor('c')))).toBeNull();
        expect(managedAgentsRequestRefusal(req('POST', '/v1/sessions', { agent: { type: 'agent_with_overrides', id: 'a', version: 1, system: 's' }, environment_id: 'e' }))).toBeNull();
        expect(managedAgentsRequestRefusal(req('POST', '/v1/sessions/s1/events', { events: [] }))).toBeNull();
        expect(managedAgentsRequestRefusal(req('GET', '/v1/sessions/s1/events/stream'))).toBeNull();
        expect(managedAgentsRequestRefusal(req('DELETE', '/v1/sessions/s1'))).toBeNull();
    });

    it('admits Step 5c\'s clean-up calls: an agent archive with no body, and a session list BY A RECORDED AGENT', () => {
        expect(managedAgentsRequestRefusal(req('POST', '/v1/agents/agent_1/archive'))).toBeNull();
        expect(managedAgentsRequestRefusal(req('GET', '/v1/sessions?agent_id=agent_1&include_archived=true&limit=100'))).toBeNull();
    });

    it.each([
        ['another origin', { method: 'GET', url: 'https://evil.example/v1/agents/a', body: undefined }, 'NOT_THE_PINNED_ORIGIN'],
        ['the Messages API', req('POST', '/v1/messages', {}), 'NOT_A_MANAGED_AGENTS_CALL'],
        ['a session list of the whole workspace', req('GET', '/v1/sessions?include_archived=true'), 'SESSION_LIST_NOT_BY_AGENT'],
        ['a session list with an empty agent', req('GET', '/v1/sessions?agent_id='), 'SESSION_LIST_NOT_BY_AGENT'],
        ['an agent list', req('GET', '/v1/agents'), 'NOT_A_MANAGED_AGENTS_CALL'],
        ['a session archive', req('POST', '/v1/sessions/s1/archive'), 'NOT_A_MANAGED_AGENTS_CALL'],
        ['an archive below an agent', req('POST', '/v1/agents/a/versions/archive'), 'NOT_A_MANAGED_AGENTS_CALL'],
        ['an archive read as a GET', req('GET', '/v1/agents/a/archive'), 'NOT_A_MANAGED_AGENTS_CALL'],
        ['a vault', req('POST', '/v1/vaults', {}), 'NOT_A_MANAGED_AGENTS_CALL'],
        ['an agent with a toolset', req('POST', '/v1/agents', { tools: [{ type: 'agent_toolset_20260401' }] }), 'AGENT_NOT_CUSTOM_TOOLS_ONLY'],
        ['an agent with MCP servers', req('POST', '/v1/agents/a', { mcp_servers: [{ type: 'url' }] }), 'AGENT_NOT_CUSTOM_TOOLS_ONLY'],
        ['an agent with sub-agents', req('POST', '/v1/agents', { multiagent: { type: 'multiagent_20261001' } }), 'AGENT_NOT_CUSTOM_TOOLS_ONLY'],
        ['a session with vaults', req('POST', '/v1/sessions', { agent: { type: 'agent_with_overrides', id: 'a' }, vault_ids: ['v'] }), 'SESSION_REACHES_BEYOND_SYSTEM'],
        ['a session overriding tools', req('POST', '/v1/sessions', { agent: { type: 'agent_with_overrides', id: 'a', tools: [] } }), 'SESSION_REACHES_BEYOND_SYSTEM'],
        ['a session on a bare agent id', req('POST', '/v1/sessions', { agent: 'agent_1' }), 'SESSION_REACHES_BEYOND_SYSTEM'],
        ['an environment with hosts', req('POST', '/v1/environments', { config: { type: 'cloud', networking: { type: 'limited', allowed_hosts: ['x.example'] } } }), 'ENVIRONMENT_NOT_SEALED'],
        ['an unrestricted environment', req('POST', '/v1/environments', { config: { type: 'cloud', networking: { type: 'unrestricted' } } }), 'ENVIRONMENT_NOT_SEALED'],
        ['an unreadable body', { method: 'POST', url: 'https://api.anthropic.com/v1/agents', body: '{' }, 'BODY_UNREADABLE'],
    ])('refuses %s', (_label, request, reason) => {
        expect(managedAgentsRequestRefusal(request)).toBe(reason);
    });
});
