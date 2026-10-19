/**
 * MCP read tool — one period's audit workpapers (#3749). A thin wrapper over
 * `listAuditWorkpapersForPeriod`, the read the auditor narrative workflow gives
 * the `iam-audit-procedures` skill.
 *
 * READ-ONLY: it returns what the auditor agent's workpapers record and changes
 * nothing. RLS and the permission check live in the usecase; the funnel adds
 * the resource-scope gate, the policy card and the audit row.
 *
 * ── THE KEY IS THE WORKPAPER VIEW KEY, BY A NAMED SCOPE ────────────────────
 *
 * Reading workpapers takes `audits.manage` (step 0e): a workpaper lists
 * exceptions about named people's access. `audits.workpaper_view` is the read
 * half of it (owner decision 5 on #3749), and the TOOL names only the view key:
 * a bearer token reaches it through the named scope `audits:workpaper_view`
 * alone. `audits:read` is every role's `audits.view`, which does not reach a
 * workpaper, and `audits:write` would let the auditor's key manage, freeze and
 * share audits. Neither `*` nor `audits:*` carries the view key
 * (`WILDCARD_EXCLUDED_ACTIONS`). A person holding `audits.manage` holds the
 * view key with it, and a run the scheduled job starts reads with the agent
 * owner's own permissions.
 *
 * The usual funnel applies on top: `mcp:read` at the endpoint, the agent's
 * deny-by-default grant list, its policy card and autonomy ceiling. It is an
 * auditor's read tool (`AUDITOR_TOOL_REMIT` holds every read tool), and the
 * payload is labelled as the workpapers' own provenance (`MCP_TOOL_CORPUS`).
 */
import { z } from 'zod';

import { listAuditWorkpapersForPeriod } from '@/app-layer/usecases/audit-workpaper';
import { PERIOD_LABEL } from '@/lib/agentic/audit-workpaper';
import { MAX_WORKPAPERS_PER_PERIOD_READ } from '@/lib/agentic/audit-workpaper-view';
import type { RequestContext } from '@/app-layer/types';

import type { McpReadTool } from './types';

const listAuditWorkpapersArgs = z
    .object({
        periodLabel: z.string().trim().regex(PERIOD_LABEL),
        limit: z.number().int().min(1).max(MAX_WORKPAPERS_PER_PERIOD_READ).optional(),
    })
    .strict();

export const listAuditWorkpapersTool: McpReadTool<z.infer<typeof listAuditWorkpapersArgs>> = {
    name: 'list_audit_workpapers',
    description:
        "List one period's audit workpapers: per workpaper the procedure, the population as " +
        'defined with its count and digest, the sample size, the attributes tested, the outcome ' +
        'counts, the exceptions by code with the first ones in full, and the conclusion with its ' +
        'basis. Codes, identifiers and counts; no person. Oldest first, bounded by `limit` ' +
        `(default and most ${MAX_WORKPAPERS_PER_PERIOD_READ}), with a truncated flag. ` +
        'Read-only, tenant-scoped.',
    inputSchema: {
        type: 'object',
        properties: {
            periodLabel: {
                type: 'string',
                pattern: PERIOD_LABEL.source,
                description: 'The period, YYYY-MM for a month or YYYY-Qn for a quarter.',
            },
            limit: { type: 'integer', minimum: 1, maximum: MAX_WORKPAPERS_PER_PERIOD_READ },
        },
        required: ['periodLabel'],
        additionalProperties: false,
    },
    argsSchema: listAuditWorkpapersArgs,
    // The NAMED group, not `audits:read` or `audits:write` — see the header.
    resourceScope: { resource: 'audits', action: 'workpaper_view' },
    authorize: {
        keys: ['audits.workpaper_view'],
        basis: 'effective',
        mirrors:
            'No human route lists workpapers; the usecase listAuditWorkpapersForPeriod admits ' +
            'audits.manage or audits.workpaper_view, the same gate as listAuditWorkpapers',
    },
    run: async (ctx: RequestContext, args) => listAuditWorkpapersForPeriod(ctx, args.periodLabel, args.limit),
};
