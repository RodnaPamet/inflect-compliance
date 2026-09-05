/**
 * MCP read tools — open work items. `list_findings` (over `listFindings`) and
 * `list_tasks` (over `listTasks`, filterable). RLS + permission in the
 * usecases; MCP adds the resource-scope gate + audit.
 *
 * Findings map to the `audits:read` scope (findings are audit-domain artefacts);
 * tasks map to `tasks:read`.
 */
import { z } from 'zod';

import { listFindings } from '@/app-layer/usecases/finding';
import { listTasks } from '@/app-layer/usecases/task';
import type { RequestContext } from '@/app-layer/types';

import type { McpReadTool } from './types';

const findingsArgs = z
    .object({
        limit: z.number().int().min(1).max(200).optional(),
    })
    .strict();

export const listFindingsTool: McpReadTool<z.infer<typeof findingsArgs>> = {
    name: 'list_findings',
    description:
        "List the tenant's open findings (bounded by `limit`, default 50). " +
        'Read-only, tenant-scoped.',
    inputSchema: {
        type: 'object',
        properties: {
            limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
    },
    argsSchema: findingsArgs,
    resourceScope: { resource: 'audits', action: 'read' },
    // `GET /api/t/:slug/findings` carries no permission key — `PermissionSet`
    // has no `findings` domain, and findings are audit-domain artefacts (which
    // is why the resource scope above is `audits:read`). So the gate is the
    // domain key that DOES exist plus the shared policy the route's usecase
    // actually applies. Adding a `findings.*` domain is the right fix and is
    // deliberately not smuggled in here: it would change what every existing
    // custom role resolves to.
    authorize: {
        keys: ['audits.view'],
        policy: 'read',
        basis: 'effective',
        mirrors: 'GET /api/t/:slug/findings (getTenantCtx + assertCanRead)',
    },
    run: async (ctx: RequestContext, args) => {
        return listFindings(ctx, { take: args.limit ?? 50 });
    },
};

const tasksArgs = z
    .object({
        status: z.string().optional(),
        type: z.string().optional(),
        severity: z.string().optional(),
        priority: z.string().optional(),
        assigneeUserId: z.string().optional(),
        controlId: z.string().optional(),
        due: z.enum(['overdue', 'next7d']).optional(),
        q: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
    })
    .strict();

export const listTasksTool: McpReadTool<z.infer<typeof tasksArgs>> = {
    name: 'list_tasks',
    description:
        "List the tenant's remediation tasks, filterable by status, type, " +
        'severity, priority, assignee, control, due window (overdue/next7d), and ' +
        'free-text query. Bounded by `limit` (default 50). Read-only, tenant-scoped.',
    inputSchema: {
        type: 'object',
        properties: {
            status: { type: 'string' },
            type: { type: 'string' },
            severity: { type: 'string' },
            priority: { type: 'string' },
            assigneeUserId: { type: 'string' },
            controlId: { type: 'string' },
            due: { type: 'string', enum: ['overdue', 'next7d'] },
            q: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
    },
    argsSchema: tasksArgs,
    resourceScope: { resource: 'tasks', action: 'read' },
    // `GET /api/t/:slug/tasks` is `requirePermission('tasks.view')`.
    authorize: {
        keys: ['tasks.view'],
        basis: 'effective',
        mirrors: 'GET /api/t/:slug/tasks',
    },
    run: async (ctx: RequestContext, args) => {
        const { limit, ...filters } = args;
        return listTasks(ctx, filters as Parameters<typeof listTasks>[1], { take: limit ?? 50 });
    },
};
