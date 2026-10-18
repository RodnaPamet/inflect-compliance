/**
 * MCP read tool — `get_agent_recertification_evidence` (step 3a, #3674).
 *
 * The one READ step of the `agent-recertification-pack` workflow: for one page
 * of an AGENT campaign's subjects, every section a reviewer pack holds, read
 * from stored rows by `readAgentRecertificationEvidence`, which performs no
 * write of any kind. The workflow that calls it has no PROPOSE step; the
 * narrowings it plans are persisted by the campaign usecase, which re-derives
 * them from this tool's recorded output before it writes one.
 *
 * A registered agent calling it never reads its own subject (roadmap rule 8);
 * see `readAgentRecertificationEvidence`.
 *
 * Gated as the human pack read is: `access_reviews.view` (the `access_reviews`
 * read scope for a key), and inside the usecase the campaign's reviewer or a
 * holder of `admin.agent_registry`, because a pack is register data and every
 * role holds the view key.
 */
import { z } from 'zod';

import { readAgentRecertificationEvidence } from '@/app-layer/usecases/agent-recertification-evidence';
import type { RequestContext } from '@/app-layer/types';
import { AGENT_RECERTIFICATION_EVIDENCE_TOOL } from '@/lib/agentic/agent-recertification';

import type { McpReadTool } from './types';

const evidenceArgs = z
    .object({
        accessReviewId: z.string().min(1).max(64),
        page: z.number().int().min(0).max(1000).optional(),
        /** Read exactly this agent's subject — the preparer's own pack. */
        onlyAgentId: z.string().min(1).max(64).optional(),
    })
    .strict();

export const getAgentRecertificationEvidenceTool: McpReadTool<z.infer<typeof evidenceArgs>> = {
    name: AGENT_RECERTIFICATION_EVIDENCE_TOOL,
    description:
        'For one page of an AGENT access review\'s subjects, the reviewer-pack evidence ' +
        'for each registered agent: its grants with grantor and date, which granted ' +
        'tools it called in the 90 days before the campaign, its proposals and their ' +
        'outcomes per grant, its policy-card versions since its last campaign, its ' +
        'time-bounded grants and whether each expired on time, guard flags, breaker ' +
        'trips, kill engagements, and its harness level and drift. Read-only.',
    inputSchema: {
        type: 'object',
        properties: {
            accessReviewId: { type: 'string' },
            page: { type: 'integer', minimum: 0, maximum: 1000 },
            onlyAgentId: { type: 'string' },
        },
        required: ['accessReviewId'],
        additionalProperties: false,
    },
    argsSchema: evidenceArgs,
    resourceScope: { resource: 'access_reviews', action: 'read' },
    authorize: {
        keys: ['access_reviews.view'],
        basis: 'effective',
        mirrors:
            'GET /api/t/:slug/access-reviews/:reviewId/agent-packs (requirePermission ' +
            'access_reviews.view; the usecase narrows to the reviewer or admin.agent_registry)',
    },
    run: async (ctx: RequestContext, args) =>
        readAgentRecertificationEvidence(ctx, args.accessReviewId, args.page ?? 0, args.onlyAgentId ?? null),
};
