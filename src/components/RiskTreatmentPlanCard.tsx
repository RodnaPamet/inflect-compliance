'use client';

/**
 * Epic G-7 — Risk Treatment Plan card.
 *
 * Mounts on the risk detail page. Anchors the entire treatment-plan
 * workflow (create, add milestones, check off milestones, close
 * plan) to the risk the user is already looking at.
 *
 * Permission gating:
 *   - Anyone with read access can see the card.
 *   - canWrite → Create plan / Add milestone / Check off milestone.
 *   - canAdmin → Complete plan.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import useSWR, { useSWRConfig } from 'swr';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/hooks';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { formatDate } from '@/lib/format-date';
import { Heading } from '@/components/ui/typography';
import {
    DECISION_TO_STRATEGY,
    type TreatmentDecisionValue,
} from '@/lib/risk-treatment-vocabulary';

type Strategy = 'MITIGATE' | 'ACCEPT' | 'TRANSFER' | 'AVOID';

/** Seed the create-plan strategy from the risk's treatment decision. */
function strategyFromDecision(decision: string | null | undefined): Strategy {
    if (!decision) return 'MITIGATE';
    return DECISION_TO_STRATEGY[decision as TreatmentDecisionValue] ?? 'MITIGATE';
}
type Status = 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'OVERDUE';

interface MilestoneRow {
    id: string;
    title: string;
    description: string | null;
    dueDate: string | Date;
    completedAt: string | Date | null;
    completedBy: { id: string; email: string; name: string | null } | null;
    sortOrder: number;
    evidence: string | null;
}

interface PlanDetail {
    id: string;
    riskId: string;
    strategy: Strategy;
    ownerUserId: string;
    targetDate: string | Date;
    status: Status;
    completedAt: string | Date | null;
    closingRemark: string | null;
    owner: { id: string; email: string; name: string | null };
    milestones: MilestoneRow[];
}

interface PlanSummary {
    id: string;
    riskId: string;
    strategy: Strategy;
    status: Status;
    targetDate: string | Date;
    completedAt: string | Date | null;
    _count?: { milestones: number };
}

interface OwnerChoice {
    userId: string;
    label: string;
}

interface Props {
    tenantSlug: string;
    riskId: string;
    /// Roster of users available to own a plan — typically the
    /// tenant's admin/editor members. Resolved by the parent page
    /// to avoid a second fetch.
    ownerChoices: readonly OwnerChoice[];
    canWrite: boolean;
    canAdmin: boolean;
    /// The risk's treatment DECISION (TREAT/TOLERATE/TRANSFER/AVOID).
    /// PR-K — seeds the create-plan strategy via DECISION_TO_STRATEGY so
    /// "Accept" doesn't open the dialog defaulted to Mitigate.
    treatment?: string | null;
}

const STRATEGY_VARIANT: Record<Strategy, 'info' | 'success' | 'warning' | 'neutral'> = {
    MITIGATE: 'info',
    ACCEPT: 'neutral',
    TRANSFER: 'warning',
    AVOID: 'success',
};

const STATUS_VARIANT: Record<Status, 'warning' | 'info' | 'success' | 'error'> = {
    DRAFT: 'warning',
    ACTIVE: 'info',
    COMPLETED: 'success',
    OVERDUE: 'error',
};

