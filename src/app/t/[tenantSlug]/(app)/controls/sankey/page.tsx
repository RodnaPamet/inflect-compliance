/**
 * Controls — Sankey flow page (server component).
 *
 * Single-view replacement for the older multi-view traceability
 * page. Reachable from a pill button on the controls list ("Sankey")
 * — same way Dashboard / Frameworks / Install Templates are.
 *
 * Fetches the cross-entity graph server-side and hands it to the
 * Sankey client island. The graph + table views from the
 * deprecated /traceability page are gone; the Sankey is the
 * remaining surface.
 */

import { getTenantCtx } from '@/app-layer/context';
import { getTraceabilityGraph } from '@/app-layer/usecases/traceability-graph';
import { ControlsSankeyClient } from './ControlsSankeyClient';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { InlineNotice } from '@/components/ui/inline-notice';
import { getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

export default async function ControlsSankeyPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });
    // #4794 — a graph that cannot be built (a role that can see none of its
    // kinds, a failed read) used to fall through to the generic error page.
    let graph: Awaited<ReturnType<typeof getTraceabilityGraph>>;
    try {
        graph = await getTraceabilityGraph(ctx);
    } catch {
        const t = await getTranslations('controls');
        return (
            <div className="animate-fadeIn space-y-default">
                <BackAffordance />
                <InlineNotice variant="error" id="controls-sankey-error">
                    {t('sankey.loadFailed')}
                </InlineNotice>
            </div>
        );
    }

    return (
        <div className="animate-fadeIn">
            <BackAffordance />
            <ControlsSankeyClient
                initialGraph={JSON.parse(JSON.stringify(graph))}
            />
        </div>
    );
}
