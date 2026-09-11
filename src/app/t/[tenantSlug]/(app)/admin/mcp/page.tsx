import { Robot } from '@/components/ui/icons/nucleo';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatusBadge } from '@/components/ui/status-badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { getTenantCtx } from '@/app-layer/context';
import { listAgentCredentials } from '@/app-layer/usecases/api-keys';

export const dynamic = 'force-dynamic';

/**
 * MCP CREDENTIAL BINDING — what can act right now, and what we have switched off.
 *
 * ── WHAT THIS PAGE IS, AFTER AGENTIC UI 1/4 (#2442) ─────────────────────────
 *
 * It used to be the agentic HUB: a five-card grid pointing at the register, the
 * proposal queue, the runs view, the receipt log and quarantine, plus this
 * credential panel at the bottom. All five destinations moved under `/agents`,
 * which is a sidebar destination with its own ViewsMenu — so the grid would
 * have become a second, worse navigation for surfaces that now have a real one,
 * and every card a click that leaves a page to arrive somewhere you were
 * already one click from.
 *
 * The grid is therefore GONE rather than repointed, and the page is restated as
 * the one thing it uniquely carried: the credential panel. That is a genuinely
 * different question from every `/agents` surface. Those answer "what did an
 * agent do"; this answers "what can act right now, and what have we switched
 * off". Revocation is the operator's move during an incident, and a revocation
 * you cannot see is one nobody can confirm took effect — so the panel
 * deliberately lists revoked and expired credentials rather than filtering them
 * out.
 *
 * PROMPT 2/4 MERGES THIS PANEL INTO `/admin/api-keys`, where keys are issued.
 * When it does, this page retires with a redirect. It is NOT retired here: the
 * panel has nowhere to go yet, and a redirect to a page that does not carry the
 * content is worse than a page that does.
 *
 * The single link out is to the register, because the register is what the word
 * "bound" in this panel refers to. One link is navigation; five were a hub.
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

            {/* The one link out, and it names where the moved surfaces went.
                A reader who bookmarked this page as "the agentic hub" is told
                once, here, rather than left to rediscover the sidebar. */}
            <InlineNotice variant="info">
                {t('mcp.surfacesMoved')}{' '}
                <Link
                    id="mcp-agent-register-link"
                    href={tenantHref('/agents')}
                    className="inline-flex items-center gap-tight font-medium text-content-info hover:underline"
                >
                    <Robot className="h-4 w-4" />
                    {t('agentRegisterLink')}
                </Link>
            </InlineNotice>

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
                                    {/*
                                      * An UNSCORED agent's ceiling is
                                      * DENY_CEILING (-1) — below rung 0, so the
                                      * credential reaches nothing. Rendering
                                      * "Autonomy ceiling -1" would put a magic
                                      * number in front of an operator whose
                                      * integration has just stopped working;
                                      * the word says what the number means and
                                      * points at the fix.
                                      */}
                                    <span
                                        className="text-sm text-content-muted"
                                        data-autonomy={cred.effectiveAutonomy}
                                        data-unscored={cred.unscored ? 'true' : undefined}
                                    >
                                        {cred.unscored
                                            ? t('mcp.credentialUnassessed')
                                            : t('mcp.credentialAutonomy', {
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