export function RiskTreatmentPlanCard({
    tenantSlug,
    riskId,
    ownerChoices,
    canWrite,
    canAdmin,
    treatment,
}: Props) {
    const { mutate: swrMutate } = useSWRConfig();
    const t = useTranslations('panels.treatment');
    const apiBase = `/api/t/${tenantSlug}/risks/${riskId}/treatment-plans`;

    const plansQuery = useSWR<{ rows: PlanSummary[] }>(
        apiBase,
        async (url: string) => {
            const res = await fetch(url);
            if (!res.ok) throw new Error('Failed to fetch treatment plans');
            return res.json();
        },
    );

    const summaries = plansQuery.data?.rows ?? [];
    /// Active plan = first non-COMPLETED. There can be multiple plans
    /// over time (e.g. expired then renewed); the card focuses on
    /// the live one.
    const activeSummary =
        summaries.find((p) => p.status !== 'COMPLETED') ?? summaries[0];

    const [createOpen, setCreateOpen] = useState(false);
    const [addMilestoneOpen, setAddMilestoneOpen] = useState(false);
    const [completeOpen, setCompleteOpen] = useState(false);

    const invalidate = () => {
        swrMutate(apiBase);
        if (activeSummary?.id) swrMutate(`${apiBase}/${activeSummary.id}`);
    };

    return (
        <section
            className="space-y-default"
            data-testid="risk-treatment-plan-card"
        >
            <header className="flex items-center justify-between">
                <Heading level={2} className="inline-flex items-center gap-tight">
                    {t('title')}
                </Heading>
                {canWrite && !activeSummary ? (
                    <Button
                        onClick={() => setCreateOpen(true)}
                        data-testid="treatment-plan-create-button"
                    >
                        {t('create')}
                    </Button>
                ) : null}
            </header>

            {!activeSummary ? (
                <p
                    className="text-sm text-content-muted"
                    data-testid="treatment-plan-empty"
                >
                    {t('emptyPrefix')} <strong>{t('create')}</strong>{' '}
                    {t('emptySuffix')}
                </p>
            ) : (
                <ActivePlanBlock
                    apiBase={apiBase}
                    tenantSlug={tenantSlug}
                    planId={activeSummary.id}
                    canWrite={canWrite}
                    canAdmin={canAdmin}
                    onAddMilestone={() => setAddMilestoneOpen(true)}
                    onComplete={() => setCompleteOpen(true)}
                    onMutated={invalidate}
                />
            )}

            {createOpen ? (
                <CreatePlanDialog
                    apiBase={apiBase}
                    riskId={riskId}
                    ownerChoices={ownerChoices}
                    treatment={treatment}
                    onClose={() => setCreateOpen(false)}
                    onSuccess={() => {
                        setCreateOpen(false);
                        invalidate();
                    }}
                />
            ) : null}

            {addMilestoneOpen && activeSummary ? (
                <AddMilestoneDialog
                    apiBase={apiBase}
                    planId={activeSummary.id}
                    onClose={() => setAddMilestoneOpen(false)}
                    onSuccess={() => {
                        setAddMilestoneOpen(false);
                        invalidate();
                    }}
                />
            ) : null}

            {completeOpen && activeSummary ? (
                <CompletePlanDialog
                    apiBase={apiBase}
                    planId={activeSummary.id}
                    onClose={() => setCompleteOpen(false)}
                    onSuccess={() => {
                        setCompleteOpen(false);
                        invalidate();
                    }}
                />
            ) : null}
        </section>
    );
}

// ─── Active plan block ───────────────────────────────────────────────

