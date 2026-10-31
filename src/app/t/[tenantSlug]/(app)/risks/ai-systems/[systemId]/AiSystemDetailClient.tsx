'use client';

/**
 * AI system detail — shows the EU AI Act classification basis, the linked
 * AI-Act / ISO 42001 obligations, and (for HIGH-risk systems) buttons to
 * generate draft conformity artifacts. Generation is propose-not-commit: it
 * queues a proposal for human review; nothing is auto-published.
 *
 * A PROVISIONAL entry (UNCLASSIFIED) offers "Classify" to a caller who may
 * write (`canWrite`, the classify usecase's own `assertCanWrite`), which opens
 * the questionnaire answered in full (#3712). The dialog is loaded on demand:
 * only an unclassified entry ever opens it.
 *
 * The approval-queue link after a draft is queued is shown only to a viewer
 * who may read agent proposals (`canOpenApprovalQueue`, the queue page's own
 * `mayReadAgentActivity`). Generating needs only `canWrite`, so an Editor can
 * queue a draft and would otherwise be linked to a page that refuses them;
 * they are told where an approved draft lands instead (#4638).
 */
import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { StatusBadge } from '@/components/ui/status-badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Button } from '@/components/ui/button';
import { EntityPrevNextNav } from '@/components/ui/entity-prev-next-nav';
import { useEntityListIds } from '@/lib/hooks/use-entity-list-ids';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { aiActTierTone, isKnownAiActTier } from '@/lib/eu-ai-act/tier-display';
import { apiErrorMessage } from '@/lib/api-error';
import { formatDate } from '@inflect/ui/lib/format-date';

const ClassifyAiSystemModal = dynamic(() => import('./ClassifyAiSystemModal').then((m) => m.ClassifyAiSystemModal));

export interface AiSystemDetail {
    id: string;
    name: string;
    provider: string | null;
    deploymentRole: string;
    riskTier: string;
    status: string;
    purpose: string | null;
    useContext: string | null;
    classificationClauseId: string | null;
    classificationRationale: string | null;
    requirementLinks: Array<{
        id: string;
        requirement: {
            id: string;
            code: string;
            title: string;
            framework: { key: string; name: string };
        };
    }>;
}

/** #4777 — a conformity draft already queued for this system (no draft text). */
export interface ConformityDraft {
    proposalId: string;
    docType: string;
    status: string;
    createdAt: string;
}

const SYSTEM_STATUSES = new Set(['ACTIVE', 'RETIRED']);
const DRAFT_STATUSES = new Set(['PENDING', 'ACCEPTED', 'EDITED', 'REJECTED', 'EXPIRED', 'QUARANTINED']);

interface Props {
    system: AiSystemDetail;
    /** The drafts already queued for this system, newest first. */
    drafts?: ConformityDraft[];
    tenantSlug: string;
    canWrite: boolean;
    /** May this viewer open the agent proposals queue a draft is sent to? */
    canOpenApprovalQueue: boolean;
}

/** The conformity documents a HIGH-risk system can draft, labelled by `aiSystems.detail.docTypes.*`. */
const DOC_TYPES = [
    'ANNEX_IV_TECHNICAL_DOCUMENTATION',
    'ART_9_RISK_MANAGEMENT',
    'ANNEX_V_DECLARATION_OF_CONFORMITY',
] as const;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-0.5 border-b border-border-subtle py-2 last:border-0 sm:flex-row sm:items-baseline sm:justify-between">
            <span className="text-xs uppercase tracking-wide text-content-subtle">{label}</span>
            <span className="text-sm text-content-default sm:text-right">{children}</span>
        </div>
    );
}

