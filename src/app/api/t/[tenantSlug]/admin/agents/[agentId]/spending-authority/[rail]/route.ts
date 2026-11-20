/**
 * `/api/t/:slug/admin/agents/:agentId/spending-authority/:rail` — one envelope
 * (Agent Pay Phase 1; #5333).
 *
 * PATCH  — NARROW it, by one person: the body is the whole envelope as it
 *          should read after. Refused `NOT_A_NARROWING`, naming the fields,
 *          when any field would widen; that is a declaration (POST on the
 *          parent route), which a second person reviews.
 * DELETE — WITHDRAW it, by one person. Taking authority away is never the
 *          move to refuse; a withdrawn envelope comes back only as a new
 *          declaration a second person reviews.
 *
 * The rail in the path names the envelope; a PATCH body naming another rail is
 * a 400, never a write to a different envelope than the URL says. Gated as
 * the parent route, for its reason.
 */
import { NextRequest } from 'next/server';

import {
    narrowAgentSpendingAuthority,
    withdrawAgentSpendingAuthority,
} from '@/app-layer/usecases/agent-spending-authority';
import { withApiErrorHandling } from '@/lib/errors/api';
import { ValidationError } from '@/lib/errors/types';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; agentId: string; rail: string };

export const PATCH = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (req: NextRequest, { params }, ctx) => {
            const { agentId, rail } = await params;
            const body: unknown = await req.json();
            const bodyRail = body && typeof body === 'object' ? (body as { rail?: unknown }).rail : undefined;
            if (bodyRail !== rail) {
                throw new ValidationError('The envelope names a different rail than the address', {
                    reason: 'RAIL_MISMATCH',
                });
            }
            return jsonResponse(await narrowAgentSpendingAuthority(ctx, agentId, body));
        },
    ),
);

export const DELETE = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (_req: NextRequest, { params }, ctx) => {
            const { agentId, rail } = await params;
            return jsonResponse(await withdrawAgentSpendingAuthority(ctx, agentId, rail));
        },
    ),
);
