import Link from 'next/link';

import { PageHeader } from '@/components/layout/PageHeader';
import { AgentsViewsMenu } from '../AgentsViewsMenu';
import { ReceiptVerificationBadge } from './ReceiptVerificationBadge';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { ForbiddenPage } from '@/components/ForbiddenPage';
import { mayReadAgentActivity } from '@/lib/permissions';
import { getTenantCtx } from '@/app-layer/context';
import { readReceiptPage } from '@/app-layer/usecases/agent-action-receipt';
import { oversightReadsFor } from '@/app-layer/usecases/agent-oversight-settings';
import { formatDateTime } from '@inflect/ui/lib/format-date';
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
 *
 * ── WHAT A ROW SAYS, AND WHAT IT DOES NOT (#4897) ───────────────────────────
 *
 * The agent shown is the registered agent the SUBMITTING key is bound to —
 * our binding — never the receipt's own `agent_id`, which the sender chooses.
 * That claim appears only on a verified receipt, labelled as the receipt's.
 * The mediator's verdict is worded when it is one this page knows, and quoted
 * as the mediator's word when it is not. The page reads one past its window,
 * so a cut list says so, and narrows to unverified receipts — the ones that
 * need somebody — or to one tool.
 */

/** The mediator's verdict, by what it means here; anything else is quoted. */
const VERDICT_KEY: Readonly<Record<string, 'ALLOWED' | 'BLOCKED' | 'FLAGGED' | 'REDACTED' | 'NOT_STATED'>> = {
    allow: 'ALLOWED',
    allowed: 'ALLOWED',
    permit: 'ALLOWED',
    pass: 'ALLOWED',
    deny: 'BLOCKED',
    denied: 'BLOCKED',
    block: 'BLOCKED',
    blocked: 'BLOCKED',
    reject: 'BLOCKED',
    warn: 'FLAGGED',
    warning: 'FLAGGED',
    flag: 'FLAGGED',
    flagged: 'FLAGGED',
    redact: 'REDACTED',
    redacted: 'REDACTED',
    unknown: 'NOT_STATED',
};

const VERDICT_VARIANT = {
    ALLOWED: 'success',
    BLOCKED: 'error',
    FLAGGED: 'warning',
    REDACTED: 'info',
    NOT_STATED: 'neutral',
} as const;

/** `list_risks` and `listRisks` both read "List risks": the name is the tool's own. */
function toolInWords(name: string): string {
    const words = name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_\-.]+/g, ' ')
        .trim()
        .toLowerCase();
    return words ? words[0].toUpperCase() + words.slice(1) : name;
}

const PROVENANCE_KEY: Readonly<Record<string, string>> = {
    'inflect:builtin': 'BUILTIN',
    unattested: 'UNATTESTED',
    'pin-moved-since-action': 'PIN_MOVED',
};

