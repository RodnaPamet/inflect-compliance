import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { DEFAULT_AUDITOR_NAME } from '@/app-layer/usecases/audit-pilot-setup';
import { ForbiddenPage } from '@/components/ForbiddenPage';
import { AUDIT_PROCEDURE_LIBRARY_V1, LIBRARY_V1_PROCEDURE_IDS } from '@/lib/agentic/audit-procedure-library';
import { mayReadAgentActivity, mayReadAgentInventory } from '@/lib/permissions';

import { AgentsViewsMenu } from '../AgentsViewsMenu';
import { AuditPilotClient } from './AuditPilotClient';

export const dynamic = 'force-dynamic';

/**
 * THE AUDIT PILOT SET-UP (#3807) — Server Component.
 *
 * `/agents/audit-pilot`: the second-line owner registers the pilot auditor
 * and schedules its five procedure plans, as themselves, through
 * `POST /admin/agents/audit-pilot`. Gated on `admin.agent_registry`, the
 * route's key; the usecase asks everything else (a second-line person who may
 * own an auditor). The procedure list is read here because the library module
 * is server-only, and handed down as plain data.
 */
export default async function AuditPilotPage({ params }: { params: Promise<{ tenantSlug: string }> }) {
    const resolved = await params;
    const ctx = await getTenantCtx(resolved);
    const admin = ctx.appPermissions?.admin;

    if (!admin?.agent_registry) {
        const t = await getTranslations('agents');
        return <ForbiddenPage title={t('auditPilot.accessTitle')} message={t('auditPilot.accessMessage')} />;
    }

    return (
        <div className="space-y-section">
            <div className="flex justify-end">
                <AgentsViewsMenu
                    current="audit-pilot"
                    tenantSlug={resolved.tenantSlug}
                    canReviewProposals={mayReadAgentActivity(admin)}
                    canCompose={Boolean(admin.view)}
                    canInvestigate
                    canReadReports={mayReadAgentInventory(admin)}
                    canSetOrphanPass={Boolean(admin.tenant_lifecycle)}
                />
            </div>
            <AuditPilotClient
                defaultAgentName={DEFAULT_AUDITOR_NAME}
                procedures={LIBRARY_V1_PROCEDURE_IDS.map((id) => ({ id, title: AUDIT_PROCEDURE_LIBRARY_V1[id].title }))}
            />
        </div>
    );
}
