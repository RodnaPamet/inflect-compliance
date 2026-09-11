import { PageHeader } from '@/components/layout/PageHeader';
import { AgentsViewsMenu } from '../AgentsViewsMenu';
import { StatusBadge } from '@/components/ui/status-badge';
import { BadgeCheck, TriangleWarning } from '@/components/ui/icons/nucleo';
import { ForbiddenPage } from '@/components/ForbiddenPage';
import { getTenantCtx } from '@/app-layer/context';
import { listReceipts } from '@/app-layer/usecases/agent-action-receipt';
import { formatDateTime } from '@/lib/format-date';
import { getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

/**
 * Agent-action receipts — the MCP activity evidence view.
 *
 * Each row is a mediator-signed (pipelock) receipt of an AI/MCP agent tool
 * decision. The green "Signature verified" badge means the Ed25519 signature was
 * verified in-app against the configured pipelock public key and the receipt is
 * linked to a hash-chained AuditLog entry; the amber badge means the signature
 * was invalid or absent — the receipt is retained + flagged, never trusted.
 *
 * ── THE GATE IS THIS PAGE'S OWN (#2438) ─────────────────────────────────────
 *
 * It used to read "Admin-gated by the parent /admin layout", and that sentence
 * was the whole gate: one `<RequirePermission resource="admin" action="view">`
 * in an ANCESTOR layout this page no longer has. Moving the file out of
 * `/admin` would have silently removed the only check on it, so the check moved
 * with it — and became narrower on the way.
 *
 * `admin.agent_registry`, not `admin.view`: the operator move after reading a
 * run of unverified receipts is to suspend or retire the agent that produced
 * them, which is the authority that key names. It is also the key the sibling
 * quarantine read is gated on in `ROUTE_PERMISSIONS`, so the two investigation
 * surfaces answer to one key rather than to two that can drift apart.
 *
 * Checked BEFORE the data load, so a refused caller never triggers the fetch.
 */
export default async function AgentReceiptsPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const tenantHref = (path: string) => `/t/${tenantSlug}${path}`;

    const ctx = await getTenantCtx({ tenantSlug });
    const t = await getTranslations('admin');
    const tAgents = await getTranslations('agents');

    if (!ctx.appPermissions.admin.agent_registry) {
        return (
            <ForbiddenPage
                title={tAgents('receipts.accessTitle')}
                message={tAgents('receipts.accessMessage')}
            />
        );
    }

    const receipts = await listReceipts(ctx, { limit: 100 });

    return (
        <div className="space-y-section animate-fadeIn">
            <PageHeader
                back={{ smart: true }}
                breadcrumbs={[
                    { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                    { label: tAgents('register.breadcrumb'), href: tenantHref('/agents') },
                    { label: t('crumb.agentReceipts') },
                ]}
                title={t('mcp.receiptsTitle')}
                description={t('mcp.receiptsPageDesc')}
                actions={
                    <AgentsViewsMenu
                        current="receipts"
                        tenantSlug={tenantSlug}
                        canReviewProposals={ctx.appPermissions.admin.view}
                        canInvestigate
                    />
                }
            />

            {receipts.length === 0 ? (
                <p className="text-sm text-content-muted">
                    {t('mcp.receiptsEmpty')}
                </p>
            ) : (
                <ul className="space-y-default">
                    {receipts.map((r) => (
                        <li
                            key={r.id}
                            className="flex flex-col gap-tight rounded-lg border border-border-subtle bg-bg-default p-4 sm:flex-row sm:items-center sm:justify-between"
                        >
                            <div className="flex flex-col gap-tight">
                                <span className="flex items-center gap-compact">
                                    <span className="font-medium text-content-emphasis">{r.toolName}</span>
                                    <StatusBadge variant="neutral" tone="subtle">
                                        {r.decisionVerdict}
                                    </StatusBadge>
                                </span>
                                <span className="text-sm text-content-muted">
                                    {r.activePolicy ? t('mcp.policyLabel', { policy: r.activePolicy }) : ''}
                                    {r.agentId ? t('mcp.agentLabel', { agent: r.agentId }) : ''}
                                    {formatDateTime(r.occurredAt)}
                                </span>
                            </div>
                            <div className="flex items-center gap-compact">
                                {r.verified ? (
                                    <StatusBadge
                                        variant="success"
                                        icon={BadgeCheck}
                                        tooltip={t('mcp.signatureVerifiedTooltip')}
                                    >
                                        {t('mcp.signatureVerified')}
                                    </StatusBadge>
                                ) : (
                                    <StatusBadge
                                        variant="warning"
                                        icon={TriangleWarning}
                                        tooltip={t('mcp.unverifiedTooltip')}
                                    >
                                        {t('mcp.unverified')}
                                    </StatusBadge>
                                )}
                                <a
                                    href={`/api/t/${tenantSlug}/agent-receipts/${r.id}/export`}
                                    className="text-sm text-content-info hover:underline"
                                >
                                    {t('mcp.export')}
                                </a>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
