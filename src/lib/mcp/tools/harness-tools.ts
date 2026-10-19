/**
 * MCP read tool — one discovered agent's facts (#3668, step 1d of the agentic
 * IAM roadmap). A thin wrapper over `getDiscoveredAgentFacts`, the read the
 * `discovered-agent-review` workflow gives its two IAM skills.
 *
 * READ-ONLY: it returns what a harness scan observed and changes nothing. RLS
 * and the permission check live in the usecase; the funnel adds the
 * resource-scope gate, the policy card and the audit row.
 *
 * ── THE KEY IS THE INVENTORY VIEW KEY, BY A NAMED SCOPE (#3710) ────────────
 *
 * `admin.agent_registry_view` is the key every read of the agent inventory
 * takes — the register, `GET …/admin/agents/harness-scans`, the harness tab on
 * `/agents/reports`, and this tool. The usecase admits `admin.agent_registry`
 * too, so a person who could read harness data before the split still can; the
 * TOOL names only the view key, because a bearer token never carries the
 * register key (`*` subtracts it and no scope maps to it), so with
 * `basis: 'effective'` the second key could never be satisfied here anyway.
 *
 * A credential reaches it by holding `admin:agent_registry_view` — by NAME:
 * neither `*` nor `admin:*` carries it (`WILDCARD_EXCLUDED_ACTIONS`), which is
 * why `resourceScope` names that group rather than `admin:read`. `admin:read`
 * is `admin.view`, the admin console, which this tool has no reason to demand.
 * The usual funnel applies on top: `mcp:read` at the endpoint, the agent's
 * deny-by-default grant list (`admin.agent_tool_exposure`), its policy card and
 * autonomy ceiling, and the payload labelled `THIRD_PARTY_INGESTED`
 * (`MCP_TOOL_CORPUS`). A Flue run — always started by an agent-bound key — is
 * offered the tool only when its key carries the scope AND its agent holds the
 * grant.
 *
 * What it returns includes `DiscoveredAgent.ownerRef`, a directory identifier
 * of a person, and the harness scanner DPIA names a model, through this tool,
 * as a reader of it (`docs/agentic-harness-scanner-dpia.md`).
 *
 * This file may not import the harness ladder (`eslint.config.mjs`): the ladder
 * is report-only and the funnel's files are kept away from it.
 */
import { z } from 'zod';

import { getDiscoveredAgentFacts } from '@/app-layer/usecases/agent-harness-facts';
import { readHarnessRegisterForScanner } from '@/app-layer/usecases/agent-harness-register-read';
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
    // The NAMED group, not `admin:read` — see the header.
    resourceScope: { resource: 'admin', action: 'agent_registry_view' },
    // The human reads of the same rows — the harness-scan list and the harness
    // tab — admit the view key. Same key, same `assertPermission`.
    authorize: {
        keys: ['admin.agent_registry_view'],
        basis: 'effective',
        mirrors: 'GET /api/t/:slug/admin/agents/harness-scans (listHarnessScans: admin.agent_registry_view)',
    },
    run: async (ctx: RequestContext, args) => getDiscoveredAgentFacts(ctx, args.discoveredAgentId),
};

// ─── The register, for a harness scanner (#3686, part c) ────────────────────
//
// The read behind the scanner's `inflect-register` source: the live registered
// agents, their own API keys by id, the flags the register decides, and the
// service principals a person confirmed as each (owner decisions 3, 4 and 7 on
// #3686, 2026-10-19). The scanner calls this one tool on its own tenant's
// `/api/mcp` and no other (DPIA condition 2, as amended).
//
// THE KEY IS THE INGEST KEY. `resourceScope` names `admin:harness_ingest`, the
// scope a scanner's API key carries, and `authorize` names
// `admin.agent_harness_ingest`, the key the ingest route takes. The key that may
// post a report may read what the report's register source carries, and nothing
// else: the payload holds ids, statuses, dates and flags — no name, no free text.

const noArgs = z.object({}).strict();

export const getHarnessRegisterTool: McpReadTool<z.infer<typeof noArgs>> = {
    name: 'get_harness_register',
    description:
        'For a harness scanner: the live registered agents of this tenant, as the ' +
        "scanner's inflect-register source reports them. Per agent: its id, status and " +
        'owner user id; whether its axes are declared, its risk tier is scored and fresh, ' +
        'and a policy card is in force; its live API keys by id and date; and the service ' +
        'principals a person confirmed as it. No names and no free text. Read-only, tenant-scoped.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    argsSchema: noArgs,
    resourceScope: { resource: 'admin', action: 'harness_ingest' },
    authorize: {
        keys: ['admin.agent_harness_ingest'],
        basis: 'effective',
        mirrors: 'POST /api/t/:slug/admin/agents/harness-scans (ingestHarnessReport: admin.agent_harness_ingest)',
    },
    run: async (ctx: RequestContext) => readHarnessRegisterForScanner(ctx),
};
