/**
 * `/api/t/:slug/admin/agents/:agentId/spending-authority/:rail/review` — the
 * second pair of eyes on a declared envelope (Agent Pay Phase 1.2; #5333).
 *
 * POST `{ declaredAt }` — REVIEW the declaration the reviewer read, named by
 * its `declaredAt`, so an envelope re-declared while they were reading is
 * refused `DECLARATION_CHANGED` rather than approved unread. A signed-in
 * person only — never an API key, an agent or a job — and never the declarer
 * or the agent's owner: refused by the writer and, for the declarer and the
 * owner, by a CHECK. Gated as the parent route, for its reason.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';

import { reviewAgentSpendingAuthority } from '@/app-layer/usecases/agent-spending-authority';
import { withApiErrorHandling } from '@/lib/errors/api';
import { ValidationError } from '@/lib/errors/types';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; agentId: string; rail: string };

const ReviewSchema = z.object({ declaredAt: z.string().datetime() }).strict();

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (req: NextRequest, { params }, ctx) => {
            const { agentId, rail } = await params;
            const parsed = ReviewSchema.safeParse(await req.json());
            if (!parsed.success) throw new ValidationError('Invalid review', parsed.error.issues);
            return jsonResponse(await reviewAgentSpendingAuthority(ctx, agentId, rail, parsed.data));
        },
    ),
);
