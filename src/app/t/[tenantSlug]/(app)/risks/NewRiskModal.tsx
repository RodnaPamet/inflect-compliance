'use client';
/* One fetch-on-mount effect remains (the control/asset pickers); it
 * carries its own inline disable. The sibling list and detail pages have
 * already moved to useTenantSWR — this is the last holdout in the Risks
 * surface, not a file-wide pattern. */

/**
 * Epic 54 — New Risk modal.
 *
 * Modal-based replacement for the legacy `/risks/new` wizard. The wizard
 * split risk creation across four screens (choose / template / details /
 * scoring / controls) with a full-page context switch — this compact
 * single-step modal preserves every business knob (same POST payload,
 * same template pre-fill, same post-create control linking, same score
 * formula) while keeping the risk register visible behind the overlay.
 *
 * Business contract preserved:
 *   - `POST /api/t/:slug/risks` with
 *       { title, description?, category?, likelihood, impact,
 *         treatmentOwner?, nextReviewAt?, templateId? }
 *   - When a template is selected, `templateId` rides along so the
 *     server-side usecase can record the provenance.
 *   - After the risk is created, sequential best-effort POSTs to
 *     `/risks/:id/controls` for every selected control id — identical
 *     to the legacy wizard's two-phase behaviour.
 *   - The risks SWR list key is revalidated on success (every `?qs`
 *     filter variant) — fixes the latent bug on the legacy wizard where
 *     open tabs wouldn't refresh after a redirect back to the list.
 *
 * Preserved form IDs (`risk-title`, `risk-category`, `risk-description`,
 * `risk-owner`, `risk-review-date`, `submit-risk`) so the existing E2E
 * suite continues to match against the modal surface.
 */

import useSWR from 'swr';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useToast } from '@/components/ui/hooks';
import { useSWRConfig } from 'swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { unwrapCappedList, type CappedList } from '@/lib/list-backfill-cap';
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
} from 'react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { FormError } from '@/components/ui/form-error';
import { FormSection } from '@/components/ui/form-section';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { UserCombobox } from '@/components/ui/user-combobox';
import { RiskEvaluationFields } from './_shared/RiskEvaluationFields';
import { buildRiskTreatmentOptions } from './_shared/risk-options';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import {
    parseYMD,
    startOfUtcDay,
    toYMD,
} from '@/components/ui/date-picker/date-utils';
import { useFormTelemetry } from '@/lib/telemetry/form-telemetry';
import { useTranslations } from 'next-intl';
import { RISK_CATEGORY_OPTIONS } from './_shared/risk-options';
import { extractMutationError } from '@/lib/mutations';
import { useNewRiskForm } from './_form/useNewRiskForm';

// ─── Constants ──────────────────────────────────────────────────────



// ─── Types ──────────────────────────────────────────────────────────

interface ControlOption {
    id: string;
    annexId: string | null;
    name: string;
    status: string;
}

interface RiskTemplate {
    id: string;
    title: string;
    description: string | null;
    category: string | null;
    defaultLikelihood: number;
    defaultImpact: number;
    frameworkTag: string | null;
}

export interface NewRiskModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    tenantSlug: string;
    apiUrl: (path: string) => string;
}

// ─── Component ──────────────────────────────────────────────────────

