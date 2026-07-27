'use client';

/**
 * R3-P1 — global "Create test plan" modal.
 *
 * Test plans were previously only born inside a control's TestPlansPanel, so a
 * user couldn't start testing from the testing page. This lets them pick the
 * control (+ name / method / frequency) and create the plan from /tests. It
 * POSTs to the same control-scoped route the per-control panel uses.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useToast } from '@/components/ui/hooks/use-toast';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { TestStepsEditor, type TestStepDraft, serializeSteps } from './TestStepsEditor';

interface ControlOption { id: string; code: string | null; name: string }

const FREQUENCIES = ['AD_HOC', 'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY'] as const;

export function NewTestPlanModal({
    open,
    onClose,
    onCreated,
}: {
    open: boolean;
    onClose: () => void;
    onCreated: () => void;
}) {
    const t = useTranslations('controlTests');
    const apiUrl = useTenantApiUrl();
    const toast = useToast();

    const [controls, setControls] = useState<ControlOption[]>([]);
    const [controlId, setControlId] = useState('');
    const [name, setName] = useState('');
    const [frequency, setFrequency] = useState('AD_HOC');
    const [steps, setSteps] = useState<TestStepDraft[]>([]);
    const [saving, setSaving] = useState(false);
    const [controlsError, setControlsError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setControlsError(null);
        fetch(apiUrl('/controls'))
            .then(async (r) => {
                if (!r.ok) throw new Error(`controls ${r.status}`);
                return r.json();
            })
            // GET /controls returns the backfill-cap envelope `{ rows, truncated }`
            // (NOT an array, and no `items` key) — reading anything but `.rows`
            // stored the envelope object and crashed the page on `controls.map`.
            .then((d) => setControls((d.rows ?? []) as ControlOption[]))
            .catch(() => setControlsError(t('modal.controlsLoadError')));
    }, [open, apiUrl, t]);

    const controlOptions: ComboboxOption[] = controls.map((c) => ({
        value: c.id,
        label: `${c.code ? `${c.code} — ` : ''}${c.name}`,
    }));
    const freqOptions: ComboboxOption[] = FREQUENCIES.map((f) => ({
        value: f,
        label: t(`freq.${f === 'AD_HOC' ? 'adHoc' : f.toLowerCase()}` as Parameters<typeof t>[0]),
    }));

    const reset = () => {
        setControlId(''); setName(''); setFrequency('AD_HOC'); setSteps([]);
    };

    const submit = async () => {
        if (!controlId || !name.trim()) return;
        setSaving(true);
        try {
            const res = await fetch(apiUrl(`/controls/${controlId}/tests/plans`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim(), frequency, steps: serializeSteps(steps) }),
            });
            if (!res.ok) throw new Error('create failed');
            toast.success(t('unified.createSuccess'));
            reset();
            onCreated();
            onClose();
        } catch {
            toast.error(t('unified.createFailed'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal
            showModal={open}
            setShowModal={(v) => { if (!v) onClose(); }}
            onClose={onClose}
            title={t('unified.createTitle')}
            size="md"
        >
            <Modal.Body>
                <div className="space-y-default">
                    {controlsError && (
                        <div
                            className="rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            role="alert"
                            id="new-test-plan-controls-error"
                        >
                            {controlsError}
                        </div>
                    )}
                    <FormField label={t('unified.createControl')}>
                        <Combobox
                            id="new-test-plan-control"
                            options={controlOptions}
                            selected={controlOptions.find((o) => o.value === controlId) ?? null}
                            setSelected={(o) => setControlId(o?.value ?? '')}
                            placeholder={t('unified.createControlPlaceholder')}
                            matchTriggerWidth
                        />
                    </FormField>
                    <FormField label={t('unified.createName')}>
                        <Input id="new-test-plan-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('unified.createNamePlaceholder')} />
                    </FormField>
                    {/* PR-Q — the MANUAL/AUTOMATED toggle was removed. It POSTed
                        a `method` that createTestPlan never mapped to an
                        automationType or a schedule, so "AUTOMATED" plans were
                        inert and the badge lied. No SCRIPT/INTEGRATION engine
                        exists yet (see PR-P); a plan is created MANUAL and a
                        cadence is configured afterward via the plan's schedule
                        section, which instantiates awaiting-completion runs. */}
                    <FormField label={t('colHeaders.frequency')} hint={t('unified.frequencyHint')}>
                        <Combobox
                            id="new-test-plan-frequency"
                            options={freqOptions}
                            selected={freqOptions.find((o) => o.value === frequency) ?? null}
                            setSelected={(o) => setFrequency(o?.value ?? 'AD_HOC')}
                            matchTriggerWidth
                        />
                    </FormField>
                    <FormField label={t('steps.label')} hint={t('steps.hint')}>
                        <TestStepsEditor steps={steps} onChange={setSteps} />
                    </FormField>
                </div>
            </Modal.Body>
            <Modal.Actions>
                <Button variant="secondary" onClick={onClose}>{t('unified.createCancel')}</Button>
                <Button variant="primary" onClick={submit} disabled={!controlId || !name.trim() || saving} id="new-test-plan-submit">
                    {saving ? t('unified.creating') : t('unified.createConfirm')}
                </Button>
            </Modal.Actions>
        </Modal>
    );
}
