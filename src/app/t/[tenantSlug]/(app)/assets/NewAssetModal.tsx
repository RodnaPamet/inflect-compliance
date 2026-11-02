'use client';

/**
 * NewAssetModal — modal-form follow-up (assets-create was missed by
 * the original P2 which scoped assets-EDIT only). Mirrors
 * `<NewVendorModal>` exactly: shared `<NewAssetFields>` + unsaved-
 * changes guard + `Modal.Form` pinned-footer shell.
 */
import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useSWRConfig } from 'swr';
import { useTenantHref, useTenantApiUrl } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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

    // P3 — unsaved-changes guard, as the task and audit forms ask it (#4963).
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
            {/* `warning`, not `danger`: unsaved input is recoverable by
                retyping, and "Discard" is the verb for unsaved state. */}
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
                    // Keep the form open with what was typed.
                    pendingClose.current = null;
                }}
            />
        </Modal>
    );
}
