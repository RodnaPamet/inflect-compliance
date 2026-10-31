'use client';

/**
 * Create-finding modal.
 *
 * Replaces the inline create form on the findings list with a modal that
 * captures the full finding shape: title/description/type/severity/due
 * date PLUS an assignee (tenant member), a linked control, a compensating
 * control, multiple implicated risks, and a free-text analysis.
 *
 * Business contract — POST /api/t/:slug/findings with
 *   { title, description, severity, type, dueDate?, analysis?,
 *     assigneeUserId?, controlId?, compensatingControlId?, riskIds[] }
 * The server validates every referenced id against the tenant. On success
 * the findings list cache is invalidated.
 */
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
} from 'react';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useSWRConfig } from 'swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import type { CappedList } from '@/lib/list-backfill-cap';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { FormSection } from '@/components/ui/form-section';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { UserCombobox } from '@/components/ui/user-combobox';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import {
    parseYMD,
    startOfUtcDay,
    toYMD,
} from '@/components/ui/date-picker/date-utils';
import { useFormTelemetry } from '@/lib/telemetry/form-telemetry';
import { apiErrorMessage } from '@/lib/api-error';

interface ControlOption {
    id: string;
    annexId: string | null;
    name: string;
}

interface RiskOption {
    id: string;
    key: string | null;
    title: string;
}

interface AuditOption {
    id: string;
    title: string;
}

const buildSeverityOptions = (t: (key: string) => string): ComboboxOption[] =>
    ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((v) => ({ value: v, label: t(`severityOptions.${v}`) }));
const buildTypeOptions = (t: (key: string) => string): ComboboxOption[] =>
    ['NONCONFORMITY', 'OBSERVATION', 'OPPORTUNITY'].map((v) => ({ value: v, label: t(`typeOptions.${v}`) }));

const EMPTY_FORM = {
    title: '',
    description: '',
    severity: 'MEDIUM',
    type: 'OBSERVATION',
    assigneeUserId: '',
    controlId: '',
    compensatingControlId: '',
    analysis: '',
    dueDate: '',
    // Optional provenance — attribute a register-created finding to the
    // audit (and thereby the cycle) it was raised during.
    auditId: '',
};

export interface CreateFindingModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    tenantSlug: string;
    apiUrl: (path: string) => string;
}

