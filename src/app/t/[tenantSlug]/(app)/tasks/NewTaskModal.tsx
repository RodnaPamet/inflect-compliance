'use client';

/**
 * NewTaskModal — modal-form P2 execution.
 *
 * Mounts the P1-extracted `useNewTaskForm` hook + `<NewTaskFields>`
 * markup inside `<Modal>`. The hook owns the pending-links staging
 * buffer + the per-type validation (`AUDIT_FINDING` / `CONTROL_GAP`
 * requires a control or link); the modal just chrome's it.
 *
 * The legacy `/tasks/new` route is now a redirect → `/tasks?create=1`;
 * the list page (TasksClient) auto-opens this modal.
 */
import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTenantHref, useTenantContext } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useNewTaskForm, type PendingLink } from './_form/useNewTaskForm';
import { NewTaskFields } from './_form/NewTaskFields';

export interface NewTaskModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    /**
     * PR-C — optional pre-fill for the `dueAt` field. The calendar
     * page double-click flow seeds this with the clicked day's YMD.
     * When omitted the modal opens in its canonical empty state.
     */
    initialDueAt?: string;
    /**
     * PR-C — optional override for the post-create destination. The
     * default behaviour pushes the user to the new task's detail
     * page; the calendar page passes a no-op so the calendar view
     * stays in place after the task lands.
     */
    onCreated?: () => void;
    /**
     * Preset entity links staged on open. The control / asset / risk
     * detail surfaces seed this with their own entity so the task is
     * linked back (and shows in their tasks panel) on create.
     */
    initialPendingLinks?: PendingLink[];
}

export function NewTaskModal({
    open,
    setOpen,
    initialDueAt,
    onCreated,
    initialPendingLinks,
}: NewTaskModalProps) {
    const t = useTranslations('tasks');
    const tenantHref = useTenantHref();
    const { tenantSlug } = useTenantContext();
    const router = useRouter();

    const form = useNewTaskForm({
        onSuccess: (task) => {
            setOpen(false);
            if (onCreated) {
                onCreated();
            } else {
                router.push(tenantHref(`/tasks/${task.id}`));
            }
        },
        initialDueAt,
        initialPendingLinks,
    });

    // P3 — unsaved-changes guard.
    //
    // The confirmation used to be a blocking `window.confirm`, which
    // renders as a browser-chrome dialog: unstyled, untranslatable
    // beyond its message string, and unreachable from tests. It now
    // routes through the same <ConfirmDialog> the rest of the app uses
    // for destructive choices. Because that dialog is async, the close
    // request is PARKED (`pendingClose`) until the user answers, rather
    // than resolved inline.
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
            title={t('new.modalTitle')}
            description={t('new.modalDesc')}
            preventDefaultClose={form.submitting}
        >
            <Modal.Header
                title={t('new.modalTitle')}
                description={t('new.modalDesc')}
            />
            <Modal.Form id="new-task-form" onSubmit={handleSubmit}>
                <Modal.Body>
                    {form.error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="new-task-error"
                            role="alert"
                        >
                            {form.error}
                        </div>
                    )}
                    <fieldset
                        disabled={form.submitting}
                        className="m-0 p-0 border-0 space-y-default"
                    >
                        <NewTaskFields form={form} tenantSlug={tenantSlug} />
                    </fieldset>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={close}
                        disabled={form.submitting}
                        id="new-task-cancel-btn"
                    >
                        {t('new.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={!form.canSubmit}
                        id="create-task-btn"
                    >
                        {form.submitting ? t('new.creating') : t('new.create')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
            {/* Discard-changes guard. `tone="warning"` not "danger":
                abandoning an unsaved draft is reversible-by-retyping, not
                a destructive write. "Discard draft" is the canonical
                destructive verb for unsaved state. */}
            <ConfirmDialog
                showModal={confirmDiscardOpen}
                setShowModal={setConfirmDiscardOpen}
                tone="warning"
                title={t('new.discardTitle')}
                description={t('new.discardConfirm')}
                confirmLabel={t('new.discardConfirmLabel')}
                cancelLabel={t('new.discardCancelLabel')}
                onConfirm={() => {
                    const next = pendingClose.current ?? false;
                    pendingClose.current = null;
                    setOpen(next);
                }}
                onCancel={() => {
                    // Keep the modal open with the draft intact.
                    pendingClose.current = null;
                }}
            />
        </Modal>
    );
}
