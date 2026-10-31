'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * EP-3 — Add Link/URL Evidence modal.
 *
 * Sibling of `NewEvidenceTextModal` but for `type: 'LINK'` — the
 * evidence body is a URL captured in the `content` field. POSTs to
 * `/evidence` with the many-to-many `controlIds` contract.
 */

import { useSWRConfig } from 'swr';
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
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { RequiredMarker } from '@/components/ui/required-marker';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { apiErrorMessage } from '@/lib/api-error';
import { useFormTelemetry } from '@/lib/telemetry/form-telemetry';

interface ControlOption {
    id: string;
    name: string;
    annexId?: string | null;
    code?: string | null;
}

export interface NewEvidenceLinkModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    tenantSlug: string;
    apiUrl: (path: string) => string;
    controls: ControlOption[];
    /**
     * Offer the control picker. A record created with a control adds a link,
     * which needs the coarse write tier AND `controls.edit`, a key a custom
     * role on a write-tier base can lack (#4326). Without it the picker is not
     * shown and the record is created with no control.
     */
    canEditControlLinks: boolean;
}

export function NewEvidenceLinkModal({
    open,
    setOpen,
    tenantSlug: _tenantSlug,
    apiUrl,
    controls,
    canEditControlLinks,
}: NewEvidenceLinkModalProps) {
    const tx = useTranslations('evidence');
    const close = useCallback(() => setOpen(false), [setOpen]);
    const { mutate: swrMutate } = useSWRConfig();
    const titleRef = useRef<HTMLInputElement>(null);

    const [form, setForm] = useState({
        title: '',
        url: '',
        controlId: '',
        category: '',
        folder: '',
    });
    const [error, setError] = useState('');
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        if (!open) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setForm({ title: '', url: '', controlId: '', category: '', folder: '' });
        setError('');
        const t = setTimeout(() => titleRef.current?.focus(), 60);
        return () => clearTimeout(t);
    }, [open]);

    const update = <K extends keyof typeof form>(
        field: K,
        value: (typeof form)[K],
    ) => setForm((prev) => ({ ...prev, [field]: value }));

    const controlOptions = useMemo<ComboboxOption<ControlOption>[]>(
        () =>
            controls.map((c) => ({
                value: c.id,
                label: `${c.annexId || c.code || 'Custom'}: ${c.name}`,
                meta: c,
            })),
        [controls],
    );

    const telemetry = useFormTelemetry('NewEvidenceLinkModal');

    const canSubmit =
        form.title.trim().length > 0 &&
        form.url.trim().length > 0 &&
        !submitting;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!canSubmit) return;
        setError('');
        telemetry.trackSubmit({
            hasControlLink: Boolean(form.controlId),
            contentLength: form.url.length,
        });
        setSubmitting(true);
        try {
            const res = await fetch(apiUrl('/evidence'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'LINK',
                    title: form.title,
                    content: form.url.trim(),
                    controlIds: form.controlId ? [form.controlId] : [],
                    category: form.category.trim() || null,
                    folder: form.folder.trim() || null,
                }),
            });
            if (!res.ok) {
                // The error body is the envelope `{ error: { code, message } }`;
                // `err.error || …` handed that OBJECT to `new Error`, which read
                // "[object Object]" (#4126).
                const err = await res.json().catch(() => null);
                throw new Error(apiErrorMessage(err, tx('linkModal.createFailed')));
            }
            const data = await res.json();
            const evidenceUrlPrefix = apiUrl(CACHE_KEYS.evidence.list());
            void swrMutate(
                (key) =>
                    typeof key === 'string' &&
                    (key === evidenceUrlPrefix ||
                        key.startsWith(`${evidenceUrlPrefix}?`)),
                undefined,
                { revalidate: true },
            );
            telemetry.trackSuccess({
                evidenceId: (data as { id?: string })?.id,
            });
            close();
        } catch (err) {
            telemetry.trackError(err);
            setError(
                err instanceof Error ? err.message : tx('linkModal.createFailed'),
            );
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="lg"
            title={tx('linkModal.title')}
            description={tx('linkModal.description')}
            preventDefaultClose={submitting}
        >
            <Modal.Header
                title={tx('linkModal.title')}
                description={tx('linkModal.description')}
            />
            <Modal.Form id="link-evidence-form" onSubmit={handleSubmit}>
                <Modal.Body>
                    {error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="link-evidence-error"
                            role="alert"
                            data-testid="link-evidence-error"
                        >
                            {error}
                        </div>
                    )}

                    <fieldset className="space-y-default" disabled={submitting}>
                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <div>
                                <label
                                    className="mb-1 block text-sm text-content-default"
                                    htmlFor="link-evidence-title-input"
                                >
                                    {tx('linkModal.titleLabel')} <RequiredMarker />
                                </label>
                                <input
                                    id="link-evidence-title-input"
                                    ref={titleRef}
                                    type="text"
                                    className="input w-full"
                                    required
                                    value={form.title}
                                    onChange={(e) =>
                                        update('title', e.target.value)
                                    }
                                    autoComplete="off"
                                />
                            </div>
                            {canEditControlLinks && (
                            <FormField label={tx('linkModal.linkControlLabel')}>
                                <Combobox<false, ControlOption>
                                    id="link-evidence-control-select"
                                    name="controlId"
                                    options={controlOptions}
                                    selected={
                                        controlOptions.find(
                                            (o) => o.value === form.controlId,
                                        ) ?? null
                                    }
                                    setSelected={(option) =>
                                        update('controlId', option?.value ?? '')
                                    }
                                    placeholder={tx('linkModal.noControlLink')}
                                    searchPlaceholder={tx('linkModal.searchControls')}
                                    emptyState={tx('linkModal.noControlsMatch')}
                                    matchTriggerWidth
                                    forceDropdown
                                    buttonProps={{ className: 'w-full' }}
                                    caret
                                />
                            </FormField>
                            )}
                            <div>
                                <label
                                    className="mb-1 block text-sm text-content-default"
                                    htmlFor="link-evidence-category-input"
                                >
                                    {tx('linkModal.categoryLabel')}
                                </label>
                                <input
                                    id="link-evidence-category-input"
                                    type="text"
                                    className="input w-full"
                                    value={form.category}
                                    onChange={(e) =>
                                        update('category', e.target.value)
                                    }
                                    autoComplete="off"
                                />
                            </div>
                            <div>
                                <label
                                    className="mb-1 block text-sm text-content-default"
                                    htmlFor="link-evidence-folder-input"
                                >
                                    {tx('linkModal.folderLabel')}{' '}
                                    <span className="text-content-subtle font-normal">
                                        {tx('linkModal.folderOptional')}
                                    </span>
                                </label>
                                <input
                                    id="link-evidence-folder-input"
                                    data-testid="link-evidence-folder-input"
                                    type="text"
                                    className="input w-full"
                                    placeholder={tx('linkModal.folderPlaceholder')}
                                    list="evidence-folder-suggestions"
                                    value={form.folder}
                                    onChange={(e) =>
                                        update('folder', e.target.value)
                                    }
                                    autoComplete="off"
                                />
                            </div>
                        </div>
                        <div>
                            <label
                                className="mb-1 block text-sm text-content-default"
                                htmlFor="link-evidence-url-input"
                            >
                                {tx('linkModal.urlLabel')} <RequiredMarker />
                            </label>
                            <input
                                id="link-evidence-url-input"
                                type="url"
                                inputMode="url"
                                className="input w-full"
                                required
                                value={form.url}
                                onChange={(e) => update('url', e.target.value)}
                                placeholder={tx('linkModal.urlPlaceholder')}
                                autoComplete="off"
                            />
                        </div>
                    </fieldset>
                </Modal.Body>

                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        id="link-evidence-cancel-btn"
                        onClick={() => {
                            if (!submitting) close();
                        }}
                        disabled={submitting}
                    >
                        {tx('linkModal.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        id="create-link-evidence-btn"
                        disabled={!canSubmit}
                    >
                        {submitting
                            ? tx('linkModal.creating')
                            : tx('linkModal.submit')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
