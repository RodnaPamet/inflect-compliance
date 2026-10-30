'use client';

/**
 * Finding detail side panel (#4461).
 *
 * Opened by a click on a register row, or by `?finding=<id>` on the register's
 * URL (the address other surfaces link to — there is no `/findings/[id]`
 * route). It shows every field the create dialog collects, read from
 * `GET /findings/:id`, and for a role with the write tier an Edit form that
 * saves through the existing `PUT /findings/:id`.
 *
 * Two things the form does deliberately:
 *   - It sends only the fields that CHANGED. `updateFinding` re-validates every
 *     reference it is given, so resending an assignee who has since left the
 *     tenant would refuse an edit to the title.
 *   - The originating audit is shown and not edited: the update route does not
 *     accept `auditId`, so a picker here would be a control that saves nothing.
 *
 * There is no delete (owner decision, 2026-10-29).
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantHref } from '@/lib/tenant-context-provider';
import { CACHE_KEYS } from '@/lib/swr-keys';
import type { CappedList } from '@/lib/list-backfill-cap';
import { apiErrorMessage } from '@/lib/api-error';
import { ownerDisplayName } from '@/lib/owner-display';
import { Sheet } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { FormSection } from '@/components/ui/form-section';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { UserCombobox } from '@/components/ui/user-combobox';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import { parseYMD, startOfUtcDay, toYMD } from '@/components/ui/date-picker/date-utils';
import { textLinkVariants } from '@/components/ui/typography';
import { useToast } from '@/components/ui/hooks';
import { formatDate } from '@inflect/ui/lib/format-date';
import { Pen2 } from '@inflect/ui/components/ui/icons/nucleo';

const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
const TYPES = ['NONCONFORMITY', 'OBSERVATION', 'OPPORTUNITY'] as const;
const SEV_BADGE: Record<string, StatusBadgeVariant> = { LOW: 'info', MEDIUM: 'warning', HIGH: 'error', CRITICAL: 'error' };
const STATUS_BADGE: Record<string, StatusBadgeVariant> = { OPEN: 'error', IN_PROGRESS: 'info', READY_FOR_VERIFICATION: 'warning', CLOSED: 'success' };
const STATUS_KEY: Record<string, string> = {
    OPEN: 'open',
    IN_PROGRESS: 'inProgress',
    READY_FOR_VERIFICATION: 'readyForVerification',
    CLOSED: 'closed',
};

/** `GET /findings/:id` → `FindingRepository.getById` (the fields this panel reads). */
export interface FindingDetail {
    id: string;
    title: string;
    description: string;
    severity: string;
    type: string;
    status: string;
    analysis: string | null;
    owner: string | null;
    dueDate: string | null;
    assigneeUserId: string | null;
    controlId: string | null;
    compensatingControlId: string | null;
    assignee: { id: string; name: string | null; email: string | null } | null;
    control: { id: string; code: string | null; name: string } | null;
    compensatingControl: { id: string; code: string | null; name: string } | null;
    audit: { id: string; title: string } | null;
    riskLinks: Array<{ risk: { id: string; key: string | null; title: string } }>;
}

interface EditForm {
    title: string;
    description: string;
    severity: string;
    type: string;
    assigneeUserId: string;
    controlId: string;
    compensatingControlId: string;
    dueDate: string;
    analysis: string;
    riskIds: string[];
}

function formFromDetail(f: FindingDetail): EditForm {
    return {
        title: f.title,
        description: f.description ?? '',
        severity: f.severity,
        type: f.type,
        assigneeUserId: f.assigneeUserId ?? '',
        controlId: f.controlId ?? '',
        compensatingControlId: f.compensatingControlId ?? '',
        dueDate: f.dueDate ? (toYMD(new Date(f.dueDate)) ?? '') : '',
        analysis: f.analysis ?? '',
        riskIds: f.riskLinks.map((l) => l.risk.id).sort(),
    };
}