export function NewRiskModal({
    open,
    setOpen,
    tenantSlug,
    apiUrl,
}: NewRiskModalProps) {
    const tx = useTranslations('risks');
    const RISK_TREATMENT_OPTIONS = useMemo(
        () => buildRiskTreatmentOptions((k) => tx(k as Parameters<typeof tx>[0])),
        [tx],
    );
    const close = useCallback(() => setOpen(false), [setOpen]);
    const toast = useToast();
    // Epic 69 — bridge cache invalidation. RisksClient now reads
    // from `useTenantSWR(CACHE_KEYS.risks.list())`, so the React
    // Query invalidation alone wouldn't refresh the page. We
    // invalidate BOTH caches.
    const { mutate: swrMutate } = useSWRConfig();
    const titleRef = useRef<HTMLInputElement>(null);

    // B2-8 — form state lives in `useNewRiskForm` (the shared `_form/` +
    // `useZodForm` shape every other entity surface uses). `templateId` and
    // `selectedControlIds` stay HERE deliberately: the first drives a fetch
    // and rewrites fields, the second is a second-phase write after the risk
    // exists. Neither is part of the risk payload.
    const [templateId, setTemplateId] = useState('');
    const [selectedControlIds, setSelectedControlIds] = useState<Set<string>>(
        new Set(),
    );

    // ─── Lookups — controls + templates load while the modal is open ───
    const controlsQuery = useTenantSWR<CappedList<ControlOption> | ControlOption[]>(
        open ? CACHE_KEYS.controls.list() : null,
    );
    const controls = useMemo<ControlOption[]>(() => {
        // GET /controls returns the backfill-capped `{ rows, truncated }`
        // envelope, not a bare array — unwrap both forms.
        const list = unwrapCappedList(controlsQuery.data);
        return list.map((c) => ({
            id: c.id,
            annexId: c.annexId ?? null,
            name: c.name,
            status: c.status,
        }));
    }, [controlsQuery.data]);

    // Risk templates live on a NON-tenant endpoint (`/api/risk-templates`),
    // so this uses raw `useSWR` rather than `useTenantSWR` (which would
    // prepend `/api/t/{slug}`). Null-key gates the fetch on `open`.
    const templatesQuery = useSWR<RiskTemplate[]>(
        open ? '/api/risk-templates' : null,
        async (url: string) => {
            const res = await fetch(url);
            if (!res.ok) return [];
            const data = await res.json();
            return Array.isArray(data) ? data : [];
        },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `templates` is a fresh array each render by construction; the two useMemos below key off its contents. Wrapping it in its own useMemo would move the allocation without removing it.
    const templates = templatesQuery.data ?? [];
    const selectedTemplate = useMemo(
        () => templates.find((t) => t.id === templateId) ?? null,
        [templates, templateId],
    );
    // Project the templates into ComboboxOption shape. The category
    // is appended to the label so it becomes part of the fuzzy search
    // index (typing "compliance" matches all compliance templates).
    const templateOptions = useMemo<ComboboxOption<RiskTemplate>[]>(
        () =>
            templates.map((tmpl) => ({
                value: tmpl.id,
                label: tmpl.category ? `${tmpl.title} · ${tmpl.category}` : tmpl.title,
                meta: tmpl,
            })),
        [templates],
    );

    // ─── B2-8 — the shared form hook ───
    // Placed after `selectedTemplate` so the resolved template id can ride
    // the create payload, and before the reset effect that calls
    // `riskForm.reset()`.
    const riskForm = useNewRiskForm({
        templateId: selectedTemplate?.id ?? null,
        fallbackErrorMessage: tx('new.createFailed'),
        // The banner comes from `riskForm.error`; this only reports.
        onError: (err) => telemetry.trackError(err),
        onCreated: async (risk) => {
            // Ordering matters: link the controls BEFORE closing, so a
            // partial-link warning is still on screen when the modal goes.
            await linkSelectedControls(risk.id);
            // Bridge to the SWR cache that RisksClient reads from.
            const risksUrlPrefix = apiUrl(CACHE_KEYS.risks.list());
            swrMutate(
                (key) =>
                    typeof key === 'string' &&
                    (key === risksUrlPrefix || key.startsWith(`${risksUrlPrefix}?`)),
                undefined,
                { revalidate: true },
            );
            telemetry.trackSuccess({ riskId: risk.id });
            close();
        },
    });
    const form = riskForm.fields;
    const submitting = riskForm.submitting;
    const error = riskForm.error;

    // ─── Reset + focus on open ───
    useEffect(() => {
        if (!open) return;
        // Resetting on OPEN (not on close) is deliberate: the modal stays
        // mounted, so without this a second open would show the previous
        // attempt's values. All three resets are one logical operation, so
        // the rule is suppressed for the block rather than per line.
        /* eslint-disable react-hooks/set-state-in-effect */
        riskForm.reset();
        setTemplateId('');
        setSelectedControlIds(new Set());
        /* eslint-enable react-hooks/set-state-in-effect */
        const t = setTimeout(() => titleRef.current?.focus(), 60);
        return () => clearTimeout(t);
        // `riskForm` is intentionally omitted — the hook returns a fresh
        // object every render, so depending on it would reset the form on
        // every keystroke. `open` is the only edge this should fire on.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    // Pre-fill from a newly selected template. We keep whatever the user
    // has already edited; only the fields that came from the old template
    // (now overridden) move to the new template's defaults.
    const applyTemplate = (id: string) => {
        setTemplateId(id);
        const tmpl = templates.find((t) => t.id === id);
        if (!tmpl) return;
        riskForm.applyFields({
            title: tmpl.title,
            description: tmpl.description ?? '',
            category: tmpl.category ?? '',
            likelihood: tmpl.defaultLikelihood,
            impact: tmpl.defaultImpact,
        });
    };

    const update = riskForm.setField;

    const toggleControl = (id: string) =>
        setSelectedControlIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    // B2-8 — was `form.title.trim().length > 0 && !submitting`. The schema
    // now owns the gate, so a rule added to `NewRiskFormSchema` takes effect
    // here without a second edit.
    const canSubmit = riskForm.canSubmit;

    const telemetry = useFormTelemetry('NewRiskModal');

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!canSubmit) return;
        telemetry.trackSubmit({
            hasTemplate: Boolean(selectedTemplate),
            likelihood: form.likelihood,
            impact: form.impact,
            controlLinkCount: selectedControlIds.size,
        });
        // B2-8 — the hook owns the POST, the payload shaping and the
        // error/submitting lifecycle. `submit()` swallows nothing: it
        // surfaces the failure on `riskForm.error`, which the banner below
        // renders, so the `catch` that used to live here is gone.
        await riskForm.submit();
    };

    /**
     * Phase 2, after the risk exists.
     *
     * Kept OUT of the form hook on purpose. These links need the new risk's
     * id, so they cannot ride the create payload — and a link failure must
     * NOT present as a failed create: the risk is already saved. Failures
     * are counted and surfaced as a warning toast rather than thrown, which
     * is the behaviour PR-K introduced to stop dropped links being silent.
     */
    async function linkSelectedControls(riskId: string) {
        let controlLinkFailures = 0;
        for (const controlId of selectedControlIds) {
            try {
                const linkRes = await fetch(apiUrl(`/risks/${riskId}/controls`), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ controlId }),
                });
                if (!linkRes.ok) controlLinkFailures += 1;
            } catch {
                controlLinkFailures += 1;
            }
        }
        if (controlLinkFailures > 0) {
            toast.warning(
                tx('new.controlLinkPartialFail', {
                    failed: controlLinkFailures,
                    total: selectedControlIds.size,
                }),
            );
        }
    }

    return (
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="lg"
            title={tx('new.title')}
            description={tx('new.descShort')}
            preventDefaultClose={submitting}
        >
            <Modal.Header
                title={tx('new.title')}
                description={tx('new.descLong')}
            />
            <Modal.Form id="new-risk-form" onSubmit={handleSubmit}>
                <Modal.Body>
                    {error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="new-risk-error"
                            role="alert"
                            data-testid="new-risk-error"
                        >
                            {error}
                        </div>
                    )}

                    {/* Roadmap-2 PR-6 — `<FormSection>` wraps the
                        risk-detail fields. The eyebrow gives the
                        section a name; future PRs split the
                        scoring + treatment fields into their own
                        subsections. The `disabled` prop is now
                        forwarded to a nested fieldset that owns
                        the disable behaviour while FormSection
                        owns the visual rhythm. */}
                    <fieldset disabled={submitting} className="m-0 p-0 border-0">
                    <FormSection eyebrow={tx('new.eyebrow')}>
                        {/* Template (optional) */}
                        {templates.length > 0 && (
                            <FormField
                                label={
                                    <>
                                        {tx('new.templateLabel')}{' '}
                                        <span className="text-content-muted">
                                            {tx('new.optional')}
                                        </span>
                                    </>
                                }
                                description={tx('new.templateDesc')}
                            >
                                <Combobox<false, RiskTemplate>
                                    id="risk-template-select"
                                    name="templateId"
                                    options={templateOptions}
                                    selected={
                                        templateOptions.find(
                                            (o) => o.value === templateId,
                                        ) ?? null
                                    }
                                    setSelected={(option) => {
                                        applyTemplate(option?.value ?? '');
                                    }}
                                    loading={templatesQuery.isLoading}
                                    placeholder={tx('new.templatePlaceholder')}
                                    searchPlaceholder={tx('new.templateSearch')}
                                    emptyState={tx('new.templateEmpty')}
                                    matchTriggerWidth
                                    forceDropdown
                                    buttonProps={{ className: 'w-full' }}
                                    caret
                                />
                            </FormField>
                        )}

                        {/* Title */}
                        <FormField label={tx('new.titleLabel')} required>
                            <Input
                                id="risk-title"
                                ref={titleRef}
                                type="text"
                                placeholder={tx('new.titlePlaceholder')}
                                value={form.title}
                                onChange={(e) => update('title', e.target.value)}
                                required
                                autoComplete="off"
                            />
                        </FormField>
                        {form.title.length > 0 && !form.title.trim() && (
                            <FormError>{tx('new.titleEmpty')}</FormError>
                        )}

                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            {/* Category */}
                            <FormField label={tx('new.categoryLabel')}>
                                <Combobox
                                    id="risk-category"
                                    name="category"
                                    options={RISK_CATEGORY_OPTIONS}
                                    selected={
                                        RISK_CATEGORY_OPTIONS.find(
                                            (o) => o.value === form.category,
                                        ) ?? null
                                    }
                                    setSelected={(o) =>
                                        update('category', o?.value ?? '')
                                    }
                                    placeholder={tx('new.categoryPlaceholder')}
                                    searchPlaceholder={tx('new.categorySearch')}
                                    matchTriggerWidth
                                    forceDropdown
                                    buttonProps={{ className: 'w-full' }}
                                    caret
                                />
                            </FormField>

                            {/* Owner — tenant-member people picker. */}
                            <FormField label={tx('new.ownerLabel')}>
                                <UserCombobox
                                    id="risk-owner"
                                    tenantSlug={tenantSlug}
                                    selectedId={form.ownerUserId || null}
                                    onChange={(userId) =>
                                        update('ownerUserId', userId ?? '')
                                    }
                                    forceDropdown
                                    matchTriggerWidth
                                    placeholder={tx('new.ownerPlaceholder')}
                                />
                            </FormField>
                        </div>

                        {/* Description */}
                        <FormField label={tx('new.descriptionLabel')}>
                            <Textarea
                                id="risk-description"
                                rows={3}
                                placeholder={tx('new.descriptionPlaceholder')}
                                value={form.description}
                                onChange={(e) =>
                                    update('description', e.target.value)
                                }
                            />
                        </FormField>

                        {/* Risk Evaluation — shared scoring box (matches
                            the detail edit modal). */}
                        <RiskEvaluationFields
                            likelihood={form.likelihood}
                            impact={form.impact}
                            onLikelihood={(v) => update('likelihood', v)}
                            onImpact={(v) => update('impact', v)}
                        />

                        {/* Treatment decision + notes */}
                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField label={tx('new.treatmentLabel')}>
                                <Combobox
                                    id="risk-treatment"
                                    name="treatment"
                                    options={RISK_TREATMENT_OPTIONS}
                                    selected={
                                        RISK_TREATMENT_OPTIONS.find(
                                            (o) => o.value === form.treatment,
                                        ) ?? null
                                    }
                                    setSelected={(o) =>
                                        update('treatment', o?.value ?? '')
                                    }
                                    placeholder={tx('new.treatmentPlaceholder')}
                                    hideSearch
                                    matchTriggerWidth
                                    buttonProps={{ className: 'w-full' }}
                                    caret
                                />
                            </FormField>
                        </div>
                        <FormField label={tx('new.treatmentNotesLabel')}>
                            <Textarea
                                id="risk-treatment-notes"
                                rows={3}
                                placeholder={tx('new.treatmentNotesPlaceholder')}
                                value={form.treatmentNotes}
                                onChange={(e) =>
                                    update('treatmentNotes', e.target.value)
                                }
                            />
                        </FormField>

                        {/* Review date — Epic 58 shared DatePicker.
                            `form.nextReviewAt` stays a YMD string so the
                            server payload is unchanged; the picker
                            bridges to DateValue at the prop edge. */}
                        <FormField label={tx('new.nextReviewLabel')}>
                            <DatePicker
                                id="risk-review-date"
                                className="sm:max-w-xs"
                                placeholder={tx('new.datePlaceholder')}
                                clearable
                                align="start"
                                value={parseYMD(form.nextReviewAt)}
                                onChange={(next) =>
                                    update('nextReviewAt', toYMD(next) ?? '')
                                }
                                disabledDays={{
                                    before: startOfUtcDay(new Date()),
                                }}
                                aria-label="Next review date"
                            />
                        </FormField>

                        {/* Linked controls (optional, collapsible feel) */}
                        <details className="rounded-lg border border-border-subtle bg-bg-subtle">
                            <summary
                                className="cursor-pointer px-4 py-2 text-sm text-content-default"
                                data-testid="risk-controls-toggle"
                            >
                                {tx('new.linkControls')}{' '}
                                <span className="text-content-muted">
                                    {tx('new.selectedCount', { count: selectedControlIds.size })}
                                </span>
                            </summary>
                            <div className="border-t border-border-subtle px-4 py-3">
                                {controlsQuery.isLoading ? (
                                    <p className="text-sm text-content-muted">
                                        {tx('new.loadingControls')}
                                    </p>
                                ) : controls.length === 0 ? (
                                    <p className="text-sm text-content-muted">
                                        {tx('new.controlsEmpty')}
                                    </p>
                                ) : (
                                    <div
                                        className="max-h-40 space-y-1 overflow-y-auto"
                                        data-testid="risk-controls-list"
                                    >
                                        {controls.map((c) => (
                                            <label
                                                key={c.id}
                                                className="flex cursor-pointer items-center gap-tight rounded px-1 py-1 text-sm text-content-default hover:bg-bg-muted"
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={selectedControlIds.has(
                                                        c.id,
                                                    )}
                                                    onChange={() =>
                                                        toggleControl(c.id)
                                                    }
                                                    className="accent-brand-emphasis"
                                                    data-testid={`risk-control-opt-${c.id}`}
                                                />
                                                <span className="w-16 shrink-0 text-xs text-content-muted">
                                                    {c.annexId || 'CUST'}
                                                </span>
                                                <span className="text-content-emphasis">
                                                    {c.name}
                                                </span>
                                            </label>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </details>
                    </FormSection>
                    </fieldset>
                </Modal.Body>

                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        id="new-risk-cancel-btn"
                        onClick={() => {
                            if (!submitting) close();
                        }}
                        disabled={submitting}
                    >
                        {tx('new.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        id="submit-risk"
                        disabled={!canSubmit}
                    >
                        {submitting ? tx('new.creating') : tx('new.submit')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
