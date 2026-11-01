import { Robot } from '@inflect/ui/components/ui/icons/nucleo';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatusBadge } from '@/components/ui/status-badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { listAgentCredentials } from '@/app-layer/usecases/api-keys';
import { AUTONOMY_REQUIRED_BY_CAPABILITY } from '@/lib/agentic/autonomy-ceiling';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { gateAdminPage } from '../_lib/admin-page-gate';

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
 * Two links out: to the register, which is what the word "bound" in this panel
 * refers to (and each entry links its own agent), and to API keys, where a key
 * is revoked — the act this page exists to confirm (#4879).
 *
 * The panel shows the EFFECTIVE autonomy ceiling — `min(key max, agent level)`,
 * computed by the same function the tool funnel uses — rather than the key's own
 * number, because reading the key's number as the answer is the exact
 * misunderstanding the ceiling exists to prevent.
 *
 * And it shows whether the key can act at all (`agentCredentialStanding`): a
 * key bound to a suspended or killed agent is STOPPED, not "Live", and a key
 * that reaches the agent tools with no agent's controls says so (#4879).
 *
 * Gated here, before the read (`admin.view` + `canAdmin`, which
 * `listAgentCredentials` asserts), so a refused caller gets the forbidden page
 * rather than the read's error. See `../_lib/admin-page-requirements.ts`.
 */
type Credential = Awaited<ReturnType<typeof listAgentCredentials>>['credentials'][number];

/**
 * The capability a rung opens, read off the live mapping the tool boundary
 * uses (`AUTONOMY_REQUIRED_BY_CAPABILITY`), so the word moves when a rung does.
 * Rungs above orchestrate grant nothing more than orchestrate.
 */
type RungWord = 'suggest' | keyof typeof AUTONOMY_REQUIRED_BY_CAPABILITY;
const RUNGS_HIGHEST_FIRST = (
    Object.entries(AUTONOMY_REQUIRED_BY_CAPABILITY) as Array<
        [keyof typeof AUTONOMY_REQUIRED_BY_CAPABILITY, number]
    >
).sort((a, b) => b[1] - a[1]);

function rungWord(level: number): RungWord {
    for (const [capability, rung] of RUNGS_HIGHEST_FIRST) {
        if (level >= rung) return capability;
    }
    return 'suggest';
}

const BADGE: Record<Credential['standing']['kind'], 'success' | 'error' | 'warning'> = {
    governed: 'success',
    ungoverned: 'warning',
    stopped: 'error',
    inactive: 'error',
};

export default async function McpAdminPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const gate = await gateAdminPage('/admin/mcp', params);
    if (!gate.allowed) return gate.forbidden;
    const { ctx, tenantSlug } = gate;
    const tenantHref = (path: string) => `/t/${tenantSlug}${path}`;
    const t = await getTranslations('admin');
    const { credentials, truncated } = await listAgentCredentials(ctx);

    const badgeLabel = (cred: Credential): string => {
        switch (cred.standing.kind) {
            case 'governed':
                return t('mcp.credentialLive');
            case 'ungoverned':
                return t('mcp.credentialUngoverned');
            case 'stopped':
                return t('mcp.credentialStopped');
            case 'inactive':
                return cred.state === 'expired'
                    ? t('mcp.credentialExpired')
                    : t('mcp.credentialRevoked');
        }
    };
    const standingLine = (cred: Credential): string | null => {
        const { standing } = cred;
        if (standing.kind === 'stopped') return t(`mcp.stoppedReason.${standing.reason}`);
        if (standing.kind === 'ungoverned') return t(`mcp.ungovernedReason.${standing.reason}`);
        return null;
    };
    const ceilingLine = (cred: Credential): string | null => {
        // A key that cannot act has no ceiling worth reading.
        if (cred.standing.kind !== 'governed' && cred.standing.kind !== 'ungoverned') return null;
        return t('mcp.credentialAutonomy', {
            level: cred.effectiveAutonomy,
            rung: t(`mcp.ceilingRung.${rungWord(cred.effectiveAutonomy)}`),
        });
    };
    const datesLine = (cred: Credential): string => {
        const parts: string[] = [];
        if (cred.state === 'revoked' && cred.revokedAt) {
            parts.push(t('mcp.revokedOn', { date: formatDateTime(cred.revokedAt) }));
        } else if (cred.state === 'expired' && cred.expiresAt) {
            parts.push(t('mcp.expiredOn', { date: formatDateTime(cred.expiresAt) }));
        } else if (cred.expiresAt) {
            parts.push(t('mcp.expiresOn', { date: formatDateTime(cred.expiresAt) }));
        }
        parts.push(
            cred.lastUsedAt
                ? t('mcp.lastUsed', { date: formatDateTime(cred.lastUsedAt) })
                : t('mcp.neverUsed'),
        );
        return parts.join(' · ');
    };

    const apiKeysLink = (
        <Link
            id="mcp-api-keys-link"
            href={tenantHref('/admin/api-keys')}
            className="font-medium text-content-info hover:underline"
        >
            {t('mcp.manageKeys')}
        </Link>
    );

    return (
        <div className="space-y-section animate-fadeIn">
            <PageHeader
                back={{ smart: true }}
                breadcrumbs={[
                    { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                    { label: t('crumb.admin'), href: tenantHref('/admin') },
                    { label: t('crumb.agentCredentials') },
                ]}
                title={t('mcp.title')}
                description={t('mcp.description')}
            />

            {/* The link to where the moved surfaces went. A reader who
                bookmarked this page as "the agentic hub" is told once, here,
                rather than left to rediscover the sidebar. */}
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
                    <p className="text-sm text-content-muted">
                        {t('mcp.credentialsDesc')} {apiKeysLink}
                    </p>
                </div>

                {truncated && (
                    <InlineNotice variant="warning" id="mcp-agent-credentials-truncated">
                        {t('mcp.truncated', { count: credentials.length })}
                    </InlineNotice>
                )}

                {credentials.length === 0 ? (
                    <p
                        id="mcp-agent-credentials-empty"
                        className="rounded-lg border border-border-subtle bg-bg-default p-4 text-sm text-content-muted"
                    >
                        {t('mcp.credentialsEmpty')} {apiKeysLink}
                    </p>
                ) : (
                    <ul className="space-y-default">
                        {credentials.map((cred) => {
                            const standing = standingLine(cred);
                            const ceiling = ceilingLine(cred);
                            return (
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
                                            {cred.agent ? (
                                                <Link
                                                    href={tenantHref(`/agents/${cred.agent.id}`)}
                                                    className="font-medium text-content-info hover:underline"
                                                >
                                                    {cred.agent.name}
                                                </Link>
                                            ) : (
                                                t('mcp.credentialNoAgent')
                                            )}
                                        </span>
                                        <span className="text-xs text-content-muted">
                                            {datesLine(cred)}
                                        </span>
                                    </span>
                                    <span className="flex flex-col items-start gap-tight sm:items-end">
                                        <StatusBadge
                                            variant={BADGE[cred.standing.kind]}
                                            data-state={cred.state}
                                            data-standing={cred.standing.kind}
                                        >
                                            {badgeLabel(cred)}
                                        </StatusBadge>
                                        {standing && (
                                            <span
                                                className="text-sm text-content-muted"
                                                data-reason={
                                                    'reason' in cred.standing
                                                        ? cred.standing.reason
                                                        : undefined
                                                }
                                            >
                                                {standing}
                                            </span>
                                        )}
                                        {/*
                                          * An UNSCORED agent's ceiling is
                                          * DENY_CEILING (-1) — below rung 0, so
                                          * the credential reaches nothing. That
                                          * is a STOP (`UNASSESSED`), so it never
                                          * reaches this line as a number.
                                          */}
                                        {ceiling && (
                                            <span
                                                className="text-sm text-content-muted"
                                                data-autonomy={cred.effectiveAutonomy}
                                            >
                                                {ceiling}
                                            </span>
                                        )}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>
        </div>
    );
}
