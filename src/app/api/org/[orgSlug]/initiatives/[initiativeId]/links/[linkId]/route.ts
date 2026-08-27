import { NextRequest, NextResponse } from 'next/server';
import { getOrgCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requireOrgPermission } from '@/lib/security/org-permission-middleware';
import { unlinkWork } from '@/app-layer/usecases/org-security-initiative';

interface RC { params: Promise<{ orgSlug: string; initiativeId: string; linkId: string }> }

type DeleteParams = { orgSlug: string; initiativeId: string; linkId: string };

/**
 * Gated on `canConfigureDashboard`, which is what `assertWrite` in
 * org-security-initiative.ts actually reads — the dashboard flag is reused
 * for this surface. Preserved as-is rather than 'improved' here; changing
 * which flag governs initiatives is a separate decision.
 */
export const DELETE = withApiErrorHandling(
    requireOrgPermission<DeleteParams>('canConfigureDashboard', async (_req, { params }, ctx) => {
        await unlinkWork(ctx, params.linkId);
        return NextResponse.json({ ok: true });
    }),
);