/**
 * The PUT body: only what changed. Empty optional fields are sent as `null`,
 * which `updateFinding` reads as "clear".
 */
export function changedFields(initial: EditForm, form: EditForm): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const title = form.title.trim();
    if (title !== initial.title) out.title = title;
    const description = form.description.trim();
    if (description !== initial.description) out.description = description;
    if (form.severity !== initial.severity) out.severity = form.severity;
    if (form.type !== initial.type) out.type = form.type;
    for (const key of ['assigneeUserId', 'controlId', 'compensatingControlId', 'dueDate'] as const) {
        if (form[key] !== initial[key]) out[key] = form[key] || null;
    }
    const analysis = form.analysis.trim();
    if (analysis !== initial.analysis) out.analysis = analysis || null;
    const risks = [...form.riskIds].sort();
    if (risks.join('\u0000') !== initial.riskIds.join('\u0000')) out.riskIds = risks;
    return out;
}

interface ControlOption { id: string; annexId?: string | null; code?: string | null; name: string }
interface RiskOption { id: string; key: string | null; title: string }

export interface FindingDetailSheetProps {
    /** The finding to show; `null` closes the panel. */
    findingId: string | null;
    onClose: () => void;
    /** The coarse write tier — `updateFinding` asserts it and nothing more. */
    canWrite: boolean;
    tenantSlug: string;
    /** Called after a successful save, so the register can refetch. */
    onSaved?: () => void;
}

