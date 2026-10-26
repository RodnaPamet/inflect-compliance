'use client';

/**
 * Reject a submitted profile version, saying why (Step 1b, #4144).
 *
 * The reason is required: the author reads it on the version they wrote, and
 * the database refuses a rejection without one. It is sent to the server and
 * shown back only as text.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Modal } from '@/components/ui/modal';
import { Textarea } from '@/components/ui/textarea';

export function BehaviourRejectModal({
    version,
    maxChars,
    busy,
    error,
    onCancel,
    onReject,
}: {
    version: number;
    maxChars: number;
    busy: boolean;
    /** The server's refusal of the last attempt, shown beside the reason. */
    error: string | null;
    onCancel: () => void;
    onReject: (reason: string) => void;
}) {
    const t = useTranslations('agents.behaviour');
    const tCommon = useTranslations('common');
    const [reason, setReason] = useState('');
    const title = t('reject.title', { version });
    const canReject = !busy && reason.trim().length > 0;

    return (
        <Modal
            showModal
            setShowModal={(v) => {
                if (!v && !busy) onCancel();
            }}
            title={title}
            preventDefaultClose={busy}
        >
            <Modal.Header title={title} description={t('reject.description')} />
            <Modal.Form
                onSubmit={(e) => {
                    e.preventDefault();
                    if (canReject) onReject(reason);
                }}
            >
                <Modal.Body>
                    <FormField
                        label={t('reject.reason')}
                        description={t('reject.reasonHint')}
                        hint={t('editor.counter', { count: reason.length, max: maxChars })}
                        error={error ?? undefined}
                        required
                    >
                        <Textarea
                            id="behaviour-reject-reason"
                            rows={4}
                            maxLength={maxChars}
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            disabled={busy}
                        />
                    </FormField>
                </Modal.Body>
                <Modal.Footer>
                    <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
                        {tCommon('cancel')}
                    </Button>
                    <Button type="submit" variant="destructive" disabled={!canReject} data-testid="behaviour-reject-confirm">
                        {t('reject.confirm', { version })}
                    </Button>
                </Modal.Footer>
            </Modal.Form>
        </Modal>
    );
}
