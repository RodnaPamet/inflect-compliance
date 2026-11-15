/**
 * MCP read tools — risks. Thin wrappers over `listRisks` (the same usecase the
 * REST risks API calls). RLS + `assertCanRead` live in the usecase; the MCP
 * layer adds the `risks:read` resource-scope gate + audit.
 */
import { z } from 'zod';

import { listRisks } from '@/app-layer/usecases/risk';
import type { RequestContext } from '@/app-layer/types';
import { RISK_MATRIX_MAX_SCORE } from '@/lib/risk-matrix/schema';

import type { McpReadTool } from './types';

/**
 * The score filter reaches the largest score a matrix can give — 100 on a
 * 10x10 — not the 5x5 default's 25 (#5304, owner decision 2026-11-14).
 *
 * The bound is part of the advertised `inputSchema`, so it is part of the
 * tool's `schemaHash`: raising it withholds `list_risks` from every tenant that
 * pinned the old definition until a person re-approves it. The owner accepted
 * that, and nothing keeps an old pin valid.
 */
const listRisksArgs = z
    .object({
        status: z.string().optional(),
        category: z.string().optional(),
        ownerUserId: z.string().optional(),
        q: z.string().optional(),
        scoreMin: z.number().int().min(1).max(RISK_MATRIX_MAX_SCORE).optional(),
        scoreMax: z.number().int().min(1).max(RISK_MATRIX_MAX_SCORE).optional(),
        limit: z.number().int().min(1).max(200).optional(),
    })
    .strict();

export const listRisksTool: McpReadTool<z.infer<typeof listRisksArgs>> = {
    name: 'list_risks',
    description:
        "List the tenant's risks, filterable by status, category, owner, free-text " +
        'query, and inherent-score range. Bounded by `limit` (default 50). ' +
        'Returns each risk with owner and task progress. Read-only, tenant-scoped.',
    inputSchema: {
        type: 'object',
        properties: {
            status: { type: 'string', description: 'Risk status filter (e.g. OPEN, MITIGATING).' },
            category: { type: 'string' },
            ownerUserId: { type: 'string' },
            q: { type: 'string', description: 'Free-text search over title/description.' },
            scoreMin: { type: 'integer', minimum: 1, maximum: RISK_MATRIX_MAX_SCORE },
            scoreMax: { type: 'integer', minimum: 1, maximum: RISK_MATRIX_MAX_SCORE },
            limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max rows (default 50).' },
        },
        additionalProperties: false,
    },
    argsSchema: listRisksArgs,
    resourceScope: { resource: 'risks', action: 'read' },
    // The human `GET /api/t/:slug/risks` is wrapped in
    // `requirePermission('risks.view')`. Same key, same `assertPermission`.
    authorize: {
        keys: ['risks.view'],
        basis: 'effective',
        mirrors: 'GET /api/t/:slug/risks',
    },
    run: async (ctx: RequestContext, args) => {
        const { limit, ...filters } = args;
        return listRisks(ctx, filters as Parameters<typeof listRisks>[1], { take: limit ?? 50 });
    },
};
