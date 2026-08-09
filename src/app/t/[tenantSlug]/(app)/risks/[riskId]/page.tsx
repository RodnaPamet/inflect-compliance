'use client';
import { useTranslations } from 'next-intl';
import { useHydratedNow } from '@/lib/hooks/use-hydrated-now';
import { formatDate } from '@/lib/format-date';
import { SkeletonCard, SkeletonDetailPage } from '@/components/ui/skeleton';
import { useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useTenantContext, useTenantApiUrl, useTenantHref, useMoneyFormatter } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import dynamic from 'next/dynamic';
import LinkedTasksPanel from '@/components/LinkedTasksPanel';
import { LinkedVendorsPanel } from '@/components/LinkedVendorsPanel';
import { Eyebrow } from '@/components/ui/typography';
import { KPIStat } from '@/components/ui/metric';
import { MetaStrip } from '@/components/ui/meta-strip';
import { RiskScoreExplainer } from '@/components/risks/RiskScoreExplainer';
import {
    RISK_STATUS_VARIANT,
    riskSeverityToBadgeVariant,
} from '@/app-layer/domain/entity-status-mapping';
import { resolveBandForScore, resolveBandTone } from '@/lib/risk-matrix/scoring';
import { useRiskMatrixConfig } from '@/lib/hooks/use-risk-matrix-config';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { Button } from '@/components/ui/button';
import { ProcessNodeReverseLookupModal } from '@/components/processes/ProcessNodeReverseLookupModal';
import { Pen2 } from '@/components/ui/icons/nucleo';
import { Tooltip } from '@/components/ui/tooltip';
import { Combobox, ComboboxOption } from '@/components/ui/combobox';
import { useTenantMembers } from '@/components/ui/user-combobox';
import { buildRiskTreatmentOptions, canonicalTreatmentLabel, buildRiskStatusOptions, riskStatusLabel, RISK_CATEGORY_OPTIONS } from '../_shared/risk-options';
import { cn } from '@/lib/cn';
import { cardVariants } from '@/components/ui/card';
import { EditRiskModal, type EditRiskForm } from './_modals/EditRiskModal';
import { RiskAssessmentPanel } from './RiskAssessmentPanel';
import { resolveALE } from '@/lib/fair-math';
import { formatTailAwareAle } from '@/lib/tail-language';
import { FairAnalysisPanel } from './FairAnalysisPanel';
import { BowTiePanel } from './BowTiePanel';
import { RiskHistoryPanel } from './RiskHistoryPanel';
import { InheritedEvidencePanel } from '@/components/InheritedEvidencePanel';
import { AttachedEvidencePanel } from '@/components/AttachedEvidencePanel';
import { Heading } from '@/components/ui/typography';
import { InheritedTestPlansPanel } from '@/components/InheritedTestPlansPanel';
import { InheritedMappingsPanel } from '@/components/InheritedMappingsPanel';
import { extractMutationError } from '@/lib/mutations';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';

const TraceabilityPanel = dynamic(() => import('@/components/TraceabilityPanel'), {
    loading: () => <SkeletonCard lines={3} />,
    ssr: false,
});

type Risk = {
    id: string;
    title: string;
    description: string | null;
    category: string | null;
    threat: string | null;
    vulnerability: string | null;
    status: string;
    treatment: string | null;
    treatmentOwner: string | null;
    treatmentNotes: string | null;
    ownerUserId: string | null;
    likelihood: number;
    impact: number;
    score: number;
    inherentScore: number;
    residualLikelihood: number | null;
    residualImpact: number | null;
    residualScore: number | null;
    nextReviewAt: string | null;
    targetDate: string | null;
    createdAt: string;
    updatedAt: string;
    // RQ-1 FAIR inputs (all nullable).
    threatEventFrequency: number | null;
    contactFrequency: number | null;
    probabilityOfAction: number | null;
    vulnerabilityProbability: number | null;
    threatCapability: number | null;
    controlStrength: number | null;
    primaryLossMagnitude: number | null;
    productivityLoss: number | null;
    responseCost: number | null;
    replacementCost: number | null;
    secondaryLossEventFrequency: number | null;
    secondaryLossMagnitude: number | null;
    regulatoryFineEstimate: number | null;
    reputationDamageEstimate: number | null;
    competitiveAdvantageLoss: number | null;
    fairConfidence: 'LOW' | 'MEDIUM' | 'HIGH' | null;
    /** RQ3-2 — stored PERT triples (range-first estimation). */
    fairInputsJson: Record<string, unknown> | null;
    fairAle: number | null;
    // RQ2-5 — legacy quant inputs feed `resolveALE` for the header chip.
    sleAmount: number | null;
    aroAmount: number | null;
};

