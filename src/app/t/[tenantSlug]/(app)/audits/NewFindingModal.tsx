'use client';

/**
 * NewFindingModal — feat/audit-cycle-unify.
 *
 * Create-finding affordance on the audit surface. Findings were
 * previously display-only on the audit detail pane; this modal lets a
 * writer raise a finding directly against the currently-open audit
 * (auditId prefilled) via the canonical POST /api/t/:slug/findings API.
 * On success the parent audit is reloaded so the new finding appears.
 *
 * Deliberately slim — reuses the finding form's core fields
 * (title / type / severity / description). Assignee, controls, and risk
 * links stay on the full Findings-list create modal.
 *
 * P3.1 — the single write runs through `useTenantMutation` keyed on the
 * findings LIST cache, so the request lifecycle (in-flight flag, error,
 * reset) is the hook's rather than three pieces of local state that each
 * had to be moved in step.
 */
import {
    useEffect,
    useMemo,
    useState,
    type Dispatch,
    type SetStateAction,
} from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import { CACHE_KEYS } from '@/lib/swr-keys';
import type { CappedList } from '@/lib/list-backfill-cap';

export interface NewFindingModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    auditId: string;
    apiUrl: (path: string) => string;
    /** Called after a successful create so the parent can reload the audit. */
    onCreated?: () => void;
}

const EMPTY = {
    title: '',
    description: '',
    type: 'NONCONFORMITY',
    severity: 'MEDIUM',
};

/** The POST body — the four form fields plus the audit the modal is open on. */
interface CreateFindingInput {
    auditId: string;
    title: string;
    description: string;
    type: string;
    severity: string;
}

