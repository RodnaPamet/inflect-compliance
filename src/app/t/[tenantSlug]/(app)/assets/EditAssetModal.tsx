'use client';

/**
 * EditAssetModal — modal-form P2 execution.
 *
 * Unlike the three create modals (which the list page opens via
 * `?create=1`), the asset edit modal mounts from the asset DETAIL
 * page header. The detail page URL stays canonical; the modal is a
 * pure overlay launched from the "Edit" button.
 *
 * Composes the P1-extracted `useEditAssetForm` hook + `<EditAssetFields>`
 * markup. The hook seeds from the loaded asset row and PATCHes back;
 * on success the modal closes and the parent's `onSaved` callback
 * applies the updated row to the detail-page state.
 */
import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import type { AssetDetail } from '@/lib/dto/asset.types';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { useTenantContext } from '@/lib/tenant-context-provider';
import {
    useEditAssetForm,
    type EditAssetFormFields,
} from './_form/useEditAssetForm';
import { EditAssetFields } from './_form/EditAssetFields';

export interface EditAssetModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    assetId: string;
    initial: Partial<EditAssetFormFields>;
    onSaved: (updated: AssetDetail) => void;
}

export function EditAssetModal({
    open,
    setOpen,
    assetId,
    initial,
    onSaved,
}: EditAssetModalProps) {
    const t = useTranslations('assets');
    const { tenantSlug } = useTenantContext();
    const form = useEditAssetForm({
        assetId,
        initial,
        onSuccess: (updated) => {
            setOpen(false);
            onSaved(updated);
        },
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
                    !window.confirm(t('modal.editDiscardConfirm'))
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
            title={t('modal.editTitle')}
            description={t('modal.editDescription')}
            preventDefaultClose={form.submitting}
        >
            <Modal.Header
                title={t('modal.editTitle')}
                description={t('modal.editDescription')}
            />
            <Modal.Form id="edit-asset-form" onSubmit={handleSubmit}>
                <Modal.Body>
                    {form.error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="edit-asset-error"
                            role="alert"
                        >
                            {form.error}
                        </div>
                    )}
                    <fieldset
                        disabled={form.submitting}
                        className="m-0 p-0 border-0 space-y-default"
                    >
                        <EditAssetFields form={form} tenantSlug={tenantSlug} />
                    </fieldset>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={close}
                        disabled={form.submitting}
                        id="edit-asset-cancel-btn"
                    >
                        {t('cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={!form.canSubmit}
                        id="save-asset-btn"
                    >
                        {form.submitting ? t('modal.saving') : t('modal.save')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
