import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { ForbiddenPage } from '@/components/ForbiddenPage';
import { mayReadAgentActivity, mayReadAgentInventory } from '@/lib/permissions';

import { AgentsViewsMenu } from '../AgentsViewsMenu';
import { OwnerOrphanPassClient } from './OwnerOrphanPassClient';

export const dynamic = 'force-dynamic';

/**
 * THE OWNER-ORPHAN PASS (#3807) — Server Component.
 *
 * `/agents/owner-orphan-pass`, reached from the agents "Views" menu. Gated on
 * `admin.tenant_lifecycle`, the key the route takes: the mode decides whether
 * a scheduled job stops agents unattended, which is OWNER authority (the
 * permission table of `docs/agentic-iam-roadmap.md`). Refused here as well as
 * at the route, so a caller without the key gets the ForbiddenPage and no
 * request starts.
 */
export default async function OwnerOrphanPassPage({ params }: { params: Promise<{ tenantSlug: string }> }) {
    const resolved = await params;
    const ctx = await getTenantCtx(resolved);
    const admin = ctx.appPermissions?.admin;

    if (!admin?.tenant_lifecycle) {
        const t = await getTranslations('agents');
        return <ForbiddenPage title={t('orphanPass.accessTitle')} message={t('orphanPass.accessMessage')} />;
    }

    return (
        <div className="space-y-section">
            <div className="flex justify-end">
                <AgentsViewsMenu
                    current="owner-orphan-pass"
                    tenantSlug={resolved.tenantSlug}
                    canReviewProposals={mayReadAgentActivity(admin)}
                    canCompose={Boolean(admin.view)}
                    canInvestigate={Boolean(admin.agent_registry)}
                    canReadReports={mayReadAgentInventory(admin)}
                    canSetOrphanPass
                />
            </div>
            <OwnerOrphanPassClient />
        </div>
    );
}
