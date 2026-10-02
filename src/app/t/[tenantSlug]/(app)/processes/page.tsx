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
        <ProcessesClient tenantSlug={tenantSlug} initialProcesses={processes} />
    );
}
