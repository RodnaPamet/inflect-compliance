import { SquareCheck, Workflow, BadgeCheck, Robot } from '@/components/ui/icons/nucleo';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { getTenantCtx } from '@/app-layer/context';
import { listAgentCredentials } from '@/app-layer/usecases/api-keys';

export const dynamic = 'force-dynamic';

/**
 * MCP admin hub — the discovery surface for the agent (Model Context Protocol)
 * human-in-the-loop tools. Both destinations already existed as standalone
 * pages but had no nav affordance; this admin page wires them in one place:
 *   - Agent proposals — the propose-not-commit approval queue (an external
 *     agent's MCP `propose_*` writes land here as PENDING for a human to
 *     approve or reject).
 *   - Agent runs — orchestrator observability: start / watch / resume / abort
 *     the tenant's agentic workflow runs.
 * Admin-gated by the parent /admin layout.
 *
 * It also carries the CREDENTIAL panel, and that placement is the point. Every
 * other agent surface here answers "what did an agent do"; this answers "what
 * can act right now, and what have we switched off". Revocation is the
 * operator's move during an incident, and a revocation you cannot see is one
 * nobody can confirm took effect — so the panel deliberately lists revoked and
 * expired credentials rather than filtering them out.
 *
 * The panel shows the EFFECTIVE autonomy ceiling — `min(key max, agent level)`,
 * computed by the same function the tool funnel uses — rather than the key's own
 * number, because reading the key's number as the answer is the exact
 * misunderstanding the ceiling exists to prevent.
 */
export default async function McpAdminPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const resolved = await params;
    const { tenantSlug } = resolved;
    const tenantHref = (path: string) => `/t/${tenantSlug}${path}`;
    const t = await getTranslations('admin');
    const ctx = await getTenantCtx(resolved);
    const credentials = await listAgentCredentials(ctx);

    const stateVariant = {
        live: 'success',
        revoked: 'error',
        expired: 'warning',
    } as const;
    const stateLabel = {
        live: t('mcp.credentialLive'),
        revoked: t('mcp.credentialRevoked'),
        expired: t('mcp.credentialExpired'),
    } as const;

    const cards = [
        {
            // First card on purpose: the register is what decides whether an
            // agent may act at all, so it sits ahead of the surfaces that
            // review what agents have already proposed.
            href: tenantHref('/admin/agents'),
            id: 'mcp-agent-register-card',
            icon: Robot,
            title: t('agentRegistry.title'),
            description: t('agentRegistry.intro'),
        },
        {
            href: tenantHref('/agent-proposals'),
            id: 'mcp-agent-proposals-card',
            icon: SquareCheck,
            title: t('mcp.proposalsTitle'),
            description: t('mcp.proposalsDesc'),
        },
        {
            href: tenantHref('/agent-runs'),
            id: 'mcp-agent-runs-card',
            icon: Workflow,
            title: t('mcp.runsTitle'),
            description: t('mcp.runsDesc'),
        },
        {
            href: tenantHref('/admin/mcp/agent-receipts'),
            id: 'mcp-agent-receipts-card',
            icon: BadgeCheck,
            title: t('mcp.receiptsTitle'),
            description: t('mcp.receiptsDesc'),
        },
    ];

    return (
        <div className="space-y-section animate-fadeIn">
            <PageHeader
                back={{ smart: true }}
                breadcrumbs={[
                    { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                    { label: t('crumb.admin'), href: tenantHref('/admin') },
                    { label: t('crumb.mcp') },
                ]}
                title={t('mcp.title')}
                description={t('mcp.description')}
            />

            <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                {cards.map((card) => {
                    const Icon = card.icon;
                    return (
                        <Link
                            key={card.id}
                            id={card.id}
                            href={card.href}
                            className="group flex flex-col gap-tight rounded-lg border border-border-subtle bg-bg-default p-4 transition-colors hover:border-border-emphasis"
                        >
                            <span className="flex items-center gap-compact">
                                <span className="flex h-8 w-8 items-center justify-center rounded-md border border-border-subtle bg-bg-subtle text-content-muted group-hover:text-content-emphasis">
                                    <Icon className="h-4 w-4" />
                                </span>
                                <span className="font-medium text-content-emphasis">{card.title}</span>
                            </span>
                            <span className="text-sm text-content-muted">{card.description}</span>
                        </Link>
                    );
                })}
            </div>

            <section id="mcp-agent-credentials" className="space-y-default">
                <div className="space-y-tight">
                    <Heading level={2}>{t('mcp.credentialsTitle')}</Heading>
                    <p className="text-sm text-content-muted">{t('mcp.credentialsDesc')}</p>
                </div>

                {credentials.length === 0 ? (
                    <p
                        id="mcp-agent-credentials-empty"
                        className="rounded-lg border border-border-subtle bg-bg-default p-4 text-sm text-content-muted"
                    >
                        {t('mcp.credentialsEmpty')}
                    </p>
                ) : (
                    <ul className="space-y-default">
                        {credentials.map((cred) => (
                            <li
                                key={cred.id}
                                id={`mcp-agent-credential-${cred.id}`}
                                className="flex flex-col gap-tight rounded-lg border border-border-subtle bg-bg-default p-4 sm:flex-row sm:items-center sm:justify-between"
                            >
                                <span className="flex flex-col gap-tight">
                                    <span className="font-medium text-content-emphasis">
                                        {cred.name}
                                    </span>
                                    <span className="text-sm text-content-muted">
                                        {cred.keyPrefix}… ·{' '}
                                        {cred.agent?.name ?? t('mcp.credentialNoAgent')}
                                    </span>
                                </span>
                                <span className="flex items-center gap-compact">
                                    <span
                                        className="text-sm text-content-muted"
                                        data-autonomy={cred.effectiveAutonomy}
                                    >
                                        {t('mcp.credentialAutonomy', {
                                            level: cred.effectiveAutonomy,
                                        })}
                                    </span>
                                    <StatusBadge
                                        variant={stateVariant[cred.state]}
                                        data-state={cred.state}
                                    >
                                        {stateLabel[cred.state]}
                                    </StatusBadge>
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}
