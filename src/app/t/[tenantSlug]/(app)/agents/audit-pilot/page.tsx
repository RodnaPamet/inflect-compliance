import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { oversightReadsFor } from '@/app-layer/usecases/agent-oversight-settings';
import { DEFAULT_AUDITOR_NAME, readPilotOwnerLineOfDefence } from '@/app-layer/usecases/audit-pilot-setup';
import { meetsAgentGovernanceWrite } from '@/app-layer/policies/agent-governance.policies';
import { ForbiddenPage } from '@/components/ForbiddenPage';
import { AUDIT_PROCEDURE_LIBRARY_V1, LIBRARY_V1_PROCEDURE_IDS } from '@/lib/agentic/audit-procedure-library';
import { mayReadAgentActivity, mayReadAgentInventory } from '@/lib/permissions';

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
 *
 * The page also reads whether THIS viewer could set the pilot up (#4904), so a
 * member who lacks a permission or the second-line marking is told so before
 * the dry run rather than by its refusal. The views menu is handed to the
 * client to sit in the page header.
 */
export default async function AuditPilotPage({ params }: { params: Promise<{ tenantSlug: string }> }) {
    const resolved = await params;
    const ctx = await getTenantCtx(resolved);
    const admin = ctx.appPermissions?.admin;

    if (!admin?.agent_registry) {
        const t = await getTranslations('agents');
        return <ForbiddenPage title={t('auditPilot.accessTitle')} message={t('auditPilot.accessMessage')} />;
    }

    // Whether THIS viewer could set the pilot up, so the page says so before
    // the dry run (#4904). The permission half is the set-up's own check,
    // asked here rather than in a usecase because the tool-exposure key may be
    // read outside the admin API only by the page that renders the affordance.
    // The set-up asks every one of these again; this decides nothing.
    const missingPermissions = [
        meetsAgentGovernanceWrite(ctx, 'agent_registry') ? null : 'admin.agent_registry',
        meetsAgentGovernanceWrite(ctx, 'agent_tool_exposure') ? null : 'admin.agent_tool_exposure',
        ctx.appPermissions.tests.create ? null : 'tests.create',
    ].filter((k): k is string => k !== null);
    const [lineOfDefence, oversightReads] = await Promise.all([readPilotOwnerLineOfDefence(ctx), oversightReadsFor(ctx)]);
    const readiness = {
        missingPermissions,
        lineOfDefence,
        ready: missingPermissions.length === 0 && lineOfDefence === 'SECOND',
    };

    return (
        <AuditPilotClient
            defaultAgentName={DEFAULT_AUDITOR_NAME}
            procedures={LIBRARY_V1_PROCEDURE_IDS.map((id) => ({ id, title: AUDIT_PROCEDURE_LIBRARY_V1[id].title }))}
            readiness={readiness}
            menu={{
                tenantSlug: resolved.tenantSlug,
                canReviewProposals: mayReadAgentActivity(admin),
                canCompose: Boolean(admin.view),
                canInvestigate: true,
                canReadReports: mayReadAgentInventory(admin),
                canSetOrphanPass: Boolean(admin.tenant_lifecycle),
                oversightReads,
            }}
        />
    );
}