function ActivePlanBlock({
    apiBase,
    tenantSlug,
    planId,
    canWrite,
    canAdmin,
    onAddMilestone,
    onComplete,
    onMutated,
}: {
    apiBase: string;
    tenantSlug: string;
    planId: string;
    canWrite: boolean;
    canAdmin: boolean;
    onAddMilestone: () => void;
    onComplete: () => void;
    onMutated: () => void;
}) {
    const t = useTranslations('panels.treatment');
    const planQuery = useSWR<PlanDetail>(
        `${apiBase}/${planId}`,
        async (url: string) => {
            const res = await fetch(url);
            if (!res.ok) throw new Error('Failed to fetch plan detail');
            return res.json();
        },
    );

    const plan = planQuery.data;
    if (!plan) {
        return (
            <div
                className="rounded border border-border-subtle p-4 text-sm text-content-muted"
                data-testid="treatment-plan-loading"
            >
                {t('loading')}
            </div>
        );
    }

    const total = plan.milestones.length;
    const done = plan.milestones.filter((m) => m.completedAt !== null).length;
    const pct = total === 0 ? (plan.status === 'COMPLETED' ? 100 : 0) : Math.round((done / total) * 100);
    const allMilestonesDone = total > 0 && done === total;
    const canCloseNow =
        plan.status !== 'COMPLETED' &&
        canAdmin &&
        (total === 0 || allMilestonesDone);

    return (
        <div
            className="rounded border border-border-subtle p-4 space-y-compact"
            data-testid={`treatment-plan-block-${plan.id}`}
        >
            <div className="flex items-center justify-between gap-compact">
                <div className="flex items-center gap-tight">
                    <StatusBadge variant={STATUS_VARIANT[plan.status]}>
                        {t(`status.${plan.status}` as Parameters<typeof t>[0])}
                    </StatusBadge>
                    <StatusBadge
                        variant={STRATEGY_VARIANT[plan.strategy]}
                        data-testid="treatment-plan-strategy-badge"
                    >
                        {t(`strategy.${plan.strategy}` as Parameters<typeof t>[0])}
                    </StatusBadge>
                    <span className="text-sm text-content-muted">
                        {t('target', { date: formatDate(plan.targetDate) })}
                    </span>
                </div>
                <div className="flex gap-tight">
                    {canWrite && plan.status !== 'COMPLETED' ? (
                        <Button
                            variant="secondary"
                            onClick={onAddMilestone}
                            data-testid="treatment-plan-add-milestone-button"
                        >
                            {t('addMilestone')}
                        </Button>
                    ) : null}
                    {canCloseNow ? (
                        <Button
                            onClick={onComplete}
                            data-testid="treatment-plan-complete-button"
                        >
                            {t('completePlan')}
                        </Button>
                    ) : null}
                </div>
            </div>

            <div className="flex items-center gap-compact">
                <ProgressBar
                    value={pct}
                    variant={pct >= 100 ? 'success' : pct >= 50 ? 'info' : 'brand'}
                    aria-label={t('milestonesAria', { done, total })}
                    className="w-full sm:w-64"
                    data-testid="treatment-plan-progress"
                />
                <span
                    className="text-xs text-content-muted whitespace-nowrap"
                    data-testid="treatment-plan-progress-label"
                >
                    {t('milestonesCount', { done, total })}
                </span>
            </div>

            <p className="text-xs text-content-muted">
                {t('owner', { owner: plan.owner.name || plan.owner.email })}
            </p>

            {plan.milestones.length > 0 ? (
                <ul
                    className="space-y-1"
                    data-testid="treatment-plan-milestones"
                >
                    {plan.milestones.map((m) => (
                        <MilestoneRowItem
                            key={m.id}
                            apiBase={apiBase}
                            planId={plan.id}
                            milestone={m}
                            canWrite={canWrite && plan.status !== 'COMPLETED'}
                            onMutated={onMutated}
                        />
                    ))}
                </ul>
            ) : (
                <p className="text-sm text-content-muted">
                    {t('milestonesEmpty')}{' '}
                    {canWrite && plan.status !== 'COMPLETED' ? (
                        <span>
                            {t('addFirstMilestone')}
                        </span>
                    ) : null}
                </p>
            )}

            {plan.status === 'COMPLETED' && plan.closingRemark ? (
                <p className="mt-2 text-xs text-content-muted">
                    <strong>{t('closingRemarkPrefix')}</strong> {plan.closingRemark}
                </p>
            ) : null}
        </div>
    );
}

function MilestoneRowItem({
    apiBase,
    planId,
    milestone,
    canWrite,
    onMutated,
}: {
    apiBase: string;
    planId: string;
    milestone: MilestoneRow;
    canWrite: boolean;
    onMutated: () => void;
}) {
    const t = useTranslations('panels.treatment');
    const toast = useToast();
    const completed = milestone.completedAt !== null;
    const [completing, setCompleting] = useState(false);
    const handleComplete = async () => {
        setCompleting(true);
        try {
            const res = await fetch(
                `${apiBase}/${planId}/milestones/${milestone.id}/complete`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({}),
                },
            );
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || t('milestoneCompleteFailed'));
            }
            onMutated();
        } catch (err) {
            // Surface the failure: the checkbox is driven by
            // `milestone.completedAt` (server state), so on failure it snaps
            // back unchecked — without a toast the click just looked ignored.
            toast.error(err instanceof Error ? err.message : t('milestoneCompleteFailed'));
        } finally {
            setCompleting(false);
        }
    };
    return (
        <li
            className="flex items-center gap-compact py-1"
            data-testid={`treatment-plan-milestone-${milestone.id}`}
        >
            <input
                type="checkbox"
                checked={completed}
                disabled={!canWrite || completed || completing}
                onChange={() => {
                    if (!completed && canWrite) void handleComplete();
                }}
                aria-label={t('completeMilestoneAria', { title: milestone.title })}
                data-testid={`treatment-plan-milestone-checkbox-${milestone.id}`}
                className="h-4 w-4 rounded border-border-subtle text-brand-emphasis"
            />
            <span
                className={
                    completed
                        ? 'text-sm text-content-muted line-through'
                        : 'text-sm text-content-default'
                }
            >
                {milestone.title}
            </span>
            <span className="ml-auto text-xs text-content-muted">
                {t('dueMilestone', { date: formatDate(milestone.dueDate) })}
            </span>
        </li>
    );
}