export function FindingDetailSheet({ findingId, onClose, canWrite, tenantSlug, onSaved }: FindingDetailSheetProps) {
    const t = useTranslations('findings');
    const tenantHref = useTenantHref();
    const [editing, setEditing] = useState(false);

    // A different finding (or a closed panel) always starts in the read view.
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setEditing(false);
    }, [findingId]);

    const detailQuery = useTenantSWR<FindingDetail>(
        findingId ? CACHE_KEYS.findings.detail(findingId) : null,
    );
    const finding = detailQuery.data;

    const statusLabel = (s: string) => (STATUS_KEY[s] ? t(STATUS_KEY[s]) : s);
    const controlLabel = (c: { code: string | null; name: string }) => (c.code ? `${c.code} · ${c.name}` : c.name);

    return (
        <Sheet
            open={findingId !== null}
            onOpenChange={(open) => {
                if (!open) onClose();
            }}
            size="md"
            title={finding?.title ?? t('detail.sheetTitle')}
        >
            {detailQuery.error ? (
                <>
                    <Sheet.Header title={t('detail.errorTitle')} />
                    <Sheet.Body>
                        <div
                            className="rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            role="alert"
                            data-testid="finding-sheet-error"
                        >
                            {detailQuery.error instanceof Error && detailQuery.error.message
                                ? detailQuery.error.message
                                : t('detail.loadFailed')}
                        </div>
                    </Sheet.Body>
                </>
            ) : detailQuery.isLoading || !finding ? (
                <>
                    <Sheet.Header title={t('detail.loadingTitle')} />
                    <Sheet.Body>
                        <div className="flex h-40 items-center justify-center text-sm text-content-muted">
                            {t('detail.loadingBody')}
                        </div>
                    </Sheet.Body>
                </>
            ) : editing && canWrite ? (
                <FindingEditForm
                    finding={finding}
                    tenantSlug={tenantSlug}
                    onCancel={() => setEditing(false)}
                    onSaved={async () => {
                        await detailQuery.mutate();
                        onSaved?.();
                        setEditing(false);
                    }}
                />
            ) : (
                <>
                    <Sheet.Header title={finding.title}>
                        <div className="flex flex-wrap items-center gap-tight">
                            <StatusBadge variant={SEV_BADGE[finding.severity] ?? 'neutral'} id="finding-sheet-severity">
                                {t(`severityOptions.${finding.severity}`)}
                            </StatusBadge>
                            <StatusBadge tone="subtle" variant={STATUS_BADGE[finding.status] ?? 'neutral'} id="finding-sheet-status">
                                {statusLabel(finding.status)}
                            </StatusBadge>
                        </div>
                    </Sheet.Header>
                    <Sheet.Body>
                        <div className="space-y-section" data-testid="finding-sheet-detail">
                            <dl className="grid grid-cols-1 gap-1">
                                <DetailRow label={t('create.labelType')} id="finding-sheet-type">
                                    {t(`typeOptions.${finding.type}`)}
                                </DetailRow>
                                <DetailRow label={t('create.labelAssignee')} id="finding-sheet-assignee">
                                    {ownerDisplayName(finding.assignee?.name, finding.assignee?.email)
                                        ?? finding.owner
                                        ?? t('create.placeholderUnassigned')}
                                </DetailRow>
                                <DetailRow label={t('create.labelDueDate')} id="finding-sheet-due-date">
                                    {formatDate(finding.dueDate)}
                                </DetailRow>
                                <DetailRow label={t('create.labelOriginatingAudit')} id="finding-sheet-audit">
                                    {finding.audit ? (
                                        <Link
                                            href={tenantHref(`/audits?selected=${finding.audit.id}`)}
                                            className={textLinkVariants({ tone: 'link' })}
                                        >
                                            {finding.audit.title}
                                        </Link>
                                    ) : (
                                        t('adHoc')
                                    )}
                                </DetailRow>
                            </dl>

                            <DetailBlock label={t('create.labelDescription')} id="finding-sheet-description">
                                {finding.description || '—'}
                            </DetailBlock>

                            <dl className="grid grid-cols-1 gap-1">
                                <DetailRow label={t('create.labelLinkedControl')} id="finding-sheet-control">
                                    {finding.control ? (
                                        <Link
                                            href={tenantHref(`/controls/${finding.control.id}`)}
                                            className={textLinkVariants({ tone: 'link' })}
                                        >
                                            {controlLabel(finding.control)}
                                        </Link>
                                    ) : (
                                        '—'
                                    )}
                                </DetailRow>
                                <DetailRow label={t('create.labelCompensatingControl')} id="finding-sheet-compensating-control">
                                    {finding.compensatingControl ? (
                                        <Link
                                            href={tenantHref(`/controls/${finding.compensatingControl.id}`)}
                                            className={textLinkVariants({ tone: 'link' })}
                                        >
                                            {controlLabel(finding.compensatingControl)}
                                        </Link>
                                    ) : (
                                        '—'
                                    )}
                                </DetailRow>
                            </dl>

                            <div className="space-y-tight" id="finding-sheet-risks">
                                <p className="text-xs font-medium uppercase tracking-widest text-content-subtle">
                                    {t('detail.labelRisks')}
                                </p>
                                {finding.riskLinks.length === 0 ? (
                                    <p className="text-sm text-content-muted">{t('detail.noRisks')}</p>
                                ) : (
                                    <ul className="space-y-tight">
                                        {finding.riskLinks.map(({ risk }) => (
                                            <li key={risk.id} className="text-sm">
                                                <Link
                                                    href={tenantHref(`/risks/${risk.id}`)}
                                                    className={textLinkVariants({ tone: 'link' })}
                                                >
                                                    {risk.key ? `${risk.key} — ` : ''}
                                                    {risk.title}
                                                </Link>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>

                            <DetailBlock label={t('create.labelAnalysis')} id="finding-sheet-analysis">
                                {finding.analysis || '—'}
                            </DetailBlock>
                        </div>
                    </Sheet.Body>
                    {canWrite && (
                        <Sheet.Actions>
                            <Button
                                variant="secondary"
                                size="sm"
                                icon={<Pen2 />}
                                id="finding-sheet-edit-btn"
                                onClick={() => setEditing(true)}
                            >
                                {t('detail.edit')}
                            </Button>
                        </Sheet.Actions>
                    )}
                </>
            )}
        </Sheet>
    );
}

function DetailRow({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
    return (
        <div className="flex items-baseline justify-between gap-default text-sm">
            <dt className="text-content-muted">{label}</dt>
            <dd className="text-right text-content-default" id={id}>
                {children}
            </dd>
        </div>
    );
}

function DetailBlock({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
    return (
        <div className="space-y-tight">
            <p className="text-xs font-medium uppercase tracking-widest text-content-subtle">{label}</p>
            <p className="whitespace-pre-wrap text-sm text-content-default" id={id}>
                {children}
            </p>
        </div>
    );
}

function FindingEditForm({
    finding,
    tenantSlug,
    onCancel,
    onSaved,
}: {
    finding: FindingDetail;
    tenantSlug: string;
    onCancel: () => void;
    onSaved: () => Promise<void>;
}) {
    const t = useTranslations('findings');
    const toast = useToast();
    const initial = useMemo(() => formFromDetail(finding), [finding]);
    const [form, setForm] = useState<EditForm>(initial);
    const [riskFilter, setRiskFilter] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const update = <K extends keyof EditForm>(key: K, value: EditForm[K]) =>
        setForm((prev) => ({ ...prev, [key]: value }));

    const severityOptions = useMemo<ComboboxOption[]>(
        () => SEVERITIES.map((v) => ({ value: v, label: t(`severityOptions.${v}`) })),
        [t],
    );
    const typeOptions = useMemo<ComboboxOption[]>(
        () => TYPES.map((v) => ({ value: v, label: t(`typeOptions.${v}`) })),
        [t],
    );

    // The same lookups the create dialog reads (both lists are capped
    // `{ rows, truncated }` responses).
    const controlsQuery = useTenantSWR<CappedList<ControlOption> | ControlOption[]>(CACHE_KEYS.controls.list());
    const risksQuery = useTenantSWR<CappedList<RiskOption> | RiskOption[]>(CACHE_KEYS.risks.list());
    const controlOptions = useMemo<ComboboxOption[]>(() => {
        const data = controlsQuery.data;
        const rows = Array.isArray(data) ? data : (data?.rows ?? []);
        const options = rows.map((c) => {
            const code = c.annexId ?? c.code ?? null;
            return { value: c.id, label: code ? `${code} · ${c.name}` : c.name };
        });
        // A linked control the list does not return (past its cap) must still
        // read as selected rather than as "None".
        for (const c of [finding.control, finding.compensatingControl]) {
            if (c && !options.some((o) => o.value === c.id)) {
                options.push({ value: c.id, label: c.code ? `${c.code} · ${c.name}` : c.name });
            }
        }
        return options;
    }, [controlsQuery.data, finding.control, finding.compensatingControl]);
    const risks = useMemo<RiskOption[]>(() => {
        const data = risksQuery.data;
        const rows = Array.isArray(data) ? data : (data?.rows ?? []);
        const all = rows.map((r) => ({ id: r.id, key: r.key ?? null, title: r.title }));
        for (const { risk } of finding.riskLinks) {
            if (!all.some((r) => r.id === risk.id)) all.push(risk);
        }
        return all;
    }, [risksQuery.data, finding.riskLinks]);
    const filteredRisks = useMemo(() => {
        const q = riskFilter.trim().toLowerCase();
        if (!q) return risks;
        return risks.filter((r) => r.title.toLowerCase().includes(q) || (r.key ?? '').toLowerCase().includes(q));
    }, [risks, riskFilter]);

    const toggleRisk = (id: string) =>
        setForm((prev) => ({
            ...prev,
            riskIds: prev.riskIds.includes(id) ? prev.riskIds.filter((r) => r !== id) : [...prev.riskIds, id],
        }));

    const canSave = form.title.trim().length > 0 && form.description.trim().length > 0 && !saving;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!canSave) return;
        const payload = changedFields(initial, form);
        if (Object.keys(payload).length === 0) {
            onCancel();
            return;
        }
        setSaving(true);
        setError('');
        try {
            const res = await fetch(`/api/t/${tenantSlug}/findings/${finding.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                setError(apiErrorMessage(body, t('detail.saveFailed', { status: res.status })));
                setSaving(false);
                return;
            }
            toast.success(t('detail.saved'));
            await onSaved();
        } catch {
            setError(t('detail.saveFailedGeneric'));
            setSaving(false);
        }
    };

    return (
        <>
            <Sheet.Header title={t('detail.editTitle')} description={finding.title} />
            <Sheet.Body>
                <form id="finding-edit-form" onSubmit={handleSubmit} data-testid="finding-edit-form">
                    {error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            role="alert"
                            id="finding-edit-error"
                            data-testid="finding-edit-error"
                        >
                            {error}
                        </div>
                    )}
                    <fieldset disabled={saving} className="m-0 border-0 p-0">
                        <FormSection eyebrow={t('create.sectionDetails')}>
                            <FormField label={t('create.labelTitle')} required>
                                <Input
                                    id="finding-edit-title"
                                    type="text"
                                    value={form.title}
                                    onChange={(e) => update('title', e.target.value)}
                                    required
                                    autoComplete="off"
                                />
                            </FormField>
                            <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                                <FormField label={t('create.labelType')}>
                                    <Combobox
                                        id="finding-edit-type"
                                        name="type"
                                        options={typeOptions}
                                        selected={typeOptions.find((o) => o.value === form.type) ?? null}
                                        setSelected={(o) => update('type', o?.value ?? form.type)}
                                        hideSearch
                                        matchTriggerWidth
                                        buttonProps={{ className: 'w-full' }}
                                        caret
                                    />
                                </FormField>
                                <FormField label={t('create.labelSeverity')}>
                                    <Combobox
                                        id="finding-edit-severity"
                                        name="severity"
                                        options={severityOptions}
                                        selected={severityOptions.find((o) => o.value === form.severity) ?? null}
                                        setSelected={(o) => update('severity', o?.value ?? form.severity)}
                                        hideSearch
                                        matchTriggerWidth
                                        buttonProps={{ className: 'w-full' }}
                                        caret
                                    />
                                </FormField>
                            </div>
                            <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                                <FormField label={t('create.labelAssignee')}>
                                    <UserCombobox
                                        tenantSlug={tenantSlug}
                                        selectedId={form.assigneeUserId || null}
                                        onChange={(userId) => update('assigneeUserId', userId ?? '')}
                                        matchTriggerWidth
                                        id="finding-edit-assignee"
                                        placeholder={t('create.placeholderUnassigned')}
                                    />
                                </FormField>
                                <FormField label={t('create.labelDueDate')}>
                                    <DatePicker
                                        id="finding-edit-due-date"
                                        className="w-full"
                                        placeholder={t('create.placeholderSelectDate')}
                                        clearable
                                        align="start"
                                        value={parseYMD(form.dueDate)}
                                        onChange={(next) => update('dueDate', toYMD(next) ?? '')}
                                        disabledDays={{ before: startOfUtcDay(new Date()) }}
                                        aria-label={t('create.ariaDueDate')}
                                    />
                                </FormField>
                            </div>
                            <FormField label={t('create.labelDescription')} required>
                                <Textarea
                                    id="finding-edit-description"
                                    rows={3}
                                    value={form.description}
                                    onChange={(e) => update('description', e.target.value)}
                                    required
                                />
                            </FormField>
                        </FormSection>

                        <FormSection eyebrow={t('create.sectionControlsRisks')}>
                            <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                                <FormField label={t('create.labelLinkedControl')}>
                                    <Combobox
                                        id="finding-edit-control"
                                        name="controlId"
                                        options={controlOptions}
                                        selected={controlOptions.find((o) => o.value === form.controlId) ?? null}
                                        setSelected={(o) => update('controlId', o?.value ?? '')}
                                        loading={controlsQuery.isLoading}
                                        placeholder={t('create.placeholderNone')}
                                        searchPlaceholder={t('create.searchControls')}
                                        emptyState={t('create.emptyControls')}
                                        matchTriggerWidth
                                        forceDropdown
                                        buttonProps={{ className: 'w-full' }}
                                        caret
                                    />
                                </FormField>
                                <FormField label={t('create.labelCompensatingControl')}>
                                    <Combobox
                                        id="finding-edit-compensating-control"
                                        name="compensatingControlId"
                                        options={controlOptions}
                                        selected={controlOptions.find((o) => o.value === form.compensatingControlId) ?? null}
                                        setSelected={(o) => update('compensatingControlId', o?.value ?? '')}
                                        loading={controlsQuery.isLoading}
                                        placeholder={t('create.placeholderNone')}
                                        searchPlaceholder={t('create.searchControls')}
                                        emptyState={t('create.emptyControls')}
                                        matchTriggerWidth
                                        forceDropdown
                                        buttonProps={{ className: 'w-full' }}
                                        caret
                                    />
                                </FormField>
                            </div>
                            <FormField label={t('create.labelImplicatedRisks', { count: form.riskIds.length })}>
                                <div className="rounded-lg border border-border-subtle bg-bg-subtle">
                                    <div className="border-b border-border-subtle p-2">
                                        <Input
                                            id="finding-edit-risk-filter"
                                            type="text"
                                            placeholder={t('create.searchRisks')}
                                            value={riskFilter}
                                            onChange={(e) => setRiskFilter(e.target.value)}
                                            autoComplete="off"
                                        />
                                    </div>
                                    <div className="max-h-40 space-y-1 overflow-y-auto p-2" data-testid="finding-edit-risks-list">
                                        {risksQuery.isLoading ? (
                                            <p className="px-1 py-1 text-sm text-content-muted">{t('create.loadingRisks')}</p>
                                        ) : filteredRisks.length === 0 ? (
                                            <p className="px-1 py-1 text-sm text-content-muted">{t('create.risksToLinkEmpty')}</p>
                                        ) : (
                                            filteredRisks.map((r) => (
                                                <label
                                                    key={r.id}
                                                    className="flex cursor-pointer items-center gap-tight rounded px-1 py-1 text-sm text-content-default hover:bg-bg-muted"
                                                >
                                                    <Checkbox
                                                        size="sm"
                                                        checked={form.riskIds.includes(r.id)}
                                                        onCheckedChange={() => toggleRisk(r.id)}
                                                        data-testid={`finding-edit-risk-opt-${r.id}`}
                                                    />
                                                    <span className="w-16 shrink-0 text-xs text-content-muted">{r.key || 'RISK'}</span>
                                                    <span className="truncate text-content-emphasis">{r.title}</span>
                                                </label>
                                            ))
                                        )}
                                    </div>
                                </div>
                            </FormField>
                        </FormSection>

                        <FormSection eyebrow={t('create.sectionAnalysis')}>
                            <FormField label={t('create.labelAnalysis')} description={t('create.descAnalysis')}>
                                <Textarea
                                    id="finding-edit-analysis"
                                    rows={3}
                                    value={form.analysis}
                                    onChange={(e) => update('analysis', e.target.value)}
                                />
                            </FormField>
                        </FormSection>
                    </fieldset>
                </form>
            </Sheet.Body>
            <Sheet.Actions>
                <Button variant="secondary" size="sm" id="finding-edit-cancel-btn" onClick={onCancel} disabled={saving}>
                    {t('create.cancel')}
                </Button>
                <Button
                    type="submit"
                    form="finding-edit-form"
                    variant="primary"
                    size="sm"
                    id="finding-edit-save-btn"
                    disabled={!canSave}
                >
                    {saving ? t('detail.saving') : t('detail.save')}
                </Button>
            </Sheet.Actions>
        </>
    );
}
