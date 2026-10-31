import { notFound } from 'next/navigation';
import { getTenantCtx } from '@/app-layer/context';
import { getAiSystem } from '@/app-layer/usecases/ai-system';
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
    } catch {
        notFound();
    }

    return (
        <AiSystemDetailClient
            system={JSON.parse(JSON.stringify(system!))}
            tenantSlug={resolved.tenantSlug}
            canWrite={ctx.permissions.canWrite}
            // The queue a conformity draft is sent to; its page reads the same predicate.
            canOpenApprovalQueue={mayReadAgentActivity(ctx.appPermissions?.admin)}
        />
    );
}