export function AiSystemDetailClient({ system, drafts: initialDrafts = [], tenantSlug, canWrite, canOpenApprovalQueue }: Props) {
    const tx = useTranslations('risks');
    const tierLabel = isKnownAiActTier(system.riskTier)
        ? tx(`aiSystems.filterEnums.riskTier.${system.riskTier}`)
        : system.riskTier;
    const roleLabel = system.deploymentRole === 'PROVIDER' ? tx('aiSystems.provider') : tx('aiSystems.deployer');
    // #107 READ side. Null `listKey`, so this is published-order-or-nothing:
    // the registry at /risks/ai-systems renders server-side, so its rows never
    // land in an SWR cache entry and a fallback read would fire a fresh
    // `GET /ai-systems` on EVERY detail load — a round-trip per page view to
    // serve arrows for a list the deep-linking user never saw. Hiding the
    // arrows is the documented semantic for that case.
    const systemIds = useEntityListIds(null, { orderKey: CACHE_KEYS.aiSystems.list() });

    // Rendered through PageHeader's `titleAdornment` slot, which paints it as a
    // SIBLING of the <h1>. Folding it into `title` instead would put two
    // <button aria-label="Previous …"> inside the heading, and the accname
    // spec concatenates a descendant control's label into the heading's own
    // accessible name. `aiSystem` is a registered stepper slug, so the labels
    // read "Previous / Next AI system" — and in Bulgarian the feminine
    // "Предишна / Следваща ИИ система", which is why the catalog holds whole
    // phrases rather than one interpolated adjective.
    const stepper = (
        <EntityPrevNextNav
            ids={systemIds}
            currentId={system.id}
            hrefFor={(id) => `/t/${tenantSlug}/risks/ai-systems/${id}`}
            labelSingular="aiSystem"
        />
    );

    const [busy, setBusy] = useState<string | null>(null);
    // #4777 — the drafts already queued come from the server, so a reload no
    // longer forgets them and offers the button again.
    const [drafts, setDrafts] = useState<ConformityDraft[]>(initialDrafts);
    const [queuedNow, setQueuedNow] = useState<string[]>([]);
    const waiting = (docType: string) => drafts.some((d) => d.docType === docType && d.status === 'PENDING');
    const statusLabel = SYSTEM_STATUSES.has(system.status)
        ? tx(`aiSystems.detail.status_${system.status}`)
        : system.status;
    const [error, setError] = useState<string | null>(null);
    const [classifying, setClassifying] = useState(false);
    const canClassify = system.riskTier === 'UNCLASSIFIED' && canWrite;

    const generate = async (docType: string) => {
        setError(null);
        setBusy(docType);
        try {
            const res = await fetch(`/api/t/${tenantSlug}/ai-systems/${system.id}/conformity`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ docType }),
            });
            if (!res.ok) {
                const body: unknown = await res.json().catch(() => null);
                throw new Error(apiErrorMessage(body, tx('aiSystems.detail.errorFallback')));
            }
            const body = (await res.json().catch(() => null)) as { proposalId?: string } | null;
            setDrafts((list) => [
                { proposalId: body?.proposalId ?? `local-${docType}`, docType, status: 'PENDING', createdAt: new Date().toISOString() },
                ...list,
            ]);
            setQueuedNow((q) => [...q, docType]);
        } catch (e) {
            setError(e instanceof Error ? e.message : tx('aiSystems.detail.errorFallback'));
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="space-y-section">
            <PageHeader
                back={{ smart: true }}
                breadcrumbs={[
                    { label: tx('breadcrumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                    { label: tx('aiSystems.risksCrumb'), href: `/t/${tenantSlug}/risks` },
                    { label: tx('aiSystems.title'), href: `/t/${tenantSlug}/risks/ai-systems` },
                    { label: system.name },
                ]}
                title={system.name}
                titleAdornment={stepper}
                description={
                    system.riskTier === 'UNCLASSIFIED'
                        ? tx('aiSystems.detail.notClassifiedLine', { role: roleLabel })
                        : tx('aiSystems.detail.metaLine', { tier: tierLabel, clause: system.classificationClauseId ?? tx('aiSystems.detail.unclassified'), role: roleLabel })
                }
                actions={
                    <StatusBadge variant={aiActTierTone(system.riskTier)}>
                        {tierLabel}
                    </StatusBadge>
                }
            />

            <Card>
                <Heading level={2} className="mb-2 text-sm font-semibold text-content-emphasis">{tx('aiSystems.detail.classificationHeading')}</Heading>
                {system.riskTier === 'UNCLASSIFIED' && (
                    <InlineNotice variant="warning" className="mb-2" id="ai-system-not-classified">
                        {tx('aiSystems.detail.notClassifiedNotice')}
                    </InlineNotice>
                )}
                {canClassify && (
                    <div className="mb-2">
                        {/* SECONDARY: a card action that opens a dialog, whose
                            own submit is the primary (`primary-secondary-ratio`). */}
                        <Button
                            id="ai-system-classify"
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => setClassifying(true)}
                        >
                            {tx('aiSystems.detail.classify')}
                        </Button>
                    </div>
                )}
                <Row label={tx('aiSystems.detail.rowStatus')}>
                    <span data-testid="ai-system-status">{statusLabel}</span>
                </Row>
                <Row label={tx('aiSystems.colRiskTier')}>
                    <StatusBadge variant={aiActTierTone(system.riskTier)}>{tierLabel}</StatusBadge>
                </Row>
                <Row label={tx('aiSystems.detail.rowDrivingClause')}>{system.classificationClauseId ?? '—'}</Row>
                <Row label={tx('aiSystems.colBasis')}>{system.classificationRationale ?? '—'}</Row>
                <Row label={tx('aiSystems.provider')}>{system.provider ?? '—'}</Row>
                <Row label={tx('aiSystems.detail.rowPurpose')}>{system.purpose ?? '—'}</Row>
                <Row label={tx('aiSystems.new.useContextLabel')}>{system.useContext ?? '—'}</Row>
            </Card>

            <Card>
                <Heading level={2} className="mb-2 text-sm font-semibold text-content-emphasis">
                    {tx('aiSystems.detail.linkedObligations', { count: system.requirementLinks.length })}
                </Heading>
                {system.requirementLinks.length === 0 ? (
                    <p className="text-sm text-content-muted">{tx('aiSystems.detail.obligationsEmpty')}</p>
                ) : (
                    <ul className="space-y-tight">
                        {system.requirementLinks.map((l) => (
                            <li key={l.id} className="flex items-start gap-tight text-sm" data-testid={`ai-system-obligation-${l.id}`}>
                                {/* #4777 — the framework's name, not its key, and a way to it. */}
                                <StatusBadge variant="info" size="sm">
                                    {l.requirement.framework.name} {l.requirement.code}
                                </StatusBadge>
                                <Link
                                    href={`/t/${tenantSlug}/frameworks/${encodeURIComponent(l.requirement.framework.key)}`}
                                    className="text-content-default underline-offset-2 hover:underline"
                                >
                                    {l.requirement.title}
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
            </Card>

            {system.riskTier === 'HIGH' && (
                <Card>
                    <Heading level={2} className="mb-1 text-sm font-semibold text-content-emphasis">{tx('aiSystems.detail.conformityHeading')}</Heading>
                    <p className="mb-3 text-xs text-content-subtle">
                        {tx('aiSystems.detail.conformityHelp')}
                    </p>
                    {error && (
                        <div className="mb-3 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error" role="alert">
                            {error}
                        </div>
                    )}
                    <div className="flex flex-col gap-tight sm:flex-row sm:flex-wrap">
                        {DOC_TYPES.map((d) => (
                            <Button
                                key={d}
                                variant="secondary"
                                size="sm"
                                disabled={!canWrite || busy === d || waiting(d)}
                                onClick={() => generate(d)}
                            >
                                {busy === d ? tx('aiSystems.detail.generating') : waiting(d) ? tx('aiSystems.detail.queued') : tx(`aiSystems.detail.docTypes.${d}`)}
                            </Button>
                        ))}
                    </div>
                    {queuedNow.length > 0 && canOpenApprovalQueue && (
                        <p className="mt-3 text-sm text-content-muted" id="ai-system-drafts-queued">
                            {/* #4777 — one sentence, so each language orders it. */}
                            {tx.rich('aiSystems.detail.draftsQueued', {
                                count: queuedNow.length,
                                link: (chunks) => (
                                    <Link href={`/t/${tenantSlug}/agent-proposals`} className="text-content-link underline">
                                        {chunks}
                                    </Link>
                                ),
                            })}
                        </p>
                    )}
                    {queuedNow.length > 0 && !canOpenApprovalQueue && (
                        <p className="mt-3 text-sm text-content-muted" id="ai-system-drafts-queued">
                            {queuedNow.length > 1
                                ? tx('aiSystems.detail.draftsQueuedNoQueuePlural')
                                : tx('aiSystems.detail.draftsQueuedNoQueueSingular')}{' '}
                            <Link href={`/t/${tenantSlug}/policies`} className="text-content-link underline">
                                {tx('aiSystems.detail.openPolicies')}
                            </Link>
                        </p>
                    )}
                    {/* #4777 — the drafts already queued for this system. */}
                    {drafts.length > 0 && (
                        <div className="mt-4 space-y-tight" data-testid="ai-system-drafts">
                            <Heading level={3} className="text-xs font-semibold uppercase tracking-wide text-content-subtle">
                                {tx('aiSystems.detail.draftsHeading')}
                            </Heading>
                            <ul className="divide-y divide-border-subtle">
                                {drafts.map((d) => (
                                    <li key={d.proposalId} className="flex flex-wrap items-center gap-default py-tight text-sm" data-testid={`ai-system-draft-${d.docType}`}>
                                        <span className="text-content-emphasis">
                                            {(DOC_TYPES as readonly string[]).includes(d.docType) ? tx(`aiSystems.detail.docTypes.${d.docType}`) : d.docType}
                                        </span>
                                        <StatusBadge variant={d.status === 'PENDING' ? 'warning' : d.status === 'ACCEPTED' || d.status === 'EDITED' ? 'success' : 'neutral'} size="sm">
                                            {DRAFT_STATUSES.has(d.status) ? tx(`aiSystems.detail.draftStatus_${d.status}`) : d.status}
                                        </StatusBadge>
                                        <span className="text-xs text-content-subtle">{formatDate(d.createdAt)}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </Card>
            )}
            {classifying && canClassify && (
                <ClassifyAiSystemModal
                    systemId={system.id}
                    systemName={system.name}
                    tenantSlug={tenantSlug}
                    onClose={() => setClassifying(false)}
                />
            )}
        </div>
    );
}
