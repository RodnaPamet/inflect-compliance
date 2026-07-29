'use client';

/**
 * NewVendorModal — modal-form P2 execution.
 */
import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTenantHref } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
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
    });

    // P3 — unsaved-changes guard. See NewPolicyModal for the pattern.
    const guardedSetOpen = useCallback<Dispatch<SetStateAction<boolean>>>(
        (next) => {
            const wantClose =
                typeof next === 'function' ? !next(true) : next === false;
            if (wantClose) {
                if (form.submitting) return;
                if (
                    form.isDirty &&
                    !window.confirm(t('modal.discardConfirm'))
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
        </Modal>
    );
}
