import { notFound } from 'next/navigation';
import { getTenantCtx } from '@/app-layer/context';
import { getAiSystem } from '@/app-layer/usecases/ai-system';
import { listConformityDrafts } from '@/app-layer/usecases/ai-system-conformity';
import { AppError } from '@/lib/errors/types';
import { mayReadAgentActivity } from '@/lib/permissions';
import { AiSystemDetailClient, type AiSystemDetail } from './AiSystemDetailClient';

export const dynamic = 'force-dynamic';

/**
 * AI system detail — classification basis, linked obligations, and (for
 * HIGH-risk systems) conformity-artifact draft generation.
 */
export default async function AiSystemDetailPage({
    params,
}: {
    params: Promise<{ tenantSlug: string; systemId: string }>;
}) {
    const resolved = await params;
    const ctx = await getTenantCtx({ tenantSlug: resolved.tenantSlug });
    let system: AiSystemDetail;
    try {
        system = (await getAiSystem(ctx, resolved.systemId)) as unknown as AiSystemDetail;
    } catch (e) {
        // #4777 — only a missing system is "not found". A refusal or a
        // database error used to be reported as a 404 too; it now reaches the
        // error boundary as what it is.
        if (e instanceof AppError && e.status === 404) notFound();
        throw e;
    }
    // #4777 — the conformity drafts already queued, so a reload remembers them.
    const drafts = system.riskTier === 'HIGH' ? await listConformityDrafts(ctx, system.id) : [];

    return (
        <AiSystemDetailClient
            system={JSON.parse(JSON.stringify(system!))}
            drafts={JSON.parse(JSON.stringify(drafts))}
            tenantSlug={resolved.tenantSlug}
            canWrite={ctx.permissions.canWrite}
            // The queue a conformity draft is sent to; its page reads the same predicate.
            canOpenApprovalQueue={mayReadAgentActivity(ctx.appPermissions?.admin)}
        />
    );
}
