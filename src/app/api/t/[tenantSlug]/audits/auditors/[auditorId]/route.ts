import { revokeAuditorAccount } from '@/app-layer/usecases/audit-readiness';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type AuditorParams = { tenantSlug: string; auditorId: string };

// PR-O — account-level revoke: move an AuditorAccount to REVOKED and drop all
// its pack access (distinct from the per-pack DELETE on .../auditors/access).
//
// #2117 — the gate is what makes the refusal AUDITABLE. `revokeAuditorAccount`
// already called `assertCanManageAuditors`, which refuses everyone below ADMIN
// correctly and records nothing: `AUTHZ_DENIED` is written by
// `requirePermission` and by nothing else. The assert stays — it protects
// non-HTTP callers.
//
// `admin.manage`, not `audits.manage`, and the distinction is not cosmetic.
// `assertCanManageAuditors` reads `ctx.role`, which a custom role does NOT
// change; `audits.manage` is precisely the flag a tenant would grant an
// EDITOR-based "audit coordinator" custom role. Gating on it would admit that
// caller at the middleware and let the usecase throw them out where nothing is
// written — recreating the exact hole this closes. `admin.manage` is the key
// every other role-tier assert in this issue was mirrored onto.
export const DELETE = withApiErrorHandling(
    requirePermission<AuditorParams>('admin.manage', async (_req, { params }, ctx) =>
        jsonResponse(await revokeAuditorAccount(ctx, params.auditorId)),
    ),
);