export function CreateFindingModal({
    open,
    setOpen,
    tenantSlug,
    apiUrl,
}: CreateFindingModalProps) {
    const tx = useTranslations('findings');
    const SEVERITY_OPTIONS = useMemo(() => buildSeverityOptions(tx), [tx]);
    const TYPE_OPTIONS = useMemo(() => buildTypeOptions(tx), [tx]);
    const close = useCallback(() => setOpen(false), [setOpen]);
    const { mutate: swrMutate } = useSWRConfig();
    const titleRef = useRef<HTMLInputElement>(null);
    const telemetry = useFormTelemetry('CreateFindingModal');

    const [form, setForm] = useState({ ...EMPTY_FORM });
    const [selectedRiskIds, setSelectedRiskIds] = useState<Set<string>>(new Set());
    const [riskFilter, setRiskFilter] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    const update = <K extends keyof typeof form>(field: K, value: (typeof form)[K]) =>
        setForm((prev) => ({ ...prev, [field]: value }));

    // ── Lookups load while the modal is open ──
    // Null-key idiom gates the fetch on `open` (replaces `enabled: open`).
    const controlsQuery = useTenantSWR<CappedList<ControlOption> | ControlOption[]>(
        open ? CACHE_KEYS.controls.list() : null,
    );
    const controls = useMemo<ControlOption[]>(() => {
        const data = controlsQuery.data;
        // GET /controls returns the backfill-capped `{ rows, truncated }`
        // shape, not a bare array — unwrap both forms (mirrors the risks
        // dropdown below). The prior bare-array-only guard silently rendered
        // an EMPTY control picker, so a finding could never be linked to a
        // control at create time.
        const rows = Array.isArray(data) ? data : (data?.rows ?? []);
        return rows.map((c) => ({
            id: c.id,
            annexId: c.annexId ?? null,
            name: c.name,
        }));
    }, [controlsQuery.data]);

    const risksQuery = useTenantSWR<CappedList<RiskOption> | RiskOption[]>(
        open ? CACHE_KEYS.risks.list() : null,
    );
    const risks = useMemo<RiskOption[]>(() => {
        const data = risksQuery.data;
        const rows = Array.isArray(data) ? data : (data?.rows ?? []);
        return rows.map((r) => ({ id: r.id, key: r.key ?? null, title: r.title }));
    }, [risksQuery.data]);

    const controlOptions = useMemo<ComboboxOption[]>(
        () =>
            controls.map((c) => ({
                value: c.id,
                label: c.annexId ? `${c.annexId} · ${c.name}` : c.name,
            })),
        [controls],
    );

    // Optional audit provenance picker — a register-created finding can be
    // attributed to the audit it was raised during (the schema accepts
    // auditId; the audit carries the cycle linkage).
    const auditsQuery = useTenantSWR<CappedList<AuditOption> | AuditOption[]>(
        open ? CACHE_KEYS.audits.list() : null,
    );
    const auditOptions = useMemo<ComboboxOption[]>(() => {
        const data = auditsQuery.data;
        const rows = Array.isArray(data) ? data : (data?.rows ?? []);
        return rows.map((a) => ({ value: a.id, label: a.title }));
    }, [auditsQuery.data]);

    const filteredRisks = useMemo(() => {
        const q = riskFilter.trim().toLowerCase();
        if (!q) return risks;
        return risks.filter(
            (r) =>
                r.title.toLowerCase().includes(q) ||
                (r.key ?? '').toLowerCase().includes(q),
        );
    }, [risks, riskFilter]);

    const toggleRisk = (id: string) =>
        setSelectedRiskIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    // ── Reset + focus on open ──
    useEffect(() => {
        if (!open) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setForm({ ...EMPTY_FORM });
        setSelectedRiskIds(new Set());
        setRiskFilter('');
        setError('');
        setSubmitting(false);
        const t = setTimeout(() => titleRef.current?.focus(), 60);
        return () => clearTimeout(t);
    }, [open]);

    const canSubmit =
        form.title.trim().length > 0 &&
        form.description.trim().length > 0 &&
        !submitting;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!canSubmit) return;
        setSubmitting(true);
        setError('');
        telemetry.trackSubmit({
            severity: form.severity,
            type: form.type,
            hasAssignee: Boolean(form.assigneeUserId),
            hasControl: Boolean(form.controlId),
            hasCompensatingControl: Boolean(form.compensatingControlId),
            hasAudit: Boolean(form.auditId),
            riskLinkCount: selectedRiskIds.size,
        });
        try {
            const payload: Record<string, unknown> = {
                title: form.title.trim(),
                description: form.description.trim(),
                severity: form.severity,
                type: form.type,
                assigneeUserId: form.assigneeUserId || undefined,
                controlId: form.controlId || undefined,
                compensatingControlId: form.compensatingControlId || undefined,
                analysis: form.analysis.trim() || undefined,
                auditId: form.auditId || undefined,
                riskIds: Array.from(selectedRiskIds),
            };
            if (form.dueDate) payload.dueDate = form.dueDate;

            const res = await fetch(apiUrl('/findings'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                // The error envelope is `{ error: { code, message } }`, so
                // `data.error` is an OBJECT; handing it to `new Error()` showed
                // every refusal as "[object Object]". Read the server's reason
                // through the shared helper, falling back to the status line.
                const data = await res.json().catch(() => null);
                throw new Error(
                    apiErrorMessage(data, tx('create.createFailed', { status: res.status })),
                );
            }
            const finding = await res.json();
            void swrMutate(`/api/t/${tenantSlug}${CACHE_KEYS.findings.list()}`);
            telemetry.trackSuccess({ findingId: finding.id });
            close();
        } catch (err) {
            telemetry.trackError(err);
            setError(err instanceof Error ? err.message : tx('create.createFailedGeneric'));
            setSubmitting(false);
        }
    };

    return (
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="lg"
            title={tx('create.title')}
            description={tx('create.desc')}
            preventDefaultClose={submitting}
        >
            <Modal.Header
                title={tx('create.title')}
                description={tx('create.headerDesc')}
            />
            <Modal.Form id="create-finding-form" onSubmit={handleSubmit}>
                <Modal.Body>
                    {error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="create-finding-error"
                            role="alert"
                            data-testid="create-finding-error"
                        >
                            {error}
                        </div>
                    )}

                    <fieldset disabled={submitting} className="m-0 border-0 p-0">
                        <FormSection eyebrow={tx('create.sectionDetails')}>
                            <FormField label={tx('create.labelTitle')} required>
                                <Input
                                    id="finding-title"
                                    ref={titleRef}
                                    type="text"
                                    placeholder={tx('create.placeholderTitle')}
                                    value={form.title}
                                    onChange={(e) => update('title', e.target.value)}
                                    required
                                    autoComplete="off"
                                />
                            </FormField>

                            <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                                <FormField label={tx('create.labelType')}>
                                    <Combobox
                                        id="finding-type"
                                        name="type"
                                        options={TYPE_OPTIONS}
                                        selected={TYPE_OPTIONS.find((o) => o.value === form.type) ?? null}
                                        setSelected={(o) => update('type', o?.value ?? 'OBSERVATION')}
                                        hideSearch
                                        matchTriggerWidth
                                        buttonProps={{ className: 'w-full' }}
                                        caret
                                    />
                                </FormField>
                                <FormField label={tx('create.labelSeverity')}>
                                    <Combobox
                                        id="finding-severity"
                                        name="severity"
                                        options={SEVERITY_OPTIONS}
                                        selected={SEVERITY_OPTIONS.find((o) => o.value === form.severity) ?? null}
                                        setSelected={(o) => update('severity', o?.value ?? 'MEDIUM')}
                                        hideSearch
                                        matchTriggerWidth
                                        buttonProps={{ className: 'w-full' }}
                                        caret
                                    />
                                </FormField>
                            </div>

                            <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                                <FormField label={tx('create.labelAssignee')}>
                                    <UserCombobox
                                        tenantSlug={tenantSlug}
                                        selectedId={form.assigneeUserId || null}
                                        onChange={(userId) => update('assigneeUserId', userId ?? '')}
                                        matchTriggerWidth
                                        id="finding-assignee"
                                        placeholder={tx('create.placeholderUnassigned')}
                                    />
                                </FormField>
                                <FormField label={tx('create.labelDueDate')}>
                                    <DatePicker
                                        id="finding-due-date"
                                        className="w-full"
                                        placeholder={tx('create.placeholderSelectDate')}
                                        clearable
                                        align="start"
                                        value={parseYMD(form.dueDate)}
                                        onChange={(next) => update('dueDate', toYMD(next) ?? '')}
                                        disabledDays={{ before: startOfUtcDay(new Date()) }}
                                        aria-label={tx('create.ariaDueDate')}
                                    />
                                </FormField>
                            </div>

                            <FormField
                                label={tx('create.labelOriginatingAudit')}
                                description={tx('create.descOriginatingAudit')}
                            >
                                <Combobox
                                    id="finding-audit"
                                    name="auditId"
                                    options={auditOptions}
                                    selected={auditOptions.find((o) => o.value === form.auditId) ?? null}
                                    setSelected={(o) => update('auditId', o?.value ?? '')}
                                    loading={auditsQuery.isLoading}
                                    placeholder={tx('create.placeholderNone')}
                                    searchPlaceholder={tx('create.searchAudits')}
                                    emptyState={tx('create.emptyAudits')}
                                    matchTriggerWidth
                                    forceDropdown
                                    buttonProps={{ className: 'w-full' }}
                                    caret
                                />
                            </FormField>

                            <FormField label={tx('create.labelDescription')} required>
                                <Textarea
                                    id="finding-description"
                                    rows={3}
                                    placeholder={tx('create.placeholderDescription')}
                                    value={form.description}
                                    onChange={(e) => update('description', e.target.value)}
                                    required
                                />
                            </FormField>
                        </FormSection>

                        <FormSection eyebrow={tx('create.sectionControlsRisks')}>
                            <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                                <FormField
                                    label={tx('create.labelLinkedControl')}
                                    description={tx('create.descLinkedControl')}
                                >
                                    <Combobox
                                        id="finding-control"
                                        name="controlId"
                                        options={controlOptions}
                                        selected={controlOptions.find((o) => o.value === form.controlId) ?? null}
                                        setSelected={(o) => update('controlId', o?.value ?? '')}
                                        loading={controlsQuery.isLoading}
                                        placeholder={tx('create.placeholderNone')}
                                        searchPlaceholder={tx('create.searchControls')}
                                        emptyState={tx('create.emptyControls')}
                                        matchTriggerWidth
                                        forceDropdown
                                        buttonProps={{ className: 'w-full' }}
                                        caret
                                    />
                                </FormField>
                                <FormField
                                    label={tx('create.labelCompensatingControl')}
                                    description={tx('create.descCompensatingControl')}
                                >
                                    <Combobox
                                        id="finding-compensating-control"
                                        name="compensatingControlId"
                                        options={controlOptions}
                                        selected={
                                            controlOptions.find((o) => o.value === form.compensatingControlId) ?? null
                                        }
                                        setSelected={(o) => update('compensatingControlId', o?.value ?? '')}
                                        loading={controlsQuery.isLoading}
                                        placeholder={tx('create.placeholderNone')}
                                        searchPlaceholder={tx('create.searchControls')}
                                        emptyState={tx('create.emptyControls')}
                                        matchTriggerWidth
                                        forceDropdown
                                        buttonProps={{ className: 'w-full' }}
                                        caret
                                    />
                                </FormField>
                            </div>

                            <FormField label={tx('create.labelImplicatedRisks', { count: selectedRiskIds.size })}>
                                <div className="rounded-lg border border-border-subtle bg-bg-subtle">
                                    <div className="border-b border-border-subtle p-2">
                                        <Input
                                            id="finding-risk-filter"
                                            type="text"
                                            placeholder={tx('create.searchRisks')}
                                            value={riskFilter}
                                            onChange={(e) => setRiskFilter(e.target.value)}
                                            autoComplete="off"
                                        />
                                    </div>
                                    <div
                                        className="max-h-40 space-y-1 overflow-y-auto p-2"
                                        data-testid="finding-risks-list"
                                    >
                                        {risksQuery.isLoading ? (
                                            <p className="px-1 py-1 text-sm text-content-muted">{tx('create.loadingRisks')}</p>
                                        ) : filteredRisks.length === 0 ? (
                                            <p className="px-1 py-1 text-sm text-content-muted">
                                                {tx('create.risksToLinkEmpty')}
                                            </p>
                                        ) : (
                                            filteredRisks.map((r) => (
                                                <label
                                                    key={r.id}
                                                    className="flex cursor-pointer items-center gap-tight rounded px-1 py-1 text-sm text-content-default hover:bg-bg-muted"
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedRiskIds.has(r.id)}
                                                        onChange={() => toggleRisk(r.id)}
                                                        className="accent-brand-emphasis"
                                                        data-testid={`finding-risk-opt-${r.id}`}
                                                    />
                                                    <span className="w-16 shrink-0 text-xs text-content-muted">
                                                        {r.key || 'RISK'}
                                                    </span>
                                                    <span className="truncate text-content-emphasis">{r.title}</span>
                                                </label>
                                            ))
                                        )}
                                    </div>
                                </div>
                            </FormField>
                        </FormSection>

                        <FormSection eyebrow={tx('create.sectionAnalysis')}>
                            <FormField
                                label={tx('create.labelAnalysis')}
                                description={tx('create.descAnalysis')}
                            >
                                <Textarea
                                    id="finding-analysis"
                                    rows={3}
                                    placeholder={tx('create.placeholderAnalysis')}
                                    value={form.analysis}
                                    onChange={(e) => update('analysis', e.target.value)}
                                />
                            </FormField>
                        </FormSection>
                    </fieldset>
                </Modal.Body>

                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        id="create-finding-cancel-btn"
                        onClick={() => {
                            if (!submitting) close();
                        }}
                        disabled={submitting}
                    >
                        {tx('create.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        id="submit-finding"
                        disabled={!canSubmit}
                    >
                        {submitting ? tx('create.creating') : tx('create.submit')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
