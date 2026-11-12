/**
 * `/t/:slug/processes/agents/:agentId/flow` — the agent-flow canvas editor
 * (Phases 3 and 4 of `docs/ai-architecture/langflow.md`).
 *
 * Inside the processes segment (D-L2-3): its layout answers `notFound()` where
 * the tenant does not have the process-canvas module, and the licensed editor
 * ships only in this segment's chunk.
 *
 * Every read is a usecase's, under that usecase's gate, and the profile gate
 * comes first: `getAgentProfile` answers 404 when agent profiles are off for
 * the workspace (before it asks for any permission) and 403 without
 * `admin.agent_registry`. So an EDITOR, or anybody without the register key,
 * opens nothing here, and there is nothing here to save with: the editor's one
 * write is the existing version route, which asks the same key again.
 */
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { projectAgentForCanvas } from '@/app-layer/usecases/agent-canvas-projection';
import { getAgentProfile, listFlowSubagentOptions } from '@/app-layer/usecases/agent-profiles';
import { previewProfileRunMessage } from '@/app-layer/usecases/agent-profile-runs';
import { ForbiddenPage } from '@/components/ForbiddenPage';
import { AppError, NotFoundError } from '@/lib/errors/types';
import { mayReadAgentInventory } from '@/lib/permissions';

import { AgentFlowClient } from './AgentFlowClient';

export const dynamic = 'force-dynamic';

export default async function AgentFlowPage({ params }: { params: Promise<{ tenantSlug: string; agentId: string }> }) {
    const { tenantSlug, agentId } = await params;
    const ctx = await getTenantCtx({ tenantSlug });
    const t = await getTranslations('agentFlow');

    if (!mayReadAgentInventory(ctx.appPermissions.admin)) {
        return <ForbiddenPage title={t('forbiddenTitle')} message={t('forbiddenMessage')} />;
    }

    let view: Awaited<ReturnType<typeof getAgentProfile>>;
    let projection: Awaited<ReturnType<typeof projectAgentForCanvas>>;
    try {
        view = await getAgentProfile(ctx, agentId);
        // The projection of the version the editor opens: its tool states are
        // `offerToolSet`'s, against the run that version can have.
        projection = await projectAgentForCanvas(ctx, agentId, { versionId: view.versions[0]?.id });
    } catch (err) {
        if (err instanceof NotFoundError) notFound();
        // Profiles off for this workspace: the surface does not exist.
        if (err instanceof AppError && err.status === 404) notFound();
        if (err instanceof AppError && err.status === 403) {
            return <ForbiddenPage title={t('forbiddenTitle')} message={t('forbiddenMessage')} />;
        }
        throw err;
    }

    const opened = view.versions[0] ?? null;
    if (!view.profile || !opened) {
        return <AgentFlowClient tenantSlug={tenantSlug} agentId={agentId} agentName={projection.agent.name} editor={null} />;
    }

    const current = view.profile.currentApprovedVersion;
    const inForceRow = current !== null && current !== opened.version ? view.versions.find((v) => v.version === current) : undefined;
    const [subagentOptions, preview] = await Promise.all([
        listFlowSubagentOptions(ctx, agentId),
        previewProfileRunMessage(ctx, agentId, opened.version),
    ]);

    return (
        <AgentFlowClient
            tenantSlug={tenantSlug}
            agentId={agentId}
            agentName={projection.agent.name}
            editor={{
                tenantSlug,
                agentId,
                profileId: view.profile.profileId,
                opened: {
                    version: opened.version,
                    status: opened.status,
                    flow: opened.flow,
                    instructions: opened.instructions,
                    skillRefs: opened.skillRefs,
                    modelTier: opened.modelTier,
                    effort: opened.effort,
                    maxTurns: opened.maxTurns,
                    outputKind: opened.outputKind,
                    allowedTriggers: opened.allowedTriggers,
                },
                inForce: inForceRow ? { version: inForceRow.version, flow: inForceRow.flow } : null,
                grants: view.options.tools,
                subagentOptions,
                preview,
                toolStates: projection.profile.state === 'SHOWN' ? projection.profile.tools : null,
            }}
        />
    );
}
