'use client';

/**
 * The start form for a workflow that declares `requiredInput` (#4472).
 *
 * ONE form for every such workflow, built from the definition's declaration
 * through `startPlanFor` — never a hand-made form per workflow. Each field is a
 * required input, in the order the definition declares them, collected as its
 * `StartFieldSpec` says: a framework from the catalogue, or typed text.
 *
 * The form refuses only what admission would refuse anyway (a blank value) and
 * a format the run's first step validates. The server is still the authority:
 * its refusal comes back through `onStart` and is shown here, beside the
 * fields, as the server worded it.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { apiErrorMessage } from '@/lib/api-error';
import {
    startFieldProblem,
    type StartField,
    type StartFieldSpec,
} from '@/lib/agentic/workflow-start-plan';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

/** The framework catalogue, loaded once when the form opens and only if a field needs it. */
function useFrameworkOptions(needed: boolean) {
    // Its own name, not `t`: the component below binds `t` too, and a translator
    // bound twice in one file is one `i18n-keys-resolve` cannot read.
    const tRuns = useTranslations('agents');
    const apiUrl = useTenantApiUrl();
    const [options, setOptions] = useState<ComboboxOption[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!needed) return;
        let cancelled = false;
        void (async () => {
            try {
                const res = await fetch(apiUrl('/frameworks'));
                const body: unknown = await res.json().catch(() => null);
                if (cancelled) return;
                if (!res.ok) {
                    setError(apiErrorMessage(body, tRuns('runs.startForm.frameworksFailed')));
                    return;
                }
                const rows = Array.isArray(body) ? (body as Array<{ key: string; name: string }>) : [];
                setOptions(rows.map((fw) => ({ value: fw.key, label: fw.name })));
            } catch {
                if (!cancelled) setError(tRuns('runs.startForm.frameworksFailed'));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [needed, apiUrl, tRuns]);

    return { options, error };
}

export function WorkflowStartModal({
    workflow,
    fields,
    busy,
    error,
    onCancel,
    onStart,
}: {
    workflow: { key: string; name: string; description: string };
    fields: readonly StartField[];
    busy: boolean;
    /** The server's refusal of the last attempt, as `apiErrorMessage` read it. */
    error: string | null;
    onCancel: () => void;
    onStart: (input: Record<string, string>) => void;
}) {
    const t = useTranslations('agents');
    const [values, setValues] = useState<Record<string, string>>({});
    /** Problems are shown after the first submit, not while the person is still typing. */
    const [submitted, setSubmitted] = useState(false);

    const needsFrameworks = fields.some((f) => f.spec.kind === 'framework');
    const frameworks = useFrameworkOptions(needsFrameworks);

    const problems = useMemo(
        () => Object.fromEntries(fields.map((f) => [f.key, startFieldProblem(f.spec, values[f.key])])),
        [fields, values],
    );
    const ready = fields.every((f) => problems[f.key] === null);
    const title = t('runs.startForm.title', { workflow: workflow.name });

    const set = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }));

    function problemText(field: StartField): string | undefined {
        if (!submitted) return undefined;
        const problem = problems[field.key];
        if (problem === 'REQUIRED') return t('runs.startForm.required');
        if (problem === 'FORMAT') return t(`runs.startForm.field.${field.key}.invalid`);
        return undefined;
    }

    function control(field: StartField, spec: StartFieldSpec, id: string) {
        if (spec.kind === 'framework') {
            const options = frameworks.options ?? [];
            return (
                <Combobox
                    id={id}
                    options={options}
                    loading={frameworks.options === null && frameworks.error === null}
                    selected={options.find((o) => o.value === values[field.key]) ?? null}
                    setSelected={(opt) => set(field.key, opt?.value ?? '')}
                    placeholder={t('runs.startForm.frameworkPlaceholder')}
                    emptyState={t('runs.startForm.noFrameworks')}
                    disabled={busy}
                    matchTriggerWidth
                />
            );
        }
        return (
            <Input
                id={id}
                value={values[field.key] ?? ''}
                maxLength={spec.maxLength}
                onChange={(e) => set(field.key, e.target.value)}
                disabled={busy}
            />
        );
    }

    return (
        <Modal
            showModal
            setShowModal={(open) => {
                if (!open && !busy) onCancel();
            }}
            title={title}
            preventDefaultClose={busy}
        >
            <Modal.Header title={title} description={workflow.description} />
            <Modal.Form
                onSubmit={(e) => {
                    e.preventDefault();
                    setSubmitted(true);
                    if (!ready || busy) return;
                    onStart(Object.fromEntries(fields.map((f) => [f.key, (values[f.key] ?? '').trim()])));
                }}
            >
                <Modal.Body>
                    <div className="space-y-default">
                        {fields.map((field) => {
                            const id = `workflow-start-${field.key}`;
                            // A framework catalogue that would not load is the
                            // field's own error until a submit has something
                            // more specific to say.
                            const loadError = field.spec.kind === 'framework' ? frameworks.error : null;
                            return (
                                <FormField
                                    key={field.key}
                                    label={t(`runs.startForm.field.${field.key}.label`)}
                                    description={t(`runs.startForm.field.${field.key}.hint`)}
                                    error={problemText(field) ?? loadError ?? undefined}
                                    required
                                >
                                    {control(field, field.spec, id)}
                                </FormField>
                            );
                        })}
                        {error && <InlineNotice variant="error">{error}</InlineNotice>}
                    </div>
                </Modal.Body>
                <Modal.Footer>
                    {/* ONE action, secondary. Starting a run is an everyday act
                        on this page rather than its one emphasis, and the
                        product's primary count is a ceiling with nothing on
                        this page to pay for a new one (`primary-secondary-ratio`).
                        A Cancel beside a secondary submit would end the footer
                        on the less affirmative action (`modal-action-order`),
                        so dismissing is the dialog's own close button, Escape
                        or the backdrop — all of which `onCancel` handles. */}
                    <Button type="submit" variant="secondary" disabled={busy} data-testid="workflow-start-submit">
                        {t('runs.startForm.submit')}
                    </Button>
                </Modal.Footer>
            </Modal.Form>
        </Modal>
    );
}
