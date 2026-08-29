/**
 * DELETE /api/t/[tenantSlug]/tests/runs/[runId]/evidence/[linkId] — Unlink evidence from a test run
 *
 * #2117 — the link row is HARD-deleted (its frozen sha256Hash goes with it),
 * so a refused attempt is exactly what a reviewer looks for when a control
 * test's evidence goes missing. `unlinkEvidenceFromRun` already called
 * `assertCanLinkTestEvidence`, which refuses correctly and records NOTHING:
 * `AUTHZ_DENIED` is written by `requirePermission` and by nothing else. The
 * assert stays — it protects non-HTTP callers.
 *
 * `tests.execute` is the strongest form of "mirror the assert":
 * `assertCanLinkTestEvidence` reads `ctx.appPermissions.tests.execute`
 * DIRECTLY — the same object and the same flag `requirePermission` evaluates —
 * so the admitted caller set is provably unchanged, custom roles included, and
 * only the recording changes.
 */
import { unlinkEvidenceFromRun } from '@/app-layer/usecases/control';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type RunEvidenceParams = { tenantSlug: string; runId: string; linkId: string };

export const DELETE = withApiErrorHandling(
    requirePermission<RunEvidenceParams>('tests.execute', async (_req, { params }, ctx) => {
        // Scope the unlink to THIS run — the link must belong to the run in the URL.
        await unlinkEvidenceFromRun(ctx, params.runId, params.linkId);
        return jsonResponse({ ok: true });
    }),
);
