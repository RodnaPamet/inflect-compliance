'use client';

/**
 * The start form for a workflow that declares `requiredInput` (#4472).
 *
 * ONE form for every such workflow, built from the definition's declaration
 * through `startPlanFor` — never a hand-made form per workflow. Each field is a
 * required input, in the order the definition declares them, collected as its
 * `StartFieldSpec` says: a framework from the catalogue, a discovered agent
 * from the agent inventory, or typed text.
 *
 * A picker is only ever rendered for a caller the plan has already found may
 * read its list (`StartAbilities`), so its load failing is a fault to report,
 * not a permission to discover.
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
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

import { sourceKindLabel } from '../reports/harness/source-kind-label';

/** What a discovered-agent option carries besides its id and label. */
interface DiscoveredMeta {
    readonly discoveredVia: readonly string[];
    readonly lastSeenAt: string;
    readonly registeredAgentName: string | null;
}

interface Loaded<TMeta> {
    readonly options: ComboboxOption<TMeta>[] | null;
    readonly truncated: boolean;
    readonly error: string | null;
}

type ReadOptions<TMeta> = (body: unknown) => { options: ComboboxOption<TMeta>[]; truncated: boolean };

/** `GET /frameworks` — the catalogue, every row; the value is the framework's key. */
const readFrameworks: ReadOptions<undefined> = (body) => ({
    options: (Array.isArray(body) ? (body as Array<{ key: string; name: string }>) : []).map((fw) => ({
        value: fw.key,
        label: fw.name,
    })),
    truncated: false,
});

/** `GET …/admin/agents/discovered` — newest seen first, with the route's own `truncated`. */
const readDiscoveredAgents: ReadOptions<DiscoveredMeta> = (body) => {
    const b = (body ?? {}) as {
        rows?: Array<{ id: string; discoveredId: string } & DiscoveredMeta>;
        truncated?: boolean;
    };
    return {
        options: (b.rows ?? []).map((a) => ({
            value: a.id,
            label: a.discoveredId,
            meta: {
                discoveredVia: a.discoveredVia,
                lastSeenAt: a.lastSeenAt,
                registeredAgentName: a.registeredAgentName,
            },
        })),
        truncated: b.truncated === true,
    };
};

/** One list, loaded once when the form opens and only if a field needs it. */
function useLoadedOptions<TMeta>(
    needed: boolean,
    path: string,
    read: ReadOptions<TMeta>,
    failed: string,
): Loaded<TMeta> {
    const apiUrl = useTenantApiUrl();
    const [loaded, setLoaded] = useState<Loaded<TMeta>>({ options: null, truncated: false, error: null });

    useEffect(() => {
        if (!needed) return;
        let cancelled = false;
        void (async () => {
            try {
                const res = await fetch(apiUrl(path));
                const body: unknown = await res.json().catch(() => null);
                if (cancelled) return;
                if (!res.ok) {
                    setLoaded({ options: null, truncated: false, error: apiErrorMessage(body, failed) });
                    return;
                }
                setLoaded({ ...read(body), error: null });
            } catch {
                if (!cancelled) setLoaded({ options: null, truncated: false, error: failed });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [needed, path, read, failed, apiUrl]);

    return loaded;
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

    const frameworks = useLoadedOptions(
        fields.some((f) => f.spec.kind === 'framework'),
        '/frameworks',
        readFrameworks,
        t('runs.startForm.frameworksFailed'),
    );
    const discovered = useLoadedOptions(
        fields.some((f) => f.spec.kind === 'discoveredAgent'),
        '/admin/agents/discovered',
        readDiscoveredAgents,
        t('runs.startForm.discoveredFailed'),
    );

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

    /** The line under a discovered agent: when it was last seen, by which sources, and its register row. */
    function describeDiscovered(meta: DiscoveredMeta | undefined) {
        if (!meta) return null;
        const seen = t('runs.startForm.discoveredSeen', {
            date: formatDateTime(meta.lastSeenAt),
            sources: meta.discoveredVia.map((kind) => sourceKindLabel(t, kind)).join(', '),
        });
        return meta.registeredAgentName
            ? `${seen} · ${t('runs.startForm.discoveredRegistered', { name: meta.registeredAgentName })}`
            : seen;
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
        if (spec.kind === 'discoveredAgent') {
            const options = discovered.options ?? [];
            return (
                <Combobox<false, DiscoveredMeta>
                    id={id}
                    options={options}
                    loading={discovered.options === null && discovered.error === null}
                    selected={options.find((o) => o.value === values[field.key]) ?? null}
                    setSelected={(opt) => set(field.key, opt?.value ?? '')}
                    optionDescription={(opt) => describeDiscovered(opt.meta)}
                    placeholder={t('runs.startForm.discoveredPlaceholder')}
                    emptyState={t('runs.startForm.noDiscoveredAgents')}
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
                            // A list that would not load is the field's own
                            // error until a submit has something more specific
                            // to say.
                            const list =
                                field.spec.kind === 'framework'
                                    ? frameworks
                                    : field.spec.kind === 'discoveredAgent'
                                      ? discovered
                                      : null;
                            return (
                                <div key={field.key} className="space-y-tight">
                                    <FormField
                                        label={t(`runs.startForm.field.${field.key}.label`)}
                                        description={t(`runs.startForm.field.${field.key}.hint`)}
                                        error={problemText(field) ?? list?.error ?? undefined}
                                        required
                                    >
                                        {control(field, field.spec, id)}
                                    </FormField>
                                    {/* A CUT LIST SAYS SO. The route reads one
                                        past its cap, so this is a fact rather
                                        than a guess from a list that happens
                                        to stop where the cap is. */}
                                    {field.spec.kind === 'discoveredAgent' && discovered.truncated && (
                                        <InlineNotice variant="warning" data-testid="workflow-start-discovered-truncated">
                                            {t('runs.startForm.discoveredTruncated', {
                                                shown: discovered.options?.length ?? 0,
                                            })}
                                        </InlineNotice>
                                    )}
                                </div>
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