// Audit Coherence S1 — MITIGATED sits between MITIGATING and
// ACCEPTED in the RiskStatus enum. The detail-page status combobox
// must offer it; otherwise a reviewer who picks "Mitigated" in the
// list filter cannot land on the corresponding detail-page value.
// Options are built inside the component so the labels localize
// (buildRiskStatusOptions), matching the filter + list badge. Categories
// are the exception — they are stored verbatim in `Risk.category` and
// filtered on as literal strings, so they come from the shared list
// unlocalised. See _shared/risk-options.

// Polish PR-1 — STATUS_VARIANT moved to shared domain mapping.
// Imported from @/app-layer/domain/entity-status-mapping as
// `RISK_STATUS_VARIANT` so risks list / dashboard / detail all read
// the same vocabulary.

/**
 * Is the review date past?
 *
 * `now` is threaded in rather than read from the clock here. `new Date()`
 * during render means the server pass and the hydration pass compare against
 * DIFFERENT instants, so a risk sitting either side of its review date
 * renders a different overdue treatment on each — React error #418.
 *
 * `useHydratedNow()` is null until the client has painted once; a null `now`
 * reports not-overdue so the SSR HTML matches the first client render.
 */
function isOverdue(nextReviewAt: string | null, now: Date | null): boolean {
    if (!now || !nextReviewAt) return false;
    return new Date(nextReviewAt) < now;
}

// Risk-score band + tone resolve from the tenant RiskMatrixConfig via
// resolveBandForScore / resolveBandTone (@/lib/risk-matrix/scoring).

