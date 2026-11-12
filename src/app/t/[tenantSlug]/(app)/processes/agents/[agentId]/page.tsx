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
 */
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { projectAgentForCanvas } from '@/app-layer/usecases/agent-canvas-projection';
import { ForbiddenPage } from '@/components/ForbiddenPage';
import { NotFoundError } from '@/lib/errors/types';
import { mayReadAgentInventory } from '@/lib/permissions';

import { AgentCanvasClient } from './AgentCanvasClient';

export const dynamic = 'force-dynamic';

export default async function AgentCanvasPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string; agentId: string }>;
    searchParams: Promise<{ version?: string | string[] }>;
}) {
    const { tenantSlug, agentId } = await params;
    const { version } = await searchParams;
    const ctx = await getTenantCtx({ tenantSlug });

    if (!mayReadAgentInventory(ctx.appPermissions.admin)) {
        const t = await getTranslations('agentCanvas');
        return <ForbiddenPage title={t('forbiddenTitle')} message={t('forbiddenMessage')} />;
    }

    let projection: Awaited<ReturnType<typeof projectAgentForCanvas>>;
    try {
        projection = await projectAgentForCanvas(ctx, agentId, {
            versionId: typeof version === 'string' && version.length > 0 ? version : undefined,
        });
    } catch (err) {
        // Narrowed to the register's 404, as on the agent page: a refusal or a
        // read failure is not "no such agent", and goes to the error boundary.
        if (err instanceof NotFoundError) notFound();
        throw err;
    }

    return <AgentCanvasClient tenantSlug={tenantSlug} projection={projection} />;
}
