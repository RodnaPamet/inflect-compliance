/**
 * `/t/:slug/processes/agents/:agentId` — one agent on the process canvas,
 * read-only (Phase 2 of `docs/ai-architecture/langflow.md`).
 *
 * Inside the processes segment on purpose (D-L2-3): its layout answers
 * `notFound()` where the tenant does not have the process-canvas module, and
 * the licensed editor ships only in this segment's chunk, so the module guard
 * needs no exception.
 *
 * The page reads exactly what the agent page reads first — the inventory read
 * — and refuses the same way before anything renders. Every further layer is
 * gated by the usecase that owns it (`projectAgentForCanvas`).
 *
 * `?version=<id>` draws that profile version. `?version=<id>&compare=<id>` is
 * the approver's diff (Phase 2.4): both versions are projected by the same
 * usecase, under the same gates, and compared by the pure `buildAgentViewDiff`.
 * A comparison that cannot be drawn (no profile layer for this reader, or a
 * version that is not this agent's) is said on the page, never drawn as "no
 * changes".
 */
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { projectAgentForCanvas } from '@/app-layer/usecases/agent-canvas-projection';
import { ForbiddenPage } from '@/components/ForbiddenPage';
import { NotFoundError } from '@/lib/errors/types';
import { mayReadAgentInventory } from '@/lib/permissions';
import { buildAgentViewDiff } from '@/lib/processes/agent-view/agent-canvas-diff';

import { AgentCanvasClient } from './AgentCanvasClient';

export const dynamic = 'force-dynamic';

export default async function AgentCanvasPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string; agentId: string }>;
    searchParams: Promise<{ version?: string | string[]; compare?: string | string[] }>;
}) {
    const { tenantSlug, agentId } = await params;
    const { version, compare } = await searchParams;
    const one = (v: string | string[] | undefined) => (typeof v === 'string' && v.length > 0 ? v : undefined);
    const versionId = one(version);
    // A diff needs the version under review named: comparing against the
    // default would draw whatever happens to be in force against itself.
    const compareId = versionId !== undefined ? one(compare) : undefined;
    const ctx = await getTenantCtx({ tenantSlug });

    if (!mayReadAgentInventory(ctx.appPermissions.admin)) {
        const t = await getTranslations('agentCanvas');
        return <ForbiddenPage title={t('forbiddenTitle')} message={t('forbiddenMessage')} />;
    }

    let projection: Awaited<ReturnType<typeof projectAgentForCanvas>>;
    let base: Awaited<ReturnType<typeof projectAgentForCanvas>> | null = null;
    try {
        [projection, base] = await Promise.all([
            projectAgentForCanvas(ctx, agentId, { versionId }),
            compareId !== undefined ? projectAgentForCanvas(ctx, agentId, { versionId: compareId }) : null,
        ]);
    } catch (err) {
        // Narrowed to the register's 404, as on the agent page: a refusal or a
        // read failure is not "no such agent", and goes to the error boundary.
        if (err instanceof NotFoundError) notFound();
        throw err;
    }

    const diff = base !== null ? buildAgentViewDiff(base, projection) : null;

    return (
        <AgentCanvasClient
            tenantSlug={tenantSlug}
            projection={projection}
            diff={diff}
            compareUnavailable={base !== null && diff === null}
        />
    );
}
