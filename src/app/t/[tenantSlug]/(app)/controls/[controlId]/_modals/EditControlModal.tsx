/**
 * Elevation PR-2 — first decomposition extraction.
 *
 * The control detail page (`page.tsx`) was 1506 lines. This file
 * extracts the Edit Control modal into a presentational sub-
 * component. The page still owns the mutation + state; the modal
 * is a thin renderer.
 *
 * Pattern for future extractions:
 *   - State + mutation stay in the page (coupled to pageDataKey).
 *   - Sub-component takes everything via props.
 *   - File lives under `_modals/` (or `_tabs/`) so Next.js doesn't
 *     treat it as a route.
 *
 * Future PRs should extract: OverviewTab, TasksTab, EvidenceTab,
 * MappingsTab, ActivityTab using the same pattern.
 */
'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { NumberStepper } from '@/components/ui/number-stepper';
import { Textarea } from '@/components/ui/textarea';
import { UserCombobox } from '@/components/ui/user-combobox';

export interface EditControlForm {
    name: string;
    objective: string;
    successCriteria: string;
    testingMethodology: string;
    category: string;
    frequency: string;
    owner: string;
    automationType: string;
    mitigationType: string;
    /** RQ3-8 — annualCost as a free-text input bridges to a Float?
     *  number on the wire. Empty string → null. */
    annualCost: string;
    /** Declared operating-effectiveness fallback (0–100). Same
     *  string-bridge contract as annualCost — empty string → null;
     *  the measured pass rate wins when test history exists. */
    effectiveness: string;
    /**
     * Automated-checks wiring. `automation-runner.ts` picks a control up only
     * when `automationKey` is non-null AND `evidenceSource === 'INTEGRATION'`.
     * Both were accepted by Zod and written by the usecase long before any UI
     * sent them — so the feature existed end-to-end on the server and could
     * not be switched on from the product.
     */
    automationKey: string;
    evidenceSource: string;
}

type OptT = (key: string) => string;
const buildAutomationTypeOptions = (t: OptT): ComboboxOption[] => [
    { value: 'AUTOMATED', label: t('automationTypeLabels.AUTOMATED') },
    { value: 'MANUAL', label: t('automationTypeLabels.MANUAL') },
    { value: 'IT_DEPENDENT_MANUAL', label: t('automationTypeLabels.IT_DEPENDENT_MANUAL') },
];

/**
 * `MANUAL` is the implicit default; `INTEGRATION` is the explicit opt-in the
 * runner requires. Kept as an explicit two-option picker rather than a
 * checkbox so the stored value is legible in the audit trail.
 */
const buildEvidenceSourceOptions = (t: OptT): ComboboxOption[] => [
    { value: 'MANUAL', label: t('editModal.evidenceSourceManual') },
    { value: 'INTEGRATION', label: t('editModal.evidenceSourceIntegration') },
];

const buildMitigationTypeOptions = (t: OptT): ComboboxOption[] => [
    { value: 'PREVENTIVE', label: t('mitigationTypeLabels.PREVENTIVE') },
    { value: 'DETECTIVE', label: t('mitigationTypeLabels.DETECTIVE') },
    { value: 'DETERRENT', label: t('mitigationTypeLabels.DETERRENT') },
    { value: 'CORRECTIVE', label: t('mitigationTypeLabels.CORRECTIVE') },
    { value: 'COMPENSATING', label: t('mitigationTypeLabels.COMPENSATING') },
];

export interface EditControlModalProps {
    open: boolean;
    setOpen: (next: boolean) => void;
    form: EditControlForm;
    setForm: React.Dispatch<React.SetStateAction<EditControlForm>>;
    saving: boolean;
    error: string;
    /** Tenant slug for the owner UserCombobox roster lookup. */
    tenantSlug: string;
    categoryOptions: ComboboxOption[];
    frequencyOptions: ComboboxOption[];
    onCancel: () => void;
    onSubmit: (e: React.FormEvent) => void | Promise<void>;
}

