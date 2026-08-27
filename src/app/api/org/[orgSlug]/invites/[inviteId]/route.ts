/**
 * Epic D — DELETE /api/org/[orgSlug]/invites/[inviteId]
 *
 * Revoke a pending org invite. ORG_ADMIN-only. Idempotent: 404 if
 * the invite is missing OR already accepted/revoked. Audit row is
 * emitted via revokeOrgInvite in the usecase layer.
 */
import { NextRequest, NextResponse } from 'next/server';

import { withApiErrorHandling } from '@/lib/errors/api';
import { requireOrgPermission } from '@/lib/security/org-permission-middleware';
import { revokeOrgInvite } from '@/app-layer/usecases/org-invites';

interface RouteContext {
    params: Promise<{ orgSlug: string; inviteId: string }>;
}

type DeleteParams = { orgSlug: string; inviteId: string };

/**
 * Gated on `canManageMembers`. The inline check this replaces recorded nothing
 * on refusal; the gate writes an `ORG_AUTHZ_DENIED` row (#2147).
 *
 * `revokeOrgInvite` gained `assertCanManageOrgInvites` in the same diff, so
 * this is additive rather than relocating the only check.
 */
export const DELETE = withApiErrorHandling(
    requireOrgPermission<DeleteParams>('canManageMembers', async (_req, { params }, ctx) => {
        await revokeOrgInvite(ctx, { inviteId: params.inviteId });
        return NextResponse.json({ revoked: true });
    }),
);