export function NewFindingModal({
    open,
    setOpen,
    auditId,
    apiUrl,
    onCreated,
}: NewFindingModalProps) {
    const tx = useTranslations('audits');
    const [form, setForm] = useState({ ...EMPTY });

    /**
     * The create write.
     *
     * Keyed on the FINDINGS LIST: a POST that mints a new entity belongs to
     * the list cache it appends to (the findings register reads that exact
     * key), not to a detail entry that does not exist yet.
     *
     * **No optimistic prediction.** The server mints the id, the status and
     * the created timestamp, and the register's row carries fields this modal
     * never collects — a painted row would shift on revalidation. Waiting is
     * the honest answer.
     *
     * The audit list's `_count.findings` is stale after this too, but it is
     * NOT invalidated here: the parent's `onCreated` already revalidates it,
     * and the parent is the only side that knows whether the live key is
     * `/audits` or the cycle-scoped `/audits?cycleId=…`. Naming the bare key
     * here would duplicate one case and miss the other.
     */
    const createMutation = useTenantMutation<
        CappedList<unknown>,
        CreateFindingInput,
        unknown
    >({
        key: CACHE_KEYS.findings.list(),
        mutationFn: async (input) => {
            const res = await fetch(apiUrl('/findings'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input),
            });
            if (!res.ok) {
                // Prefer the server's own message — a validation failure names
                // the offending field, which the generic fallback cannot.
                //
                // `withApiErrorHandling` sends `{ error: { code, message } }`,
                // an OBJECT. The previous expression was
                // `data.message || data.error`, which handed that object to
                // `new Error(...)` and rendered "[object Object]" in the banner
                // below. Same intent, now reading the message it was after.
                const data: {
                    message?: string;
                    error?: string | { message?: string };
                } = await res.json().catch(() => ({}));
                const serverMessage =
                    data.message ??
                    (typeof data.error === 'string' ? data.error : data.error?.message);
                throw new Error(serverMessage || tx('findingModal.createFailed'));
            }
            return res.json().catch(() => null);
        },
    });

    const submitting = createMutation.isMutating;
    // The inline error surface is the hook's `error`, not a second copy of it:
    // it holds the last failure until `reset()` or the next trigger.
    const error = createMutation.error?.message ?? '';
    const resetMutation = createMutation.reset;

    const typeOptions = useMemo<ComboboxOption[]>(
        () =>
            ['NONCONFORMITY', 'OBSERVATION', 'OPPORTUNITY'].map((v) => ({
                value: v,
                label: tx(`findingModal.typeOptions.${v}`),
            })),
        [tx],
    );
    const severityOptions = useMemo<ComboboxOption[]>(
        () =>
            ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((v) => ({
                value: v,
                label: tx(`findingModal.severityOptions.${v}`),
            })),
        [tx],
    );

    useEffect(() => {
        if (!open) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setForm({ ...EMPTY });
        // Clears the hook's `error` (and, with it, the inline banner) — the
        // in-flight flag is the hook's own and needs no reset here.
        resetMutation();
    }, [open, resetMutation]);

    const update = <K extends keyof typeof form>(field: K, value: (typeof form)[K]) =>
        setForm((prev) => ({ ...prev, [field]: value }));

    const canSubmit =
        form.title.trim().length > 0 && form.description.trim().length > 0 && !submitting;

    const close = () => {
        if (!submitting) setOpen(false);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!canSubmit) return;
        try {
            await createMutation.trigger({
                auditId,
                title: form.title.trim(),
                description: form.description.trim(),
                type: form.type,
                severity: form.severity,
            });
            setOpen(false);
            onCreated?.();
        } catch {
            // The message is already on the hook's `error` and renders in the
            // banner below; the modal deliberately stays open with the form
            // intact so the user can correct and retry.
        }
    };

    return (
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="md"
            title={tx('findingModal.title')}
            description={tx('findingModal.description')}
            preventDefaultClose={submitting}
        >
            <Modal.Header
                title={tx('findingModal.title')}
                description={tx('findingModal.description')}
            />
            <Modal.Form id="new-audit-finding-form" onSubmit={handleSubmit}>
                <Modal.Body>
                    {error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="new-audit-finding-error"
                            role="alert"
                        >
                            {error}
                        </div>
                    )}
                    <fieldset disabled={submitting} className="m-0 border-0 p-0 space-y-default">
                        <FormField label={tx('findingModal.labelTitle')} required>
                            <Input
                                id="audit-finding-title"
                                type="text"
                                placeholder={tx('findingModal.placeholderTitle')}
                                value={form.title}
                                onChange={(e) => update('title', e.target.value)}
                                required
                                autoComplete="off"
                            />
                        </FormField>

                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField label={tx('findingModal.labelType')}>
                                <Combobox
                                    id="audit-finding-type"
                                    options={typeOptions}
                                    selected={typeOptions.find((o) => o.value === form.type) ?? null}
                                    setSelected={(o) => update('type', o?.value ?? 'NONCONFORMITY')}
                                    hideSearch
                                    matchTriggerWidth
                                    buttonProps={{ className: 'w-full' }}
                                    caret
                                />
                            </FormField>
                            <FormField label={tx('findingModal.labelSeverity')}>
                                <Combobox
                                    id="audit-finding-severity"
                                    options={severityOptions}
                                    selected={severityOptions.find((o) => o.value === form.severity) ?? null}
                                    setSelected={(o) => update('severity', o?.value ?? 'MEDIUM')}
                                    hideSearch
                                    matchTriggerWidth
                                    buttonProps={{ className: 'w-full' }}
                                    caret
                                />
                            </FormField>
                        </div>

                        <FormField label={tx('findingModal.labelDescription')} required>
                            <Textarea
                                id="audit-finding-description"
                                rows={3}
                                placeholder={tx('findingModal.placeholderDescription')}
                                value={form.description}
                                onChange={(e) => update('description', e.target.value)}
                                required
                            />
                        </FormField>
                    </fieldset>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={close}
                        disabled={submitting}
                        id="new-audit-finding-cancel-btn"
                    >
                        {tx('findingModal.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={!canSubmit}
                        id="submit-audit-finding"
                    >
                        {submitting ? tx('findingModal.creating') : tx('findingModal.submit')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