// ─── Dialogs ─────────────────────────────────────────────────────────

function CreatePlanDialog({
    apiBase,
    riskId,
    ownerChoices,
    treatment,
    onClose,
    onSuccess,
}: {
    apiBase: string;
    riskId: string;
    ownerChoices: readonly OwnerChoice[];
    treatment?: string | null;
    onClose: () => void;
    onSuccess: () => void;
}) {
    const t = useTranslations('panels.treatment');
    const STRATEGY_OPTIONS: ComboboxOption[] = useMemo(() => [
        { value: 'MITIGATE', label: t('optMitigate') },
        { value: 'ACCEPT', label: t('optAccept') },
        { value: 'TRANSFER', label: t('optTransfer') },
        { value: 'AVOID', label: t('optAvoid') },
    ], [t]);
    // PR-K — seed from the risk's decision so "Accept" → ACCEPT, not MITIGATE.
    const [strategy, setStrategy] = useState<Strategy>(() => strategyFromDecision(treatment));
    const [ownerUserId, setOwnerUserId] = useState<string>(
        ownerChoices[0]?.userId ?? '',
    );
    const [targetDate, setTargetDate] = useState<Date | null>(null);
    const [error, setError] = useState<string | null>(null);

    const ownerOptions: ComboboxOption[] = useMemo(
        () =>
            ownerChoices.map((c) => ({
                value: c.userId,
                label: c.label,
            })),
        [ownerChoices],
    );

    const [submitting, setSubmitting] = useState(false);
    const handleSubmit = async () => {
        setSubmitting(true);
        try {
            setError(null);
            if (!targetDate) {
                throw new Error(t('targetDateRequired'));
            }
            const res = await fetch(apiBase, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    riskId,
                    strategy,
                    ownerUserId,
                    targetDate: targetDate.toISOString(),
                }),
            });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || t('createPlanFailed'));
            }
            onSuccess();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('unknownError'));
        } finally {
            setSubmitting(false);
        }
    };

    const valid = strategy && ownerUserId && targetDate;

    return (
        <Modal showModal setShowModal={(v) => !v && onClose()}>
            <Modal.Header title={t('create')} />
            <Modal.Body>
                <div className="space-y-default">
                    <FormField label={t('strategyLabel')} required>
                        <Combobox
                            options={STRATEGY_OPTIONS}
                            selected={
                                STRATEGY_OPTIONS.find(
                                    (o) => o.value === strategy,
                                ) ?? null
                            }
                            setSelected={(opt) =>
                                opt && setStrategy(opt.value as Strategy)
                            }
                            placeholder={t('pickStrategy')}
                            data-testid="treatment-plan-form-strategy"
                        />
                    </FormField>
                    <FormField label={t('ownerLabel')} required>
                        <Combobox
                            options={ownerOptions}
                            selected={
                                ownerOptions.find(
                                    (o) => o.value === ownerUserId,
                                ) ?? null
                            }
                            setSelected={(opt) =>
                                opt && setOwnerUserId(String(opt.value))
                            }
                            placeholder={t('pickOwner')}
                            data-testid="treatment-plan-form-owner"
                        />
                    </FormField>
                    <FormField label={t('targetDateLabel')} required>
                        <DatePicker value={targetDate} onChange={setTargetDate} />
                    </FormField>
                    {error ? (
                        <p
                            className="text-sm text-content-error"
                            data-testid="treatment-plan-form-error"
                        >
                            {error}
                        </p>
                    ) : null}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Button variant="secondary" onClick={onClose}>
                    {t('cancel')}
                </Button>
                <Button
                    onClick={() => void handleSubmit()}
                    disabled={!valid || submitting}
                    data-testid="treatment-plan-form-submit"
                >
                    {submitting ? t('creating') : t('createPlan')}
                </Button>
            </Modal.Footer>
        </Modal>
    );
}

