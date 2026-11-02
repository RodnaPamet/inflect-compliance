"use client";

/**
 * Lifecycle — delete trigger + typed-confirmation modal for a process
 * map.
 *
 * Lives in its own file so `CanvasDocumentBar` stays a pure,
 * state-free render (the R32-PR10 decomposition ratchet forbids
 * `useState`/`useEffect`/`useRef` in the bar). This control owns the
 * modal open-state, the typed-confirmation text, and the in-flight /
 * error state. The destructive commit lives upstream (`onDelete`) and
 * throws on failure so the error surfaces inline without dismissing the
 * modal.
 *
 * Deleting a process map is a top-level entity deletion, so the
 * typed-confirmation modal is the sanctioned pattern — NOT the
 * undo-toast, whose 5-second window is too short for a cascading map.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import { InlineNotice } from "@/components/ui/inline-notice";
import { extractMutationError } from "@/lib/mutations";

export interface CanvasMapDeleteControlProps {
    /** Name of the active map — the value the user must type to confirm. */
    mapName: string;
    /** Destructive commit. Throws on failure. */
    onDelete: () => void | Promise<void>;
    disabled: boolean;
    /** `automation.documentBar` translator, threaded from the bar. */
    t: ReturnType<typeof useTranslations>;
}

export function CanvasMapDeleteControl({
    mapName,
    onDelete,
    disabled,
    t,
}: CanvasMapDeleteControlProps) {
    const [open, setOpen] = useState(false);
    const [confirmText, setConfirmText] = useState("");
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    const close = () => {
        setOpen(false);
        setConfirmText("");
        setDeleting(false);
        setDeleteError(null);
    };

    const confirmDelete = async () => {
        setDeleting(true);
        setDeleteError(null);
        try {
            await onDelete();
            close();
        } catch (err) {
            // The server's reason, or the dialog's own sentence (#4987).
            setDeleteError(extractMutationError(err, t("deleteFailed")));
            setDeleting(false);
        }
    };

    return (
        <>
            <Button
                size="sm"
                variant="ghost"
                onClick={() => setOpen(true)}
                disabled={disabled}
                data-testid="delete-process-btn"
            >
                {t("delete")}
            </Button>
            <Modal
                showModal={open}
                setShowModal={(o) => (o ? setOpen(true) : close())}
            >
                <Modal.Header title={t("deleteTitle")} />
                <Modal.Body>
                    <div
                        className="space-y-default"
                        data-testid="process-delete-modal"
                    >
                        <p className="text-sm text-content-default">
                            {t.rich("deleteBody", {
                                name: mapName,
                                b: (chunks) => (
                                    <span className="font-medium text-content-emphasis">
                                        {chunks}
                                    </span>
                                ),
                            })}
                        </p>
                        <FormField
                            label={t("deleteTypeToConfirm", { name: mapName })}
                            required
                        >
                            <Input
                                value={confirmText}
                                onChange={(e) => setConfirmText(e.target.value)}
                                autoComplete="off"
                                autoFocus
                                placeholder={mapName}
                                data-testid="process-delete-confirm-input"
                            />
                        </FormField>
                        {deleteError && (
                            <InlineNotice variant="error" icon={null}>
                                {deleteError}
                            </InlineNotice>
                        )}
                    </div>
                </Modal.Body>
                <Modal.Footer>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={close}
                        text={t("cancel")}
                    />
                    <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        loading={deleting}
                        disabled={deleting || confirmText.trim() !== mapName}
                        onClick={confirmDelete}
                        data-testid="process-delete-confirm"
                        text={t("deleteConfirm")}
                    />
                </Modal.Footer>
            </Modal>
        </>
    );
}
