/**
 * MCP read tools — frameworks & coverage.
 *   - `find_coverage_gaps` → `computeCoverage` for a framework, surfacing the
 *     requirements with no mapped control (the "where are my gaps" answer).
 *   - `get_framework_status` → `computeCoverage` summary for one framework, OR
 *     the installable-framework catalogue when no key is given.
 * RLS + `assertCanViewFrameworks` live in the usecases; MCP adds the
 * `frameworks:read` gate + audit.
 */
import { z } from 'zod';

import { computeCoverage } from '@/app-layer/usecases/framework/coverage';
import { listInstallableFrameworks } from '@/app-layer/usecases/framework/catalog';
import type { RequestContext } from '@/app-layer/types';

import type { McpReadTool } from './types';

const gapsArgs = z
    .object({
        frameworkKey: z.string().min(1),
        version: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
    })
    .strict();

export const findCoverageGapsTool: McpReadTool<z.infer<typeof gapsArgs>> = {
    name: 'find_coverage_gaps',
    description:
        'For a given framework, return the requirements with NO mapped control ' +
        '(coverage gaps), plus the coverage summary. Bounded by `limit` (default ' +
        '100 unmapped requirements). Read-only, tenant-scoped.',
    inputSchema: {
        type: 'object',
        properties: {
            frameworkKey: { type: 'string', description: 'Framework key, e.g. ISO27001, NIST-SSDF.' },
            version: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
        required: ['frameworkKey'],
        additionalProperties: false,
    },
    argsSchema: gapsArgs,
    resourceScope: { resource: 'frameworks', action: 'read' },
    // `computeCoverage` gates on `assertCanViewFrameworks`, which reads
    // `appPermissions.frameworks.view` — the same flag, named as the key.
    authorize: {
        keys: ['frameworks.view'],
        basis: 'effective',
        mirrors: 'GET /api/t/:slug/frameworks/coverage',
    },
    run: async (ctx: RequestContext, args) => {
        const coverage = await computeCoverage(ctx, args.frameworkKey, args.version);
        const cap = args.limit ?? 100;
        return {
            framework: coverage.framework,
            summary: { total: coverage.total, mapped: coverage.mapped, unmapped: coverage.unmapped, coveragePercent: coverage.coveragePercent },
            unmappedRequirements: coverage.unmappedRequirements.slice(0, cap),
            unmappedTruncated: coverage.unmappedRequirements.length > cap,
        };
    },
};

const statusArgs = z
    .object({
        frameworkKey: z.string().optional(),
        version: z.string().optional(),
    })
    .strict();

export const getFrameworkStatusTool: McpReadTool<z.infer<typeof statusArgs>> = {
    name: 'get_framework_status',
    description:
        'Per-framework readout: with `frameworkKey`, the coverage summary + ' +
        'section breakdown for that framework; without it, the catalogue of ' +
        'installable frameworks (key, name, requirement/control counts). ' +
        'Read-only, tenant-scoped.',
    inputSchema: {
        type: 'object',
        properties: {
            frameworkKey: { type: 'string' },
            version: { type: 'string' },
        },
        additionalProperties: false,
    },
    argsSchema: statusArgs,
    resourceScope: { resource: 'frameworks', action: 'read' },
    authorize: {
        keys: ['frameworks.view'],
        basis: 'effective',
        mirrors: 'GET /api/t/:slug/frameworks',
    },
    run: async (ctx: RequestContext, args) => {
        if (!args.frameworkKey) {
            return { frameworks: await listInstallableFrameworks(ctx) };
        }
        const coverage = await computeCoverage(ctx, args.frameworkKey, args.version);
        return {
            framework: coverage.framework,
            summary: { total: coverage.total, mapped: coverage.mapped, unmapped: coverage.unmapped, coveragePercent: coverage.coveragePercent },
            bySection: coverage.bySection,
        };
    },
};
