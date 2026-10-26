'use client';

/**
 * NewPolicyModal — modal-form P2 execution.
 *
 * Mounts the P1-extracted `useNewPolicyForm` hook + `<NewPolicyFields>`
 * markup inside a `<Modal>` shell. Composes the canonical NewRiskModal
 * pattern (Epic 54 precedent): `Modal.Form` wraps the body + actions
 * so submit fires from the pinned Cancel/Create row.
 *
 * The legacy `/policies/new` route survives as a thin redirect →
 * `/policies?create=1`; the list page (PoliciesClient) reads the flag
 * on mount and opens this modal.
 */
import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { apiErrorMessage } from '@/lib/api-error';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { useNewPolicyForm } from './_form/useNewPolicyForm';
import { NewPolicyFields } from './_form/NewPolicyFields';
import { TemplateControlSuggestModal, type SuggestionResultDTO } from './templates/TemplateControlSuggestModal';

export interface NewPolicyModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    /** When true, the modal opens in template-picker mode. */
    isTemplateMode?: boolean;
}

export function NewPolicyModal({
    open,
    setOpen,
    isTemplateMode = false,
}: NewPolicyModalProps) {
    const tenantHref = useTenantHref();
    const apiUrl = useTenantApiUrl();
    const router = useRouter();
    const t = useTranslations('policies');

    // Framework-aware template creates return `suggestedControlLinks`; when
    // there are matches we surface the confirm-and-link panel BEFORE
    // navigating (parity with the retired /policies/templates page).
    const [suggest, setSuggest] = useState<{
        policyId: string;
        policyTitle: string;
        result: SuggestionResultDTO;
    } | null>(null);

    // Prompt-3.3 — "Start with" is now internal state so "From template" opens
    // the in-modal template picker (carrying the typed title forward) instead of
    // abandoning the modal + discarding the title. The /policies/templates page
    // is no longer the only path — this is the single, consistent creation flow.
    const [templateMode, setTemplateMode] = useState(isTemplateMode);
    // The list page keeps this modal MOUNTED while it is closed, so state
    // seeded from the prop at mount kept the first value for good — the
    // `?template=1` deep link sets the prop after mount and still opened on
    // "New". Re-seed on every open (React's adjust-state-during-render
    // pattern, no effect needed); switching modes inside an open dialog is
    // untouched.
    const [wasOpen, setWasOpen] = useState(open);
    if (open !== wasOpen) {
        setWasOpen(open);
        if (open) setTemplateMode(isTemplateMode);
    }

    const createModeOptions = useMemo<ComboboxOption[]>(
        () => [
            { value: 'new', label: t('new.modeNew') },
            { value: 'from-template', label: t('new.modeFromTemplate') },
        ],
        [t],
    );

    const form = useNewPolicyForm({
        isTemplateMode: templateMode,
        onSuccess: (policy) => {
            if (policy.suggestedControlLinks && policy.suggestedControlLinks.totalSuggested > 0) {
                setOpen(false);
                setSuggest({
                    policyId: policy.id,
                    policyTitle: policy.title ?? '',
                    result: policy.suggestedControlLinks,
                });
                return;
            }
            setOpen(false);
            router.push(tenantHref(`/policies/${policy.id}`));
        },
    });

    // P3 — unsaved-changes warning. Every close path (Cancel button,
    // X, Escape, outside click) routes through `guardedSetOpen` —
    // Radix's `onOpenChange` (wired via `setShowModal`) fires the same
    // setter, so the warning catches all of them uniformly.
    const guardedSetOpen = useCallback<Dispatch<SetStateAction<boolean>>>(
        (next) => {
            const wantClose =
                typeof next === 'function' ? !next(true) : next === false;
            if (wantClose) {
                if (form.submitting) return;
                if (
                    form.isDirty &&
                    !window.confirm(t('new.discard'))
                ) {
                    return;
                }
            }
            setOpen(next);
        },
        [form.submitting, form.isDirty, setOpen, t],
    );
    const close = () => guardedSetOpen(false);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        void form.submit();
    };

    return (
        <>
        <Modal
            showModal={open}
            setShowModal={guardedSetOpen}
            size="lg"
            preventDefaultClose={form.submitting}
        >
            {/* Prompt-3.5 — the title/description live ONLY on Modal.Header
                (previously duplicated on both <Modal> and <Modal.Header>). */}
            <Modal.Header
                title={templateMode ? t('new.titleTemplate') : t('new.titleBlank')}
                description={
                    templateMode ? t('new.descTemplate') : t('new.descBlank')
                }
            />
            <Modal.Form id="new-policy-form" onSubmit={handleSubmit}>
                <Modal.Body>
                    <div className="mb-default">
                        <FormField label={t('new.startWith')}>
                            <Combobox
                                id="new-policy-mode"
                                name="newPolicyMode"
                                options={createModeOptions}
                                selected={createModeOptions.find((o) => o.value === (templateMode ? 'from-template' : 'new')) ?? createModeOptions[0]}
                                setSelected={(o) => {
                                    // Switch modes IN the modal — the typed title
                                    // and other fields are preserved (same form).
                                    setTemplateMode(o?.value === 'from-template');
                                }}
                                placeholder={t('new.modePlaceholder')}
                                hideSearch
                                matchTriggerWidth
                                forceDropdown
                                buttonProps={{ className: 'w-full' }}
                                caret
                            />
                        </FormField>
                    </div>
                    {form.error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="new-policy-error"
                            role="alert"
                        >
                            {form.error}
                        </div>
                    )}
                    <fieldset
                        disabled={form.submitting}
                        className="m-0 p-0 border-0 space-y-default"
                    >
                        <NewPolicyFields form={form} />
                    </fieldset>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={close}
                        disabled={form.submitting}
                        id="new-policy-cancel-btn"
                    >
                        {t('new.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={!form.canSubmit}
                        id="create-policy-btn"
                    >
                        {form.submitting ? t('new.creating') : t('createPolicy')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
        {suggest && (
            <TemplateControlSuggestModal
                policyTitle={suggest.policyTitle}
                result={suggest.result}
                onConfirm={async (controlIds) => {
                    if (controlIds.length) {
                        const res = await fetch(apiUrl(`/policies/${suggest.policyId}/control-links`), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ controlIds }),
                        });
                        // A refused link used to be ignored and the user taken
                        // to the policy as if the controls were linked. Throw
                        // instead: the dialog stays open and says why, so they
                        // can retry or skip.
                        if (!res.ok) {
                            const body = await res.json().catch(() => ({}));
                            throw new Error(apiErrorMessage(body, t('templates.linkFailed')));
                        }
                    }
                    setSuggest(null);
                    router.push(tenantHref(`/policies/${suggest.policyId}`));
                }}
                onSkip={() => {
                    setSuggest(null);
                    router.push(tenantHref(`/policies/${suggest.policyId}`));
                }}
            />
        )}
        </>
    );
}
