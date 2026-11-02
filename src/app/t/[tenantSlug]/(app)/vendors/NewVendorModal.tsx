'use client';

/**
 * NewVendorModal — modal-form P2 execution.
 */
import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTenantHref } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Modal } from '@/components/ui/modal';
import { useNewVendorForm } from './_form/useNewVendorForm';
import { NewVendorFields } from './_form/NewVendorFields';

export interface NewVendorModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
}

export function NewVendorModal({ open, setOpen }: NewVendorModalProps) {
    const t = useTranslations('vendors');
    const tenantHref = useTenantHref();
    const router = useRouter();

    const form = useNewVendorForm({
        onSuccess: (vendor) => {
            setOpen(false);
            router.push(tenantHref(`/vendors/${vendor.id}`));
        },
        fallbackErrorMessage: t('createFailed'),
        nameTakenMessage: t('form.nameTaken'),
    });

    // P3 — unsaved-changes guard, as the task and audit forms ask it (#4964).
    //
    // It used to be `window.confirm`: the browser's own dialog, whose buttons
    // are in the browser's language rather than the workspace's. It is now the
    // platform <ConfirmDialog>. That dialog is async, so the close request is
    // PARKED in `pendingClose` until the user answers.
    const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
    const pendingClose = useRef<SetStateAction<boolean> | null>(null);

    const guardedSetOpen = useCallback<Dispatch<SetStateAction<boolean>>>(
        (next) => {
            const wantClose =
                typeof next === 'function' ? !next(true) : next === false;
            if (wantClose) {
                if (form.submitting) return;
                if (form.isDirty) {
                    pendingClose.current = next;
                    setConfirmDiscardOpen(true);
                    return;
                }
            }
            setOpen(next);
        },
        [form.submitting, form.isDirty, setOpen],
    );
    const close = () => guardedSetOpen(false);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        void form.submit();
    };

    return (
        <Modal
            showModal={open}
            setShowModal={guardedSetOpen}
            size="lg"
            title={t('modal.title')}
            description={t('modal.description')}
            preventDefaultClose={form.submitting}
        >
            <Modal.Header
                title={t('modal.title')}
                description={t('modal.description')}
            />
            <Modal.Form id="new-vendor-form" onSubmit={handleSubmit}>
                <Modal.Body>
                    {form.error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="new-vendor-error"
                            role="alert"
                        >
                            {form.error}
                        </div>
                    )}
                    <fieldset
                        disabled={form.submitting}
                        className="m-0 p-0 border-0 space-y-default"
                    >
                        <NewVendorFields form={form} />
                    </fieldset>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={close}
                        disabled={form.submitting}
                        id="new-vendor-cancel-btn"
                    >
                        {t('modal.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={!form.canSubmit}
                        id="create-vendor-submit"
                    >
                        {form.submitting ? t('modal.creating') : t('modal.create')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
            {/* `warning`, not `danger`: an unsaved draft is recoverable by
                retyping, and "Discard draft" is the verb for unsaved state. */}
            <ConfirmDialog
                showModal={confirmDiscardOpen}
                setShowModal={setConfirmDiscardOpen}
                tone="warning"
                title={t('modal.discardTitle')}
                description={t('modal.discardConfirm')}
                confirmLabel={t('modal.discardConfirmLabel')}
                cancelLabel={t('modal.discardCancelLabel')}
                onConfirm={() => {
                    const next = pendingClose.current ?? false;
                    pendingClose.current = null;
                    setOpen(next);
                }}
                onCancel={() => {
                    // Keep the form open with the draft intact.
                    pendingClose.current = null;
                }}
            />
        </Modal>
    );
}
