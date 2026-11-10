'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * Epic 54 — Add Text/Link Evidence modal.
 *
 * Modal-based replacement for the inline `#text-evidence-form` that
 * EvidenceClient rendered toggle-style above the list. Keeps the same
 * POST `/evidence` contract (type=TEXT); on success it revalidates the
 * SWR evidence-list cache so the new row appears immediately.
 *
 * Preserved form ID: `text-evidence-form` (used by existing E2E).
 */

import { useSWRConfig } from 'swr';
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
} from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import {
    EvidenceCategoryField,
    EvidenceControlsField,
    EvidenceDescriptionField,
} from './_form/EvidenceFormFields';
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

export interface NewEvidenceTextModalProps {
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
    /** Categories the workspace already uses, offered after the standard list (#5018). */
    existingCategories?: ReadonlyArray<string>;
}

export function NewEvidenceTextModal({
    open,
    setOpen,
    tenantSlug,
    apiUrl,
    controls,
    canEditControlLinks,
    existingCategories = [],
}: NewEvidenceTextModalProps) {
    const tx = useTranslations('evidence');
    const close = useCallback(() => setOpen(false), [setOpen]);
    // Epic 69 — the evidence list reads from
    // `useTenantSWR(CACHE_KEYS.evidence.list())`, so on a successful create
    // we revalidate every `/evidence?…` SWR entry (the sole source of truth
    // for the list page). The legacy React-Query invalidation this modal
    // once carried is gone — SWR is the only cache now.
    const { mutate: swrMutate } = useSWRConfig();
    const titleRef = useRef<HTMLInputElement>(null);

    const [form, setForm] = useState({
        title: '',
        content: '',
        controlIds: [] as string[],
        category: '',
        description: '',
        // B8 follow-up — free-text folder label. Datalist below
        // seeds it with values already in use on existing evidence.
        folder: '',
        owner: '',
    });
    const [error, setError] = useState('');

    useEffect(() => {
        if (!open) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setForm({
            title: '',
            content: '',
            controlIds: [],
            category: '',
            description: '',
            folder: '',
            owner: '',
        });
        setError('');
        const t = setTimeout(() => titleRef.current?.focus(), 60);
        return () => clearTimeout(t);
    }, [open]);

    const update = <K extends keyof typeof form>(
        field: K,
        value: (typeof form)[K],
    ) => setForm((prev) => ({ ...prev, [field]: value }));

    const [submitting, setSubmitting] = useState(false);

    const telemetry = useFormTelemetry('NewEvidenceTextModal');

    const canSubmit =
        form.title.trim().length > 0 && !submitting;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!canSubmit) return;
        setError('');
        telemetry.trackSubmit({
            hasControlLink: form.controlIds.length > 0,
            contentLength: form.content?.length ?? 0,
        });
        setSubmitting(true);
        try {
            const res = await fetch(apiUrl('/evidence'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...form,
                    category: form.category.trim() || null,
                    description: form.description.trim() || null,
                    type: 'TEXT',
                }),
            });
            if (!res.ok) {
                // The error body is the envelope `{ error: { code, message } }`;
                // `err.error || …` read "[object Object]" (#4126).
                const err = await res.json().catch(() => null);
                throw new Error(apiErrorMessage(err, tx('text.createFailed')));
            }
            const data = await res.json();
            // Revalidate every `/evidence?…` SWR cache entry so the list
            // page refreshes regardless of which filter view was active.
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
                err instanceof Error ? err.message : tx('text.createFailed'),
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
            title={tx('text.title')}
            description={tx('text.description')}
            preventDefaultClose={submitting}
        >
            <Modal.Header
                title={tx('text.title')}
                description={tx('text.description')}
            />
            <Modal.Form id="text-evidence-form" onSubmit={handleSubmit}>
                <Modal.Body>
                    {error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="text-evidence-error"
                            role="alert"
                            data-testid="text-evidence-error"
                        >
                            {error}
                        </div>
                    )}

                    <fieldset
                        className="space-y-default"
                        disabled={submitting}
                    >
                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <div>
                                <label
                                    className="mb-1 block text-sm text-content-default"
                                    htmlFor="text-evidence-title-input"
                                >
                                    {tx('text.titleLabel')} <RequiredMarker />
                                </label>
                                <input
                                    id="text-evidence-title-input"
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
                                <div className="sm:col-span-2">
                                    <EvidenceControlsField
                                        id="text-evidence-control-select"
                                        controls={controls}
                                        value={form.controlIds}
                                        onChange={(v) => update('controlIds', v)}
                                    />
                                </div>
                            )}
                            <div>
                                <label
                                    className="mb-1 block text-sm text-content-default"
                                    htmlFor="text-evidence-owner-input"
                                >
                                    {tx('text.ownerLabel')}
                                </label>
                                <input
                                    id="text-evidence-owner-input"
                                    type="text"
                                    className="input w-full"
                                    value={form.owner}
                                    onChange={(e) =>
                                        update('owner', e.target.value)
                                    }
                                    autoComplete="off"
                                />
                            </div>
                            <EvidenceCategoryField
                                id="text-evidence-category-input"
                                value={form.category}
                                onChange={(v) => update('category', v)}
                                existingCategories={existingCategories}
                            />
                        </div>
                        {/* B8 follow-up — Folder. Free text with a
                            datalist that suggests folders already
                            in use on the loaded evidence so users
                            converge on a small named set without
                            being forced into one. */}
                        <div>
                            <label
                                className="mb-1 block text-sm text-content-default"
                                htmlFor="text-evidence-folder-input"
                            >
                                {tx('text.folderLabel')} <span className="text-content-subtle font-normal">{tx('text.folderOptional')}</span>
                            </label>
                            <input
                                id="text-evidence-folder-input"
                                data-testid="text-evidence-folder-input"
                                type="text"
                                className="input w-full"
                                placeholder={tx('text.folderPlaceholder')}
                                list="evidence-folder-suggestions"
                                value={form.folder}
                                onChange={(e) =>
                                    update('folder', e.target.value)
                                }
                                autoComplete="off"
                            />
                        </div>
                        <div>
                            <label
                                className="mb-1 block text-sm text-content-default"
                                htmlFor="text-evidence-content-input"
                            >
                                {tx('text.contentLabel')}
                            </label>
                            <textarea
                                id="text-evidence-content-input"
                                className="input w-full"
                                rows={4}
                                value={form.content}
                                onChange={(e) =>
                                    update('content', e.target.value)
                                }
                                placeholder={tx('text.contentPlaceholder')}
                            />
                        </div>
                        <EvidenceDescriptionField
                            id="text-evidence-description-input"
                            value={form.description}
                            onChange={(v) => update('description', v)}
                        />
                    </fieldset>
                </Modal.Body>

                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        id="text-evidence-cancel-btn"
                        onClick={() => {
                            if (!submitting) close();
                        }}
                        disabled={submitting}
                    >
                        {tx('text.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        id="create-text-evidence-btn"
                        disabled={!canSubmit}
                    >
                        {submitting ? tx('text.creating') : tx('text.submit')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
