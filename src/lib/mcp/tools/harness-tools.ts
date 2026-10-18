/**
 * MCP read tool — one discovered agent's facts (#3668, step 1d of the agentic
 * IAM roadmap). A thin wrapper over `getDiscoveredAgentFacts`, the read the
 * `discovered-agent-review` workflow gives its two IAM skills.
 *
 * READ-ONLY: it returns what a harness scan observed and changes nothing. RLS
 * and the permission check live in the usecase; the funnel adds the
 * resource-scope gate, the policy card and the audit row.
 *
 * ── THE KEY IS THE HARNESS READ KEY, AND NO BEARER TOKEN HOLDS IT ───────────
 *
 * `admin.agent_registry` is what every human read of harness data takes —
 * `GET …/admin/agents/harness-scans` and the harness tab on `/agents/reports`.
 * This tool takes the same key rather than a new one (no permission was invented
 * for it). `scopesToPermissions` maps no scope to that key and subtracts it from
 * `*`, so with `basis: 'effective'` an API key — and therefore a Flue run, which
 * is always started by an agent-bound key — is never offered this tool. Only a
 * signed-in member holding the key (OWNER and ADMIN, by role) reaches it,
 * through a static run of the workflow. Widening that is a
 * decision about who may read the agent inventory, recorded as open in the
 * roadmap (a view key split from `admin.agent_registry`), and it is not made
 * here by choosing a weaker key.
 *
 * This file may not import the harness ladder (`eslint.config.mjs`): the ladder
 * is report-only and the funnel's files are kept away from it.
 */
import { z } from 'zod';

import { getDiscoveredAgentFacts } from '@/app-layer/usecases/agent-harness-facts';
import type { RequestContext } from '@/app-layer/types';

import type { McpReadTool } from './types';

const getDiscoveredAgentArgs = z
    .object({
        discoveredAgentId: z.string().trim().min(1).max(256),
    })
    .strict();

export const getDiscoveredAgentTool: McpReadTool<z.infer<typeof getDiscoveredAgentArgs>> = {
    name: 'get_discovered_agent',
    description:
        'Read one discovered agent by its id: where the harness scans found it, whether the ' +
        'register holds it, the owner its source records, the latest scan and whether that ' +
        'scan read every source in full, and what the scan observed per harness criterion, ' +
        'with its evidence pointers and tools. Observations as reported, not judged; no ' +
        'level. Read-only, tenant-scoped.',
    inputSchema: {
        type: 'object',
        properties: {
            discoveredAgentId: {
                type: 'string',
                minLength: 1,
                maxLength: 256,
                description: 'The discovered agent to read.',
            },
        },
        required: ['discoveredAgentId'],
        additionalProperties: false,
    },
    argsSchema: getDiscoveredAgentArgs,
    resourceScope: { resource: 'admin', action: 'read' },
    // The human reads of the same rows — the harness-scan list and the harness
    // tab — both refuse without `admin.agent_registry`. Same key, same
    // `assertPermission`.
    authorize: {
        keys: ['admin.agent_registry'],
        basis: 'effective',
        mirrors: 'GET /api/t/:slug/admin/agents/harness-scans (listHarnessScans: admin.agent_registry)',
    },
    run: async (ctx: RequestContext, args) => getDiscoveredAgentFacts(ctx, args.discoveredAgentId),
};
