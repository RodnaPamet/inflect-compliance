/**
 * RQ3-6 — soft-delete a loss event. ADMIN-only — actuals are
 * evidence; an EDITOR write flow must not destroy them silently.
 *
 * ─── Why the route gate (#2117) ────────────────────────────────────
 *
 * "must not destroy them silently" was true of the destruction and false of
 * the REFUSAL. `deleteLossEvent` asserts `assertCanAdmin`, so an EDITOR was
 * always turned away — but a usecase assert throws a 403 and writes nothing,
 * and `AUTHZ_DENIED` comes from `requirePermission` alone. The one thing a
 * loss register needs to be able to show an auditor — who tried to remove an
 * actual, and when — was the one thing not recorded.
 *
 * `admin.manage` is the key that mirrors `assertCanAdmin`, following the
 * `assets/[id]/purge` and `evidence/bulk/delete` precedent. Not a perfect
 * mirror, and the imprecision is one-directional: the assert reads the
 * ROLE-derived `ctx.permissions.canAdmin`, the middleware the CUSTOM-ROLE-aware
 * `ctx.appPermissions.admin.manage`. They differ for exactly one caller — a
 * custom role on baseRole ADMIN/OWNER whose `permissionsJson` sets
 * `admin.manage: false` — who is now refused here rather than admitted. That
 * role revoked admin.manage on purpose, so refusing is the reading that
 * matches intent, and it is the same tightening every migrated purge route
 * already carries.
 */
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';
import { deleteLossEvent } from '@/app-layer/usecases/loss-event';

type Params = { tenantSlug: string; id: string };

export const DELETE = withApiErrorHandling(
    requirePermission<Params>('admin.manage', async (_req, { params }, ctx) => {
        await deleteLossEvent(ctx, params.id);
        return jsonResponse({ success: true });
    }),
);