export default function RiskDetailPage() {
    // Hydration-safe clock — see the note on isOverdue above.
    const hydratedNow = useHydratedNow();
    const { riskId } = useParams<{ riskId: string }>();
    const t = useTranslations('risks');
    const TREATMENT_OPTIONS = useMemo(
        () => buildRiskTreatmentOptions((k) => t(k as Parameters<typeof t>[0])),
        [t],
    );
    // Localized status options — same labels as the filter + list badge.
    const STATUS_OPTIONS = useMemo(
        () => buildRiskStatusOptions((k) => t(k as Parameters<typeof t>[0])),
        [t],
    );
    // Tenant matrix config drives the header band chip + the Overview
    // score-card tone, so a custom matrix reads the same band everywhere.
    const { config: matrixConfig } = useRiskMatrixConfig();
    const tenant = useTenantContext();
    const apiUrl = useTenantApiUrl();
    const href = useTenantHref();
    // B1-4 — the tenant's configured symbol. This page formatted the ALE with
    // the raw helper, which defaults to €, so the risk header disagreed with
    // the dashboard for any tenant not on euros.
    const money = useMoneyFormatter();
    const canWrite = tenant.permissions.canWrite;
    const { data: riskMembers } = useTenantMembers(tenant.tenantSlug);
    // P1 item 3 — the treatment-plan owner picker was dead (empty roster),
    // so the required Owner combobox was unfillable and no plan could be
    // created. The roster is already loaded here — map it through.
    const treatmentOwnerChoices = useMemo(
        () => (riskMembers ?? []).map((m) => ({ userId: m.id, label: m.name ?? m.email ?? m.id })),
        [riskMembers],
    );

    const riskQuery = useTenantSWR<Risk>(`/risks/${riskId}`);
    const risk = riskQuery.data ?? null;
    const loading = riskQuery.isLoading;
    const loadError = riskQuery.error
        ? (riskQuery.error instanceof Error ? riskQuery.error.message : String(riskQuery.error))
        : null;
    // Mutation-error channel; load errors come from SWR above.
    const [error, setError] = useState<string | null>(null);
    // Alias kept so the existing disabled/label bindings read unchanged.
    // PR-D — "Where used" (process maps) reverse-lookup modal.
    const tWhereUsed = useTranslations('panels.processWhereUsed');
    const [processWhereUsedOpen, setProcessWhereUsedOpen] = useState(false);
    const [editing, setEditing] = useState(false);

    // RQ2-4 — the 10-tab bar is rationalized to 8. `assessment` is
    // the new guided inherent → controls → residual surface. The
    // former `mappings` and `tests` tabs were both inherited-via-
    // controls panels — they now live as sections under Traceability
    // (where the control links themselves are managed). The former
    // `activity` tab was an EmptyState stub; score provenance now
    // lives in the RQ2-3 explainer + History.
    type Tab =
        | 'overview'
        | 'assessment'
        | 'quantification'
        | 'bowtie'
        | 'history'
        | 'tasks'
        | 'evidence'
        | 'traceability';
    // RQ3-7 — honour a `?tab=<key>` deep-link on first mount (the KRI
    // breach card links straight to `?tab=assessment`). Only a valid
    // tab key is accepted; anything else falls back to overview.
    const searchParams = useSearchParams();
    const initialTab = ((): Tab => {
        const t = searchParams?.get('tab');
        const valid: Tab[] = ['overview', 'assessment', 'quantification', 'bowtie', 'history', 'tasks', 'evidence', 'traceability'];
        return t && (valid as string[]).includes(t) ? (t as Tab) : 'overview';
    })();
    const [activeTab, setActiveTab] = useState<Tab>(initialTab);
    const tabs: ReadonlyArray<{ key: Tab; label: string }> = [
        { key: 'overview', label: t('detail.tabOverview') },
        { key: 'assessment', label: t('detail.tabAssessment') },
        { key: 'quantification', label: t('detail.tabQuantification') },
        { key: 'bowtie', label: t('detail.tabBowtie') },
        { key: 'history', label: t('detail.tabHistory') },
        { key: 'tasks', label: t('detail.tabTasks') },
        { key: 'evidence', label: t('detail.tabEvidence') },
        { key: 'traceability', label: t('detail.tabTraceability') },
    ];
    const [editForm, setEditForm] = useState<EditRiskForm>({});

    // RQ3-4 — this risk's tail percentile (RQ3-1 cache). Failure-soft:
    // the header chip renders the mean register without it.
    const tailQuery = useTenantSWR<{ snapshot?: { byRisk?: Record<string, { aleP90?: number }> } }>(
        '/risks/tail-percentiles',
    );
    const tailP90 = tailQuery.data?.snapshot?.byRisk?.[riskId]?.aleP90 ?? null;

    const startEditing = () => {
        if (!risk) return;
        setEditForm({
            title: risk.title,
            description: risk.description ?? '',
            category: risk.category ?? '',
            likelihood: risk.likelihood,
            impact: risk.impact,
            treatmentOwner: risk.treatmentOwner ?? '',
            ownerUserId: risk.ownerUserId ?? '',
            treatment: risk.treatment ?? '',
            treatmentNotes: risk.treatmentNotes ?? '',
            nextReviewAt: risk.nextReviewAt ? risk.nextReviewAt.split('T')[0] : '',
        });
        setEditing(true);
    };

    /**
     * B2-1 — the two detail writes go through `useTenantMutation`.
     *
     * Both already did the two things the hook exists to do: POST/PUT, then
     * `riskQuery.mutate(updated, { revalidate: false })` — which is exactly
     * `populateCache` + `revalidate: false`. They just spelled it out
     * alongside their own `saving` / `error` slots.
     *
     * `revalidate: false` is preserved deliberately: the response body IS
     * the updated risk, so a follow-up GET would re-fetch data we already
     * hold. That is the documented case for turning revalidation off.
     */
    const saveMutation = useTenantMutation<Risk, void, { risk: Risk }>({
        key: `/risks/${riskId}`,
        revalidate: false,
        populateCache: (result) => result.risk,
        mutationFn: async () => {
            const payload: { title: string | undefined; description: string | null; category: string | null; likelihood: number | undefined; impact: number | undefined; treatmentOwner: string | null; ownerUserId: string | null; treatment: string | null; treatmentNotes: string | null; nextReviewAt?: string | null } = {
                title: editForm.title,
                description: editForm.description || null,
                category: editForm.category || null,
                likelihood: editForm.likelihood,
                impact: editForm.impact,
                treatmentOwner: editForm.treatmentOwner || null,
                ownerUserId: editForm.ownerUserId || null,
                treatment: editForm.treatment || null,
                treatmentNotes: editForm.treatmentNotes || null,
            };
            // Explicit null, not omission — `nextReviewAt` must be CLEARABLE.
            // The three-state contract (undefined = unchanged, null = clear,
            // value = set) is why B1-1 had to widen UpdateRiskSchema.
            payload.nextReviewAt = editForm.nextReviewAt
                ? new Date(editForm.nextReviewAt as string).toISOString()
                : null;

            const res = await fetch(apiUrl(`/risks/${riskId}`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.message || t('detail.saveFailed', { status: res.status }));
            }
            return res.json();
        },
    });

    const statusMutation = useTenantMutation<Risk, string, Risk>({
        key: `/risks/${riskId}`,
        revalidate: false,
        populateCache: (result) => result,
        mutationFn: async (status: string) => {
            const res = await fetch(apiUrl(`/risks/${riskId}/status`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(
                    data.message || t('detail.statusChangeFailed', { status: res.status }),
                );
            }
            return res.json();
        },
    });

    // B2-1 — was a local useState; the mutation owns the in-flight flag.
    const saving = saveMutation.isMutating;

    const handleSave = async (e?: React.FormEvent) => {
        e?.preventDefault();
        setError(null);
        try {
            await saveMutation.trigger();
            setEditing(false);
        } catch (err) {
            setError(extractMutationError(err));
        }
    };

    const handleStatusChange = async (newStatus: string) => {
        setError(null);
        try {
            await statusMutation.trigger(newStatus);
        } catch (err) {
            setError(extractMutationError(err));
        }
    };

    const breadcrumbs = [
        { label: t('detail.bcDashboard'), href: href('/dashboard') },
        { label: t('detail.bcRisks'), href: href('/risks') },
        { label: risk?.title ?? t('detail.bcFallback') },
    ];
    if (loading) {
        // RQ3-OB-B — structured skeleton instead of an empty shell.
        // The empty `<>` left a flash of bare layout chrome on slow
        // detail-page loads; `SkeletonDetailPage` paints the breadcrumb,
        // title, meta pills, and a card stub so the page reads as
        // intentional content rather than as a render miss.
        return (
            <EntityDetailLayout loading title="" breadcrumbs={breadcrumbs}>
                <SkeletonDetailPage />
            </EntityDetailLayout>
        );
    }
    if (loadError && !risk) {
        return (
            <EntityDetailLayout error={loadError} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (!risk) {
        return (
            <EntityDetailLayout empty={{ message: t('detail.notFound') }} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }

    // Config-driven band + tone (PR-J) — agrees with list/assessment/explainer.
    const bandResolved = resolveBandForScore(risk.inherentScore, matrixConfig.bands);
    const bandTone = resolveBandTone(risk.inherentScore, matrixConfig.bands).tone;
    const band = {
        label: bandResolved.name,
        variant: riskSeverityToBadgeVariant(bandTone),
    };
    // RQ2-5 — resolved ALE for the header chip (null = not quantified).
    const riskAleValue = resolveALE({
        fairAle: risk.fairAle,
        sleAmount: risk.sleAmount,
        aroAmount: risk.aroAmount,
    });
    // RQ3-4 — the chip speaks the compact tail register when the
    // simulation cache has this risk's P90.
    const riskAleLabel = formatTailAwareAle(riskAleValue, tailP90, {
        money,
        compact: true,
    });
    const overdue = isOverdue(risk.nextReviewAt, hydratedNow);

    return (
        <EntityDetailLayout
            id="risk-detail-page"
            breadcrumbs={breadcrumbs}
            back={{ smart: true }}
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={(k) => setActiveTab(k)}

            title={<span id="risk-title-heading">{risk.title}</span>}
            meta={
                <MetaStrip
                    items={[
                        {
                            kind: 'status',
                            label: t('detail.status'),
                            value: riskStatusLabel(t, risk.status),
                            variant: RISK_STATUS_VARIANT[risk.status] ?? 'neutral',
                        },
                        {
                            kind: 'status',
                            label: t('detail.inherentScore'),
                            // RQ2-3 — the header score explains itself.
                            value: (
                                <RiskScoreExplainer tenantSlug={tenant.tenantSlug} riskId={riskId} label={`${risk.inherentScore} · ${band.label}`}>
                                    {`${risk.inherentScore} · ${band.label}`}
                                </RiskScoreExplainer>
                            ),
                            variant: band.variant,
                        },
                        // RQ2-5 — qual ↔ quant side by side: the
                        // quantified header carries the compact ALE
                        // next to the score chip.
                        // polish #11 — the ALE chip drills into the
                        // FAIR tab, closing the loop from glance →
                        // inputs. Bare-text fallback when canWrite is
                        // off keeps the value visible without faking
                        // an affordance.
                        ...(riskAleValue !== null
                            ? [
                                  {
                                      label: t('detail.ale'),
                                      value: (
                                          <button
                                              type="button"
                                              className="cursor-pointer bg-transparent border-0 p-0 text-inherit underline underline-offset-2 decoration-dotted"
                                              onClick={() => setActiveTab('quantification')}
                                              aria-label={t('detail.aleAria', { ale: riskAleLabel ?? '' })}
                                              data-testid="meta-ale-link"
                                          >
                                              {riskAleLabel}
                                          </button>
                                      ),
                                  } as const,
                              ]
                            : []),
                        ...(risk.treatmentOwner
                            ? [
                                  {
                                      label: t('detail.owner'),
                                      value: risk.treatmentOwner,
                                  } as const,
                              ]
                            : []),
                        ...(risk.ownerUserId
                            ? [
                                  {
                                      label: t('detail.assignedTo'),
                                      value:
                                          riskMembers?.find(
                                              (m) => m.id === risk.ownerUserId,
                                          )?.name ??
                                          riskMembers?.find(
                                              (m) => m.id === risk.ownerUserId,
                                          )?.email ??
                                          'Assigned',
                                  } as const,
                              ]
                            : []),
                        ...(risk.nextReviewAt
                            ? [
                                  {
                                      label: t('detail.nextReview'),
                                      value: formatDate(risk.nextReviewAt),
                                      tone: overdue
                                          ? ('critical' as const)
                                          : undefined,
                                  } as const,
                              ]
                            : []),
                    ]}
                />
            }
            actions={
                <>
                    {/* PR-D — Where used in process maps. Visible to all
                        viewers (readers + auditors need it most). */}
                    <Button
                        variant="secondary"
                        onClick={() => setProcessWhereUsedOpen(true)}
                        id="risk-where-used-btn"
                        data-testid="risk-where-used-btn"
                    >
                        {tWhereUsed('button')}
                    </Button>
                    {canWrite && (
                        <Combobox
                            hideSearch
                            id="risk-status-select"
                            selected={STATUS_OPTIONS.find(o => o.value === risk.status) ?? null}
                            setSelected={(opt) => { if (opt) handleStatusChange(opt.value); }}
                            options={STATUS_OPTIONS}
                            placeholder={t('detail.statusPlaceholder')}
                            // Item 29 — brand-color the status action (matches the
                            // primary "+ …" create buttons).
                            buttonProps={{ variant: 'primary', className: 'text-sm' }}
                        />
                    )}
                </>
            }
        >
            {error && (
                <div className={cn(cardVariants({ density: 'compact' }), 'border-border-error text-content-error text-sm')}>{error}</div>
            )}

            {activeTab === 'tasks' && (
                <div className={cardVariants()}>
                    <LinkedTasksPanel
                        apiBase={apiUrl('')}
                        entityType="RISK"
                        entityId={riskId}
                        tenantHref={href}
                        canWrite={canWrite}
                    />
                </div>
            )}
            {activeTab === 'traceability' && (
                <div className="space-y-section">
                    <TraceabilityPanel
                        apiBase={apiUrl('')}
                        entityType="risk"
                        entityId={riskId}
                        canWrite={canWrite}
                        tenantHref={href}
                    />
                    {/* RQ2-4 — the former Mappings + Tests tabs were
                        both inherited-via-controls surfaces; they now
                        sit where the control links are managed.
                        polish #7 — each gets a top divider so the
                        block reads as three sections, not one. */}
                    <div className="space-y-default border-t border-border-subtle pt-default">
                        <Heading level={3}>{t('detail.inheritedMappings')}</Heading>
                        <InheritedMappingsPanel
                            endpoint={apiUrl(`/risks/${riskId}/mappings`)}
                            tenantHref={href}
                            entityLabel="risk"
                        />
                    </div>
                    <div className="space-y-default border-t border-border-subtle pt-default">
                        <Heading level={3}>{t('detail.inheritedTestPlans')}</Heading>
                        <InheritedTestPlansPanel
                            endpoint={apiUrl(`/risks/${riskId}/test-plans`)}
                            tenantHref={href}
                            entityLabel="risk"
                        />
                    </div>
                    <div className="border-t border-border-subtle pt-default">
                        <LinkedVendorsPanel entityType="RISK" entityId={riskId} />
                    </div>
                </div>
            )}
            {activeTab === 'evidence' && (
                <div className="space-y-section">
                    <div className="space-y-default">
                        <Heading level={3}>{t('detail.attachedEvidence')}</Heading>
                        <AttachedEvidencePanel
                            tenantSlug={tenant.tenantSlug}
                            entityId={riskId}
                            entity="risk"
                            endpoint={`/risks/${riskId}/evidence/attached`}
                            apiUrl={apiUrl}
                            tenantHref={href}
                            canWrite={canWrite}
                        />
                    </div>
                    <div className="space-y-default">
                        <Heading level={3}>{t('detail.inheritedFromControls')}</Heading>
                        <InheritedEvidencePanel
                            endpoint={apiUrl(`/risks/${riskId}/evidence`)}
                            tenantHref={href}
                            entityLabel="risk"
                        />
                    </div>
                </div>
            )}
            {activeTab === 'assessment' && (
                <RiskAssessmentPanel
                    tenantSlug={tenant.tenantSlug}
                    riskId={riskId}
                    matrixConfig={matrixConfig}
                    risk={{
                        likelihood: risk.likelihood,
                        impact: risk.impact,
                        inherentScore: risk.inherentScore,
                        residualLikelihood: risk.residualLikelihood,
                        residualImpact: risk.residualImpact,
                        residualScore: risk.residualScore,
                        // RQ3-OB-D — drives the adaptive bridge copy.
                        fairAle: risk.fairAle,
                        // P1 — Step 4 (treat & monitor) inputs.
                        treatment: risk.treatment,
                        nextReviewAt: risk.nextReviewAt,
                        status: risk.status,
                    }}
                    canWrite={canWrite}
                    canAdmin={tenant.permissions.canAdmin}
                    ownerChoices={treatmentOwnerChoices}
                    onRiskUpdated={() => riskQuery.mutate()}
                    onQuantify={() => setActiveTab('quantification')}
                    onLinkControls={() => setActiveTab('traceability')}
                    onStatusChange={handleStatusChange}
                />
            )}
            {activeTab === 'quantification' && risk && (
                <FairAnalysisPanel
                    riskId={riskId}
                    category={risk.category}
                    initial={{
                        threatEventFrequency: risk.threatEventFrequency,
                        contactFrequency: risk.contactFrequency,
                        probabilityOfAction: risk.probabilityOfAction,
                        vulnerabilityProbability: risk.vulnerabilityProbability,
                        threatCapability: risk.threatCapability,
                        controlStrength: risk.controlStrength,
                        primaryLossMagnitude: risk.primaryLossMagnitude,
                        productivityLoss: risk.productivityLoss,
                        responseCost: risk.responseCost,
                        replacementCost: risk.replacementCost,
                        secondaryLossEventFrequency: risk.secondaryLossEventFrequency,
                        secondaryLossMagnitude: risk.secondaryLossMagnitude,
                        regulatoryFineEstimate: risk.regulatoryFineEstimate,
                        reputationDamageEstimate: risk.reputationDamageEstimate,
                        competitiveAdvantageLoss: risk.competitiveAdvantageLoss,
                        fairConfidence: risk.fairConfidence,
                        fairInputsJson: risk.fairInputsJson,
                    }}
                />
            )}

            {activeTab === 'bowtie' && <BowTiePanel riskId={riskId} />}

            {activeTab === 'history' && <RiskHistoryPanel riskId={riskId} />}

            {activeTab === 'overview' && (
                <>
            {/* Detail Card */}
            <div className={cn(cardVariants(), 'space-y-default')} id="risk-detail">
                {canWrite && (
                    <div className="flex justify-end -mt-1 -mb-2">
                        {/* B2 — icon-only edit affordance; opens the Edit
                            Risk modal, mirroring the control detail page. */}
                        <Tooltip content={t('detail.editRisk')}>
                            <Button
                                variant="secondary"
                                size="icon"
                                onClick={startEditing}
                                id="edit-risk-btn"
                                aria-label={t('detail.editRisk')}
                            >
                                <Pen2 className="size-4" />
                            </Button>
                        </Tooltip>
                    </div>
                )}
                {risk.description && (
                    <div>
                        <Eyebrow>{t('detail.description')}</Eyebrow>
                        <p className="text-sm text-content-default whitespace-pre-wrap">{risk.description}</p>
                    </div>
                )}

                <div className="grid grid-cols-2 md:grid-cols-4 gap-default">
                    <div>
                        <Eyebrow>{t('detail.category')}</Eyebrow>
                        <p className="text-sm">{risk.category || '—'}</p>
                    </div>
                    <div>
                        <Eyebrow>{t('detail.treatmentOwner')}</Eyebrow>
                        <p className="text-sm">{risk.treatmentOwner || '—'}</p>
                    </div>
                    <div>
                        <Eyebrow>{t('detail.treatment')}</Eyebrow>
                        <p className="text-sm">
                            {canonicalTreatmentLabel((k) => t(k as Parameters<typeof t>[0]), risk.treatment)
                                ?? t('detail.untreated')}
                        </p>
                    </div>
                    <div>
                        <Eyebrow>{t('detail.targetDate')}</Eyebrow>
                        <p className="text-sm">{risk.targetDate ? formatDate(risk.targetDate) : '—'}</p>
                    </div>
                </div>

                {/* Item 31 — single inherent-score card (was three separate
                    Likelihood / Impact / Inherent Score cards), mirroring the
                    controls Overview single-card pattern. The headline number is
                    the inherent score; Likelihood × Impact is the supporting
                    breakdown so the derivation stays visible. */}
                <div className={cn(cardVariants(), 'space-y-tight')} data-testid="risk-score-card">
                    <KPIStat
                        value={risk.inherentScore}
                        label={t('detail.inherentRiskScore')}
                        tone={bandTone}
                        description={
                            <>
                                {t('detail.likelihood')}{' '}
                                <span className="font-semibold text-content-default">{risk.likelihood}</span>{' '}
                                {t('detail.impactTimes')}{' '}
                                <span className="font-semibold text-content-default">{risk.impact}</span>
                            </>
                        }
                    />
                </div>

                {risk.threat && (
                    <div>
                        <Eyebrow>{t('detail.threat')}</Eyebrow>
                        <p className="text-sm text-content-default">{risk.threat}</p>
                    </div>
                )}
                {risk.vulnerability && (
                    <div>
                        <Eyebrow>{t('detail.vulnerability')}</Eyebrow>
                        <p className="text-sm text-content-default whitespace-pre-wrap">{risk.vulnerability}</p>
                    </div>
                )}
                {risk.treatmentNotes && (
                    <div>
                        <Eyebrow>{t('detail.treatmentNotes')}</Eyebrow>
                        <p className="text-sm text-content-default whitespace-pre-wrap">{risk.treatmentNotes}</p>
                    </div>
                )}

                <div className="grid grid-cols-2 gap-default border-t border-border-subtle pt-4">
                    <div>
                        <Eyebrow>{t('detail.nextReview')}</Eyebrow>
                        <p className={`text-sm ${overdue ? 'text-content-error font-semibold' : ''}`}>
                            {risk.nextReviewAt
                                ? `${overdue ? '! ' : ''}${formatDate(risk.nextReviewAt)}`
                                : '—'
                            }
                        </p>
                    </div>
                    <div>
                        <Eyebrow>{t('detail.created')}</Eyebrow>
                        <p className="text-sm text-content-muted">{formatDate(risk.createdAt)}</p>
                    </div>
                </div>
            </div>

            {/* P1 — the Risk Treatment Plan card moved into the guided
                assessment (Step 4). Overview keeps the read-only treatment
                summary above; the plan itself is managed in one place. A
                pointer sends the user to the narrated flow. */}
            {canWrite && (
                <div className={cn(cardVariants({ density: 'compact' }), 'flex items-center justify-between')}>
                    <p className="text-sm text-content-muted">{t('detail.treatmentMovedHint')}</p>
                    <Button
                        variant="secondary"
                        id="goto-treat-monitor-btn"
                        onClick={() => setActiveTab('assessment')}
                    >
                        {t('detail.goToTreatMonitor')}
                    </Button>
                </div>
            )}
                </>
            )}

            {/* Edit Risk modal — opened by the Overview-tab Edit button.
                Mirrors the control detail page's EditControlModal. */}
            {canWrite && (
                <EditRiskModal
                    open={editing}
                    setOpen={setEditing}
                    form={editForm}
                    setForm={setEditForm}
                    saving={saving}
                    error={error}
                    tenantSlug={tenant.tenantSlug}
                    categoryOptions={RISK_CATEGORY_OPTIONS}
                    treatmentOptions={TREATMENT_OPTIONS}
                    onCancel={() => setEditing(false)}
                    onSubmit={handleSave}
                />
            )}

            {/* PR-D — Where used (process maps) reverse-lookup modal */}
            <ProcessNodeReverseLookupModal
                entityType="risk"
                entityId={riskId}
                tenantSlug={tenant.tenantSlug}
                open={processWhereUsedOpen}
                onOpenChange={setProcessWhereUsedOpen}
            />
        </EntityDetailLayout>
    );
}
