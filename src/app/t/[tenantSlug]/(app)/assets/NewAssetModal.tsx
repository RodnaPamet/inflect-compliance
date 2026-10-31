'use client';

/**
 * NewAssetModal — modal-form follow-up (assets-create was missed by
 * the original P2 which scoped assets-EDIT only). Mirrors
 * `<NewVendorModal>` exactly: shared `<NewAssetFields>` + unsaved-
 * changes guard + `Modal.Form` pinned-footer shell.
 */
import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useSWRConfig } from 'swr';
import { useTenantHref, useTenantApiUrl } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { useNewAssetForm } from './_form/useNewAssetForm';
import {
    NewAssetFields,
    type NewAssetFieldsLabels,
} from './_form/NewAssetFields';

export interface NewAssetModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    tenantSlug: string;
    labels: NewAssetFieldsLabels & {
        cancel: string;
        createAsset: string;
        addAsset: string;
    };
}

export function NewAssetModal({
    open,
    setOpen,
    tenantSlug,
    labels,
}: NewAssetModalProps) {
    const t = useTranslations('assets');
    const tenantHref = useTenantHref();
    const router = useRouter();
    const { mutate: swrMutate } = useSWRConfig();
    const buildApiUrl = useTenantApiUrl();

    const form = useNewAssetForm({
        onSuccess: (asset) => {
            // Revalidate every variant of the Assets list key (unfiltered +
            // each `?<filters>`), so the new asset appears regardless of the
            // filter the list is currently showing (dual-cache failure mode).
            const assetsUrlPrefix = buildApiUrl(CACHE_KEYS.assets.list());
            void swrMutate(
                (key) =>
                    typeof key === 'string' &&
                    (key === assetsUrlPrefix || key.startsWith(`${assetsUrlPrefix}?`)),
                undefined,
                { revalidate: true },
            );
            setOpen(false);
            router.push(tenantHref(`/assets/${asset.id}`));
        },
    });

    // P3 — unsaved-changes guard. Identical pattern to NewVendorModal.
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
            title={labels.addAsset}
            description={t('modal.newDescription')}
            preventDefaultClose={form.submitting}
        >
            <Modal.Header
                title={labels.addAsset}
                description={t('modal.newDescription')}
            />
            <Modal.Form id="new-asset-form" onSubmit={handleSubmit}>
                <Modal.Body>
                    {form.error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="new-asset-error"
                            role="alert"
                        >
                            {form.error}
                        </div>
                    )}
                    <fieldset
                        disabled={form.submitting}
                        className="m-0 p-0 border-0 space-y-default"
                    >
                        <NewAssetFields form={form} labels={labels} tenantSlug={tenantSlug} />
                    </fieldset>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={close}
                        disabled={form.submitting}
                        id="new-asset-cancel-btn"
                    >
                        {labels.cancel}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={!form.canSubmit}
                        id="create-asset-submit"
                    >
                        {form.submitting ? t('modal.creating') : labels.createAsset}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
