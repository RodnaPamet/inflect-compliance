/**
 * Processes page — server-component shell.
 *
 * R25 shipped this as a pure visual canvas with zero persistence.
 * R26-PR-A turns it into a real persisted surface: the server
 * fetches the tenant's process-map list at request time and hands
 * it to the client; the client owns canvas state + a Save button
 * that PUTs back to `/api/t/{slug}/processes/{id}`.
 *
 * Out-of-scope at PR-A — covered by later R26 PRs:
 *   - Richer node taxonomy (PR-B)
 *   - Proximity auto-bind (PR-C)
 *   - First-class on-edge controls + risk/asset semantics (PR-D)
 *   - Full editor UX: inspector, alignment, undo-redo (PR-E)
 *   - Polish: empty-state onboarding cues, performance (PR-F)
 */
import { ProcessesClient } from "./ProcessesClient";
import { getTenantCtx } from "@/app-layer/context";
import { listProcessMaps } from "@/app-layer/usecases/process-map";

export const dynamic = "force-dynamic";

export default async function ProcessesPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    // Server-side preload — the list is small (one row per map),
    // cheap to fetch up front. The client can refresh via
    // `GET /api/t/{slug}/processes` after each save to pick up the
    // bumped `version` + `updatedAt` without a full page reload.
    const ctx = await getTenantCtx({ tenantSlug });
    const processes = await listProcessMaps(ctx);
    // There is one canvas now, so there is nothing to resolve on the server.
    // The flag that used to be read here is gone with the renderer it chose
    // (#3079) — a page that still asked would be asking a question with one
    // possible answer.
    return (
        <ProcessesClient
            tenantSlug={tenantSlug}
            initialProcesses={processes}
            // #3472 — the canvas's inline approve/reject for a run parked on a
            // HUMAN_CHECKPOINT. Resolved HERE, on the server, from the same
            // two terms `/agents/proposals` uses: its PAGE gates on
            // `appPermissions.admin.view` before loading anything, and its
            // CLIENT takes `permissions.canWrite` for the two usecases that
            // assert it. Neither is new authority and neither is widened — a
            // viewer who cannot review the queue sees the canvas exactly as it
            // is today.
            canReviewCheckpoints={ctx.appPermissions.admin.view}
            canOperateCheckpoints={ctx.permissions.canWrite}
            // What each write behind the page takes on the server (#4640):
            // map writes `processes.edit` plus the write tier, delete and every
            // rule write the Admin tier, cancelling a stuck run the write tier.
            canEditMaps={ctx.permissions.canWrite && ctx.appPermissions.processes.edit}
            canDeleteMaps={ctx.permissions.canAdmin}
            canManageRules={ctx.permissions.canAdmin}
        />
    );
}