export function EditControlModal({
    open,
    setOpen,
    form,
    setForm,
    saving,
    error,
    tenantSlug,
    categoryOptions,
    frequencyOptions,
    onCancel,
    onSubmit,
}: EditControlModalProps) {
    const tx = useTranslations('controls');
    // Preserve a non-theme current category (legacy free-text / framework-seed
    // granular / custom) as its own option so it displays honestly and
    // round-trips — the editor must never silently drop a value it merely
    // failed to resolve against the four ISO themes.
    const resolvedCategoryOptions: ComboboxOption[] =
        form.category && !categoryOptions.some((o) => o.value === form.category)
            ? [...categoryOptions, { value: form.category, label: form.category }]
            : categoryOptions;
    const AUTOMATION_TYPE_OPTIONS = buildAutomationTypeOptions(tx);
    const MITIGATION_TYPE_OPTIONS = buildMitigationTypeOptions(tx);
    const EVIDENCE_SOURCE_OPTIONS = buildEvidenceSourceOptions(tx);
    return (
        <Modal
            showModal={open}
            setShowModal={(v) => {
                const next = typeof v === 'function' ? v(open) : v;
                if (!next && !saving) onCancel();
                else setOpen(next);
            }}
            size="lg"
            title={tx('editModal.title')}
            description={tx('editModal.desc')}
            preventDefaultClose={saving}
        >
            <Modal.Header
                title={tx('editModal.title')}
                description={tx('editModal.desc')}
            />
            <Modal.Form
                onSubmit={onSubmit}
                id="control-edit-dialog"
                data-testid="control-edit-dialog"
            >
                <Modal.Body>
                    {error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            role="alert"
                            data-testid="edit-error"
                        >
                            {error}
                        </div>
                    )}
                    <fieldset className="space-y-default" disabled={saving}>
                        <FormField label={tx('editModal.titleLabel')} required>
                            <Input
                                id="edit-name"
                                type="text"
                                value={form.name}
                                onChange={(e) =>
                                    setForm((f) => ({
                                        ...f,
                                        name: e.target.value,
                                    }))
                                }
                                required
                                minLength={3}
                                data-testid="edit-name-input"
                            />
                        </FormField>
                        <FormField label={tx('editModal.objectiveLabel')}>
                            <Textarea
                                id="edit-objective"
                                rows={2}
                                value={form.objective}
                                onChange={(e) => setForm((f) => ({ ...f, objective: e.target.value }))}
                                data-testid="edit-objective-input"
                            />
                        </FormField>
                        <FormField label={tx('editModal.successCriteriaLabel')}>
                            <Textarea
                                id="edit-success-criteria"
                                rows={2}
                                value={form.successCriteria}
                                onChange={(e) => setForm((f) => ({ ...f, successCriteria: e.target.value }))}
                                data-testid="edit-success-criteria-input"
                            />
                        </FormField>
                        <FormField label={tx('editModal.testingMethodologyLabel')}>
                            <Textarea
                                id="edit-testing-methodology"
                                rows={3}
                                value={form.testingMethodology}
                                onChange={(e) => setForm((f) => ({ ...f, testingMethodology: e.target.value }))}
                                data-testid="edit-testing-methodology-input"
                            />
                        </FormField>
                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <div>
                                <label
                                    htmlFor="edit-category"
                                    className="mb-1 block text-sm text-content-default"
                                >
                                    {tx('editModal.categoryLabel')}
                                </label>
                                <Combobox
                                    hideSearch
                                    forceDropdown
                                    id="edit-category"
                                    selected={
                                        resolvedCategoryOptions.find(
                                            (o) => o.value === form.category,
                                        ) ?? null
                                    }
                                    setSelected={(opt) =>
                                        setForm((f) => ({
                                            ...f,
                                            category: opt?.value ?? '',
                                        }))
                                    }
                                    options={resolvedCategoryOptions}
                                    placeholder={tx('editModal.nonePlaceholder')}
                                    matchTriggerWidth
                                />
                            </div>
                            <div>
                                <label
                                    htmlFor="edit-frequency"
                                    className="mb-1 block text-sm text-content-default"
                                >
                                    {tx('editModal.frequencyLabel')}
                                </label>
                                <Combobox
                                    hideSearch
                                    forceDropdown
                                    id="edit-frequency"
                                    selected={
                                        frequencyOptions.find(
                                            (o) => o.value === form.frequency,
                                        ) ?? null
                                    }
                                    setSelected={(opt) =>
                                        setForm((f) => ({
                                            ...f,
                                            frequency: opt?.value ?? '',
                                        }))
                                    }
                                    options={frequencyOptions}
                                    placeholder={tx('editModal.nonePlaceholder')}
                                    matchTriggerWidth
                                />
                            </div>
                        </div>
                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <div>
                                <label
                                    htmlFor="edit-automation-type"
                                    className="mb-1 block text-sm text-content-default"
                                >
                                    {tx('editModal.automationTypeLabel')}
                                </label>
                                <Combobox
                                    hideSearch
                                    forceDropdown
                                    id="edit-automation-type"
                                    selected={
                                        AUTOMATION_TYPE_OPTIONS.find(
                                            (o) => o.value === form.automationType,
                                        ) ?? null
                                    }
                                    setSelected={(opt) =>
                                        setForm((f) => ({
                                            ...f,
                                            automationType: opt?.value ?? '',
                                        }))
                                    }
                                    options={AUTOMATION_TYPE_OPTIONS}
                                    placeholder={tx('editModal.nonePlaceholder')}
                                    matchTriggerWidth
                                />
                            </div>
                            <div>
                                <label
                                    htmlFor="edit-mitigation-type"
                                    className="mb-1 block text-sm text-content-default"
                                >
                                    {tx('editModal.mitigationTypeLabel')}
                                </label>
                                <Combobox
                                    hideSearch
                                    forceDropdown
                                    id="edit-mitigation-type"
                                    selected={
                                        MITIGATION_TYPE_OPTIONS.find(
                                            (o) => o.value === form.mitigationType,
                                        ) ?? null
                                    }
                                    setSelected={(opt) =>
                                        setForm((f) => ({
                                            ...f,
                                            mitigationType: opt?.value ?? '',
                                        }))
                                    }
                                    options={MITIGATION_TYPE_OPTIONS}
                                    placeholder={tx('editModal.nonePlaceholder')}
                                    matchTriggerWidth
                                />
                            </div>
                        </div>
                        <div data-testid="edit-annual-cost-input">
                            <label
                                htmlFor="edit-annual-cost"
                                className="mb-1 block text-sm text-content-default"
                            >
                                {tx('editModal.annualCostLabel')}
                            </label>
                            <NumberStepper
                                id="edit-annual-cost"
                                value={
                                    form.annualCost.trim() === '' ||
                                    Number.isNaN(Number(form.annualCost))
                                        ? 0
                                        : Number(form.annualCost)
                                }
                                onChange={(v) =>
                                    setForm((f) => ({
                                        ...f,
                                        // 0 = unpriced (honest null on save).
                                        annualCost: v <= 0 ? '' : String(v),
                                    }))
                                }
                                min={0}
                                step={1000}
                                ariaLabel={tx('editModal.annualCostAria')}
                            />
                            <p className="mt-1 text-xs text-content-subtle">
                                {tx('editModal.annualCostHelp')}
                            </p>
                        </div>
                        <div data-testid="edit-effectiveness-input">
                            <label
                                htmlFor="edit-effectiveness"
                                className="mb-1 block text-sm text-content-default"
                            >
                                {tx('editModal.effectivenessLabel')}
                            </label>
                            <NumberStepper
                                id="edit-effectiveness"
                                value={
                                    form.effectiveness.trim() === '' ||
                                    Number.isNaN(Number(form.effectiveness))
                                        ? 0
                                        : Number(form.effectiveness)
                                }
                                onChange={(v) =>
                                    setForm((f) => ({
                                        ...f,
                                        // 0 = undeclared (honest null on save);
                                        // the measured pass rate is the primary
                                        // signal, this is only the fallback.
                                        effectiveness: v <= 0 ? '' : String(v),
                                    }))
                                }
                                min={0}
                                max={100}
                                step={5}
                                ariaLabel={tx('editModal.effectivenessAria')}
                            />
                            <p className="mt-1 text-xs text-content-subtle">
                                {tx('editModal.effectivenessHelp')}
                            </p>
                        </div>
                        {/* Automated checks. These two are shown together, and
                            the help text says they are a pair, because the
                            runner requires BOTH — a key with the source left on
                            MANUAL silently never runs, which is precisely the
                            dead end this section exists to remove. */}
                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <div data-testid="edit-evidence-source-input">
                                <label
                                    htmlFor="edit-evidence-source"
                                    className="mb-1 block text-sm text-content-default"
                                >
                                    {tx('editModal.evidenceSourceLabel')}
                                </label>
                                <Combobox
                                    hideSearch
                                    forceDropdown
                                    id="edit-evidence-source"
                                    selected={
                                        EVIDENCE_SOURCE_OPTIONS.find(
                                            (o) => o.value === form.evidenceSource,
                                        ) ?? null
                                    }
                                    setSelected={(opt) =>
                                        setForm((f) => ({
                                            ...f,
                                            evidenceSource: opt?.value ?? '',
                                        }))
                                    }
                                    options={EVIDENCE_SOURCE_OPTIONS}
                                    placeholder={tx('editModal.nonePlaceholder')}
                                    matchTriggerWidth
                                />
                            </div>
                            <div data-testid="edit-automation-key-input">
                                <label
                                    htmlFor="edit-automation-key"
                                    className="mb-1 block text-sm text-content-default"
                                >
                                    {tx('editModal.automationKeyLabel')}
                                </label>
                                <Input
                                    id="edit-automation-key"
                                    value={form.automationKey}
                                    onChange={(e) =>
                                        setForm((f) => ({
                                            ...f,
                                            automationKey: e.target.value,
                                        }))
                                    }
                                    placeholder={tx('editModal.automationKeyPlaceholder')}
                                />
                            </div>
                            <p className="text-xs text-content-subtle sm:col-span-2">
                                {tx('editModal.automatedChecksHelp')}
                            </p>
                        </div>
                        <div>
                            <label
                                htmlFor="edit-owner"
                                className="mb-1 block text-sm text-content-default"
                            >
                                {tx('editModal.ownerLabel')}
                            </label>
                            <UserCombobox
                                id="edit-owner"
                                name="ownerUserId"
                                tenantSlug={tenantSlug}
                                selectedId={form.owner || null}
                                onChange={(userId) =>
                                    setForm((f) => ({
                                        ...f,
                                        owner: userId ?? '',
                                    }))
                                }
                                placeholder={tx('editModal.unassigned')}
                            />
                        </div>
                    </fieldset>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={onCancel}
                        disabled={saving}
                        data-testid="edit-cancel-button"
                    >
                        {tx('editModal.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={saving || form.name.trim().length < 3}
                        data-testid="edit-save-button"
                    >
                        {saving ? tx('editModal.saving') : tx('editModal.save')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
