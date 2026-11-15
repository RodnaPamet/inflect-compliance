/**
 * MCP read tools — open work items. `list_findings` (over `listFindings`) and
 * `list_tasks` (over `listTasks`, filterable). RLS + permission in the
 * usecases; MCP adds the resource-scope gate + audit.
 *
 * Findings map to the `findings:read` scope, the findings register's own domain
 * since #4535 (#5409 moved this tool off `audits:read`); tasks map to
 * `tasks:read`.
 */
import { FindingStatus } from '@prisma/client';
import { z } from 'zod';

import { listFindings } from '@/app-layer/usecases/finding';
import { listTasks } from '@/app-layer/usecases/task';
import type { RequestContext } from '@/app-layer/types';

import type { McpReadTool } from './types';

/**
 * What "open" means for `list_findings`: every status but CLOSED, the reading
 * the rest of the product uses (`status: { not: 'CLOSED' }` in the snapshot,
 * the automation runner and the calendar). The tool's description has always
 * promised open findings, and the workflows that read it report the count as
 * "open findings" — but it passed no filter, so it returned the newest N
 * findings of any status, closed ones included, and left out older open ones
 * past the bound (#5304). Filtered here rather than by a new argument, so the
 * tool's advertised definition, and every tenant's pin of it, is unchanged.
 */
export const OPEN_FINDING_STATUSES: readonly FindingStatus[] = Object.values(FindingStatus).filter(
    (s) => s !== FindingStatus.CLOSED,
);

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
    resourceScope: { resource: 'findings', action: 'read' },
    // The key `GET /api/t/:slug/findings` takes (#4535), plus the coarse read
    // its usecase still asserts. `basis: 'effective'`, as for every read tool:
    // the principal must hold `findings.view` AND so must the key, which it
    // does through `findings:read`. Until #5409 this asked `audits.view` and
    // `audits:read`; a data migration gave `findings:read` to every live key
    // holding `audits:read` or `audits:*` before the move, and again in the
    // deploy that made it, so no key minted for this tool was cut off.
    authorize: {
        keys: ['findings.view'],
        policy: 'read',
        basis: 'effective',
        mirrors: 'GET /api/t/:slug/findings (requirePermission findings.view + assertCanRead)',
    },
    run: async (ctx: RequestContext, args) => {
        return listFindings(ctx, { take: args.limit ?? 50 }, { status: OPEN_FINDING_STATUSES.join(',') });
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