export default async function AgentReceiptsPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams?: Promise<{ verified?: string; tool?: string }>;
}) {
    const { tenantSlug } = await params;
    const tenantHref = (path: string) => `/t/${tenantSlug}${path}`;

    const ctx = await getTenantCtx({ tenantSlug });
    const t = await getTranslations('admin');
    const tAgents = await getTranslations('agents');

    // The register key, or the inventory view key while an owner lets Auditors
    // read receipts (`agent-oversight-settings.ts`, #4897). The list and export
    // API apply the same rule, in the usecase.
    const reads = await oversightReadsFor(ctx);
    if (!reads.receipts) {
        return (
            <ForbiddenPage
                title={tAgents('oversightAccess.title')}
                message={tAgents('oversightAccess.message')}
            />
        );
    }

    const query = (await searchParams) ?? {};
    const verified = query.verified === 'yes' ? true : query.verified === 'no' ? false : undefined;
    const tool = query.tool || undefined;
    const { rows: receipts, capped } = await readReceiptPage(ctx, { verified, toolName: tool });

    const base = tenantHref('/agents/receipts');
    const hrefWith = (change: { verified?: string | null; tool?: string | null }) => {
        const next = { verified: query.verified ?? null, tool: tool ?? null, ...change };
        const qs = new URLSearchParams(
            Object.entries(next).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''),
        ).toString();
        return qs ? `${base}?${qs}` : base;
    };
    const narrowed = verified !== undefined || Boolean(tool);

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
                        canReviewProposals={mayReadAgentActivity(ctx.appPermissions.admin)}
                        canCompose={ctx.appPermissions.admin.view}
                        canInvestigate={ctx.appPermissions.admin.agent_registry}
                        oversightReads={reads}
                        canSetOrphanPass={Boolean(ctx.appPermissions?.admin?.tenant_lifecycle)}
                    />
                }
            />

            <div className="flex flex-wrap items-center gap-default" data-testid="receipts-filters">
                <ToggleGroup
                    ariaLabel={t('mcp.receiptsFilterAria')}
                    options={[
                        { value: 'all', label: t('mcp.receiptsFilterAll'), href: hrefWith({ verified: null }) },
                        { value: 'no', label: t('mcp.receiptsFilterUnverified'), href: hrefWith({ verified: 'no' }) },
                        { value: 'yes', label: t('mcp.receiptsFilterVerified'), href: hrefWith({ verified: 'yes' }) },
                    ]}
                    selected={query.verified === 'yes' || query.verified === 'no' ? query.verified : 'all'}
                />
                {tool && (
                    <span className="text-sm text-content-muted" data-testid="receipts-tool-filter">
                        {t('mcp.receiptsFilteredByTool', { tool: toolInWords(tool) })}
                    </span>
                )}
                {narrowed && (
                    <Link href={base} className="text-sm text-content-info hover:underline" data-testid="receipts-show-all">
                        {t('mcp.receiptsShowAll')}
                    </Link>
                )}
            </div>

            {capped && (
                <InlineNotice variant="info" data-testid="receipts-capped">
                    {t('mcp.receiptsCapped', { count: capped })}
                </InlineNotice>
            )}

            {receipts.length === 0 ? (
                <EmptyState
                    title={narrowed ? t('mcp.receiptsEmptyNarrowedTitle') : t('mcp.receiptsEmptyTitle')}
                    description={narrowed ? t('mcp.receiptsEmptyNarrowedDesc') : t('mcp.receiptsEmpty')}
                />
            ) : (
                <>
                    <p className="text-sm text-content-muted" data-testid="receipts-count">
                        {capped
                            ? t('mcp.receiptsCountCapped', { count: receipts.length })
                            : t('mcp.receiptsCount', { count: receipts.length })}
                    </p>
                    <ul className="space-y-default">
                        {receipts.map((r) => {
                            const verdictKey = VERDICT_KEY[r.decisionVerdict.trim().toLowerCase()];
                            const provenanceKey = r.toolProvenance ? PROVENANCE_KEY[r.toolProvenance] : undefined;
                            return (
                                <li
                                    key={r.id}
                                    className="flex flex-col gap-tight rounded-lg border border-border-subtle bg-bg-default p-4"
                                    data-testid={`receipt-${r.id}`}
                                >
                                    <div className="flex flex-col gap-tight sm:flex-row sm:items-center sm:justify-between">
                                        <div className="flex flex-col gap-tight">
                                            <span className="flex flex-wrap items-center gap-compact">
                                                <span className="font-medium text-content-emphasis">
                                                    {r.connectionName
                                                        ? t('mcp.receiptToolOn', {
                                                              tool: toolInWords(r.toolName),
                                                              connection: r.connectionName,
                                                          })
                                                        : toolInWords(r.toolName)}
                                                </span>
                                                <StatusBadge variant={verdictKey ? VERDICT_VARIANT[verdictKey] : 'neutral'} tone="subtle">
                                                    {verdictKey
                                                        ? t(`mcp.receiptVerdict.${verdictKey}`)
                                                        : t('mcp.receiptVerdictOther', { verdict: r.decisionVerdict })}
                                                </StatusBadge>
                                            </span>
                                            <span className="text-sm text-content-muted">
                                                {r.activePolicy ? t('mcp.policyLabel', { policy: r.activePolicy }) : ''}
                                                {formatDateTime(r.occurredAt)}
                                            </span>
                                            <span className="flex flex-wrap gap-default text-sm">
                                                {r.agent ? (
                                                    <Link
                                                        href={tenantHref(`/agents/${r.agent.id}`)}
                                                        className="text-content-info hover:underline"
                                                        data-testid={`receipt-agent-${r.id}`}
                                                    >
                                                        {t('mcp.receiptAgent', { agent: r.agent.name })}
                                                    </Link>
                                                ) : (
                                                    <span className="text-content-muted">{t('mcp.receiptNoAgent')}</span>
                                                )}
                                                {r.claimedAgentId && (
                                                    <span className="text-content-muted" data-testid={`receipt-claim-${r.id}`}>
                                                        {t('mcp.receiptClaimedAgent', { agent: r.claimedAgentId })}
                                                    </span>
                                                )}
                                                {tool !== r.toolName && (
                                                    <Link
                                                        href={hrefWith({ tool: r.toolName })}
                                                        className="text-content-info hover:underline"
                                                    >
                                                        {t('mcp.receiptOnlyThisTool')}
                                                    </Link>
                                                )}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-compact">
                                            <ReceiptVerificationBadge
                                                verified={r.verified}
                                                verifiedLabel={t('mcp.signatureVerified')}
                                                verifiedTooltip={t('mcp.signatureVerifiedTooltip')}
                                                unverifiedLabel={t('mcp.unverified')}
                                                unverifiedTooltip={t('mcp.unverifiedTooltip')}
                                            />
                                            <a
                                                href={`/api/t/${tenantSlug}/agent-receipts/${r.id}/export`}
                                                download={`agent-receipt-${r.id}.json`}
                                                className="text-sm text-content-info hover:underline"
                                                data-testid={`receipt-export-${r.id}`}
                                            >
                                                {t('mcp.export')}
                                            </a>
                                        </div>
                                    </div>
                                    {/* Where the receipt sits in the record (#4897): the
                                        audit entry a verified one is chained to, and
                                        which tool description was in force. */}
                                    <details className="text-xs text-content-muted" data-testid={`receipt-evidence-${r.id}`}>
                                        <summary className="cursor-pointer">{t('mcp.receiptEvidence')}</summary>
                                        <dl className="mt-tight grid grid-cols-1 gap-tight sm:grid-cols-2">
                                            <div>
                                                <dt className="font-medium">{t('mcp.receiptAuditEntry')}</dt>
                                                <dd>
                                                    {r.auditLogId ? (
                                                        <code>{r.auditLogId}</code>
                                                    ) : (
                                                        t('mcp.receiptAuditEntryNone')
                                                    )}
                                                </dd>
                                            </div>
                                            <div>
                                                <dt className="font-medium">{t('mcp.receiptProvenance')}</dt>
                                                <dd>
                                                    {provenanceKey
                                                        ? t(`mcp.receiptProvenanceValue.${provenanceKey}`, {
                                                              revision: r.toolManifestRevision ?? 0,
                                                          })
                                                        : t('mcp.receiptProvenanceValue.NONE')}
                                                </dd>
                                            </div>
                                        </dl>
                                    </details>
                                </li>
                            );
                        })}
                    </ul>
                </>
            )}
        </div>
    );
}