function AddMilestoneDialog({
    apiBase,
    planId,
    onClose,
    onSuccess,
}: {
    apiBase: string;
    planId: string;
    onClose: () => void;
    onSuccess: () => void;
}) {
    const t = useTranslations('panels.treatment');
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [dueDate, setDueDate] = useState<Date | null>(null);
    const [error, setError] = useState<string | null>(null);

    const [submitting, setSubmitting] = useState(false);
    const handleSubmit = async () => {
        setSubmitting(true);
        try {
            setError(null);
            if (!dueDate) throw new Error(t('dueDateRequired'));
            const res = await fetch(`${apiBase}/${planId}/milestones`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title,
                    description: description || undefined,
                    dueDate: dueDate.toISOString(),
                }),
            });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || t('addMilestoneFailed'));
            }
            onSuccess();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('unknownError'));
        } finally {
            setSubmitting(false);
        }
    };

    const valid = title.trim().length > 0 && dueDate;

    return (
        <Modal showModal setShowModal={(v) => !v && onClose()}>
            <Modal.Header title={t('addMilestoneHeader')} />
            <Modal.Body>
                <div className="space-y-default">
                    <FormField label={t('milestoneTitleLabel')} required>
                        <Input
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder={t('milestonePlaceholder')}
                            data-testid="milestone-form-title"
                        />
                    </FormField>
                    <FormField label={t('descriptionOptional')}>
                        <Textarea
                            rows={3}
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                        />
                    </FormField>
                    <FormField label={t('dueDateLabel')} required>
                        <DatePicker value={dueDate} onChange={setDueDate} />
                    </FormField>
                    {error ? (
                        <p
                            className="text-sm text-content-error"
                            data-testid="milestone-form-error"
                        >
                            {error}
                        </p>
                    ) : null}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Button variant="secondary" onClick={onClose}>
                    {t('cancel')}
                </Button>
                <Button
                    onClick={() => void handleSubmit()}
                    disabled={!valid || submitting}
                    data-testid="milestone-form-submit"
                >
                    {submitting ? t('adding') : t('addMilestone')}
                </Button>
            </Modal.Footer>
        </Modal>
    );
}

function CompletePlanDialog({
    apiBase,
    planId,
    onClose,
    onSuccess,
}: {
    apiBase: string;
    planId: string;
    onClose: () => void;
    onSuccess: () => void;
}) {
    const t = useTranslations('panels.treatment');
    const [closingRemark, setClosingRemark] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const handleSubmit = async () => {
        setSubmitting(true);
        try {
            setError(null);
            const res = await fetch(`${apiBase}/${planId}/complete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ closingRemark }),
            });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || t('completePlanFailed'));
            }
            onSuccess();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('unknownError'));
        } finally {
            setSubmitting(false);
        }
    };
    return (
        <Modal showModal setShowModal={(v) => !v && onClose()}>
            <Modal.Header title={t('completeHeader')} />
            <Modal.Body>
                <div className="space-y-default">
                    <p className="text-sm text-content-muted">
                        {t('completeIntro')}{' '}
                        <strong>{t('completeRule1')}</strong>,{' '}
                        <strong>{t('completeRule2')}</strong>.
                    </p>
                    <FormField label={t('closingRemarkLabel')} required>
                        <Textarea
                            rows={3}
                            value={closingRemark}
                            onChange={(e) => setClosingRemark(e.target.value)}
                            placeholder={t('closingRemarkPlaceholder')}
                            data-testid="complete-plan-remark"
                        />
                    </FormField>
                    {error ? (
                        <p
                            className="text-sm text-content-error"
                            data-testid="complete-plan-error"
                        >
                            {error}
                        </p>
                    ) : null}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Button variant="secondary" onClick={onClose}>
                    {t('cancel')}
                </Button>
                <Button
                    onClick={() => void handleSubmit()}
                    disabled={!closingRemark.trim() || submitting}
                    data-testid="complete-plan-submit"
                >
                    {submitting ? t('completing') : t('completePlan')}
                </Button>
            </Modal.Footer>
        </Modal>
    );
}
