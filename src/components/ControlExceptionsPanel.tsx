'use client';

/**
 * Epic G-5 — Control Exceptions Panel.
 *
 * Renders inside the control-detail page. Anchors the entire
 * exception workflow (request, approve, reject, renew, audit)
 * to the control the user is already looking at.
 *
 * Permission gating:
 *   - Anyone with read access can see the panel.
 *   - canWrite → Request / Renew buttons.
 *   - canAdmin → Approve / Reject buttons on REQUESTED rows.
 *
 * The panel always reflects the live state via React Query so an
 * approve from another tab refreshes the badges in this one.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import useSWR, { useSWRConfig } from 'swr';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { UserCombobox } from '@/components/ui/user-combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { formatDate, formatDateTime } from '@inflect/ui/lib/format-date';
import { Heading } from '@/components/ui/typography';

type Status = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

interface ExceptionSummary {
    id: string;
    controlId: string;
    status: Status;
    expiresAt: string | Date | null;
    approvedAt: string | Date | null;
    rejectedAt: string | Date | null;
    riskAcceptedByUserId: string;
    createdByUserId: string;
    createdAt: string | Date;
    renewedFromId: string | null;
    compensatingControlId: string | null;
    control: { id: string; name: string; code: string | null } | null;
    compensatingControl: { id: string; name: string; code: string | null } | null;
}

interface ControlOption {
    id: string;
    name: string;
    code?: string | null;
}

interface Props {
    tenantSlug: string;
    controlId: string;
    /// Caller-supplied list of available compensating controls. The
    /// detail page already has the control roster in scope; passing
    /// it down avoids a second fetch.
    compensatingControlChoices: readonly ControlOption[];
    /// User who would normally accept the risk by default — usually
    /// the control owner. The form lets the requester change it.
    defaultRiskAcceptedByUserId: string;
    /// Permission flags resolved server-side and threaded through.
    canWrite: boolean;
    canAdmin: boolean;
}

const STATUS_VARIANT: Record<Status, 'warning' | 'success' | 'error'> = {
    REQUESTED: 'warning',
    APPROVED: 'success',
    REJECTED: 'error',
    EXPIRED: 'warning',
};

export function ControlExceptionsPanel({
    tenantSlug,
    controlId,
    compensatingControlChoices,
    defaultRiskAcceptedByUserId,
    canWrite,
    canAdmin,
}: Props) {
    const { mutate: swrMutate } = useSWRConfig();
    const t = useTranslations('panels.exceptions');
    const tc = useTranslations('common');
    const apiBase = `/api/t/${tenantSlug}/controls/${controlId}/exceptions`;

    const exceptionsQuery = useSWR<{ rows: ExceptionSummary[] }>(
        apiBase,
        async (url: string) => {
            const res = await fetch(url);
            if (!res.ok) throw new Error('Failed to fetch exceptions');
            return res.json();
        },
    );

    const rows = exceptionsQuery.data?.rows ?? [];
    const activeException = rows.find((r) => r.status === 'APPROVED' || r.status === 'REQUESTED');

    const [requestOpen, setRequestOpen] = useState(false);
    const [approveTargetId, setApproveTargetId] = useState<string | null>(null);
    const [rejectTargetId, setRejectTargetId] = useState<string | null>(null);
    const [renewTargetId, setRenewTargetId] = useState<string | null>(null);

    const invalidate = () => {
        swrMutate(apiBase);
    };

    return (
        <section
            className="space-y-default"
            data-testid="control-exceptions-panel"
        >
            <header className="flex items-center justify-between">
                <div className="flex items-center gap-compact">
                    <Heading level={2}>
                        {t('title')}
                    </Heading>
                    <ExceptionHeaderBadge ex={activeException} />
                </div>
                {canWrite ? (
                    <Button
                        onClick={() => setRequestOpen(true)}
                        data-testid="control-exception-request-button"
                    >
                        {t('request')}
                    </Button>
                ) : null}
            </header>

            {rows.length === 0 ? (
                <p
                    className="text-sm text-content-muted"
                    data-testid="control-exceptions-empty"
                >
                    {t('emptyExceptions')}
                </p>
            ) : (
                <ul className="space-y-tight" data-testid="control-exceptions-list">
                    {rows.map((r) => (
                        <li
                            key={r.id}
                            className="rounded border border-border-subtle p-3"
                            data-testid={`control-exception-row-${r.id}`}
                        >
                            <div className="flex items-center justify-between gap-compact">
                                <div className="flex items-center gap-tight">
                                    <StatusBadge variant={STATUS_VARIANT[r.status]}>
                                        {r.status}
                                    </StatusBadge>
                                    <span className="text-sm text-content-muted">
                                        {r.expiresAt
                                            ? t('expires', { date: formatDate(r.expiresAt) })
                                            : t('expiryNotSet')}
                                    </span>
                                    {r.compensatingControl ? (
                                        <span className="text-xs text-content-muted">
                                            {t('compensating', { name: r.compensatingControl.name })}
                                        </span>
                                    ) : null}
                                </div>
                                <div className="flex gap-tight">
                                    {canAdmin && r.status === 'REQUESTED' ? (
                                        <>
                                            <Button
                                                variant="secondary"
                                                onClick={() => setApproveTargetId(r.id)}
                                                data-testid={`control-exception-approve-button-${r.id}`}
                                            >
                                                {tc('approve')}
                                            </Button>
                                            <Button
                                                variant="secondary"
                                                onClick={() => setRejectTargetId(r.id)}
                                                data-testid={`control-exception-reject-button-${r.id}`}
                                            >
                                                {tc('reject')}
                                            </Button>
                                        </>
                                    ) : null}
                                    {canWrite && (r.status === 'APPROVED' || r.status === 'EXPIRED') ? (
                                        <Button
                                            variant="secondary"
                                            onClick={() => setRenewTargetId(r.id)}
                                            data-testid={`control-exception-renew-button-${r.id}`}
                                        >
                                            {t('renew')}
                                        </Button>
                                    ) : null}
                                </div>
                            </div>
                            <p className="mt-2 text-xs text-content-muted">
                                {t('requested', { date: formatDateTime(r.createdAt) })}
                                {r.renewedFromId ? t('renewedFrom', { id: r.renewedFromId.slice(0, 8) }) : ''}
                            </p>
                        </li>
                    ))}
                </ul>
            )}

            {requestOpen ? (
                <RequestExceptionDialog
                    apiBase={apiBase}
                    tenantSlug={tenantSlug}
                    controlId={controlId}
                    compensatingControlChoices={compensatingControlChoices}
                    defaultRiskAcceptedByUserId={defaultRiskAcceptedByUserId}
                    onClose={() => setRequestOpen(false)}
                    onSuccess={() => {
                        setRequestOpen(false);
                        invalidate();
                    }}
                />
            ) : null}

            {approveTargetId ? (
                <ApproveDialog
                    apiBase={apiBase}
                    exceptionId={approveTargetId}
                    onClose={() => setApproveTargetId(null)}
                    onSuccess={() => {
                        setApproveTargetId(null);
                        invalidate();
                    }}
                />
            ) : null}

            {rejectTargetId ? (
                <RejectDialog
                    apiBase={apiBase}
                    exceptionId={rejectTargetId}
                    onClose={() => setRejectTargetId(null)}
                    onSuccess={() => {
                        setRejectTargetId(null);
                        invalidate();
                    }}
                />
            ) : null}

            {renewTargetId ? (
                <RenewDialog
                    apiBase={apiBase}
                    exceptionId={renewTargetId}
                    onClose={() => setRenewTargetId(null)}
                    onSuccess={() => {
                        setRenewTargetId(null);
                        invalidate();
                    }}
                />
            ) : null}
        </section>
    );
}

// ─── Header badge ────────────────────────────────────────────────────

/**
 * Public sub-component — surfaces an "Active exception" badge that
 * the control-detail header can render without the rest of the
 * panel. Returns null when no active exception exists.
 */
export function ControlExceptionHeaderBadge({
    tenantSlug,
    controlId,
}: {
    tenantSlug: string;
    controlId: string;
}) {
    const apiBase = `/api/t/${tenantSlug}/controls/${controlId}/exceptions`;
    const exceptionsQuery = useSWR<{ rows: ExceptionSummary[] }>(
        apiBase,
        async (url: string) => {
            const res = await fetch(url);
            if (!res.ok) throw new Error('Failed to fetch exceptions');
            return res.json();
        },
        { dedupingInterval: 30_000 },
    );
    const active = (exceptionsQuery.data?.rows ?? []).find(
        (r) => r.status === 'APPROVED' || r.status === 'REQUESTED',
    );
    return <ExceptionHeaderBadge ex={active} />;
}

function ExceptionHeaderBadge({ ex }: { ex?: ExceptionSummary }) {
    const t = useTranslations('panels.exceptions');
    if (!ex) return null;
    // R2-P5 — an in-force exception (APPROVED + not yet expired) reads
    // "Excepted until <date>"; a pending/other one keeps the status label.
    const inForce =
        ex.status === 'APPROVED' &&
        ex.expiresAt != null &&
        new Date(ex.expiresAt).getTime() > Date.now();
    return (
        <StatusBadge
            variant={STATUS_VARIANT[ex.status]}
            data-testid="control-exception-header-badge"
        >
            {inForce
                ? t('exceptedUntil', { date: formatDate(ex.expiresAt!) })
                : `${t('exceptionLabel')}: ${ex.status}`}
        </StatusBadge>
    );
}

// ─── Dialogs ─────────────────────────────────────────────────────────

function RequestExceptionDialog({
    apiBase,
    tenantSlug,
    controlId,
    compensatingControlChoices,
    defaultRiskAcceptedByUserId,
    onClose,
    onSuccess,
}: {
    apiBase: string;
    tenantSlug: string;
    controlId: string;
    compensatingControlChoices: readonly ControlOption[];
    defaultRiskAcceptedByUserId: string;
    onClose: () => void;
    onSuccess: () => void;
}) {
    const t = useTranslations('panels.exceptions');
    const tc = useTranslations('common');
    const [justification, setJustification] = useState('');
    const [compensatingControlId, setCompensatingControlId] = useState<string | null>(null);
    const [riskAcceptedByUserId, setRiskAcceptedByUserId] = useState(defaultRiskAcceptedByUserId);
    const [expiresAt, setExpiresAt] = useState<Date | null>(null);
    const [error, setError] = useState<string | null>(null);

    const compensatingChoiceOptions: ComboboxOption[] = useMemo(
        () =>
            compensatingControlChoices
                .filter((c) => c.id !== controlId)
                .map((c) => ({
                    value: c.id,
                    label: c.code ? `${c.code} — ${c.name}` : c.name,
                })),
        [compensatingControlChoices, controlId],
    );

    const [submitting, setSubmitting] = useState(false);
    const handleSubmit = async () => {
        setSubmitting(true);
        try {
            setError(null);
            const body = {
                controlId,
                justification,
                compensatingControlId: compensatingControlId || undefined,
                riskAcceptedByUserId,
                expiresAt: expiresAt ? expiresAt.toISOString() : undefined,
            };
            const res = await fetch(apiBase, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || 'Failed to request exception');
            }
            onSuccess();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setSubmitting(false);
        }
    };

    const valid = justification.trim().length > 0 && riskAcceptedByUserId.trim().length > 0;

    return (
        <Modal showModal setShowModal={(v) => !v && onClose()}>
            <Modal.Header title={t('requestHeader')} />
            <Modal.Body>
                <div className="space-y-default">
                    <FormField label={t('justification')} required>
                        <textarea
                            className="input"
                            rows={4}
                            value={justification}
                            onChange={(e) => setJustification(e.target.value)}
                            placeholder={t('justificationPlaceholder')}
                            data-testid="exception-form-justification"
                        />
                    </FormField>
                    <FormField label={t('riskAcceptedBy')} required>
                        <div data-testid="exception-form-risk-acceptor">
                            <UserCombobox
                                tenantSlug={tenantSlug}
                                selectedId={riskAcceptedByUserId || null}
                                onChange={(userId) =>
                                    setRiskAcceptedByUserId(userId ?? '')
                                }
                                placeholder={t('pickRiskAcceptor')}
                            />
                        </div>
                    </FormField>
                    <FormField label={t('compensatingControl')}>
                        <Combobox
                            options={compensatingChoiceOptions}
                            selected={
                                compensatingChoiceOptions.find(
                                    (o) => o.value === compensatingControlId,
                                ) ?? null
                            }
                            setSelected={(opt) =>
                                setCompensatingControlId(
                                    opt ? String(opt.value) : null,
                                )
                            }
                            placeholder={t('pickCompensating')}
                            data-testid="exception-form-compensating-control"
                        />
                    </FormField>
                    <FormField label={t('proposedExpiry')}>
                        <DatePicker
                            value={expiresAt}
                            onChange={setExpiresAt}
                            clearable
                        />
                    </FormField>
                    {error ? (
                        <p
                            className="text-sm text-content-error"
                            data-testid="exception-form-error"
                        >
                            {error}
                        </p>
                    ) : null}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Button variant="secondary" onClick={onClose}>
                    {tc('cancel')}
                </Button>
                <Button
                    onClick={() => void handleSubmit()}
                    disabled={!valid || submitting}
                    data-testid="exception-form-submit"
                >
                    {submitting ? t('submitting') : t('request')}
                </Button>
            </Modal.Footer>
        </Modal>
    );
}

function ApproveDialog({
    apiBase,
    exceptionId,
    onClose,
    onSuccess,
}: {
    apiBase: string;
    exceptionId: string;
    onClose: () => void;
    onSuccess: () => void;
}) {
    const t = useTranslations('panels.exceptions');
    const tc = useTranslations('common');
    const [expiresAt, setExpiresAt] = useState<Date | null>(null);
    const [note, setNote] = useState('');
    const [error, setError] = useState<string | null>(null);

    const [submitting, setSubmitting] = useState(false);
    const handleSubmit = async () => {
        setSubmitting(true);
        try {
            setError(null);
            if (!expiresAt) {
                throw new Error(t('expiryRequired'));
            }
            const res = await fetch(`${apiBase}/${exceptionId}/approve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    expiresAt: expiresAt.toISOString(),
                    note: note || undefined,
                }),
            });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || 'Failed to approve exception');
            }
            onSuccess();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal showModal setShowModal={(v) => !v && onClose()}>
            <Modal.Header title={t('approveHeader')} />
            <Modal.Body>
                <div className="space-y-default">
                    <FormField label={t('expiresOn')} required>
                        <DatePicker value={expiresAt} onChange={setExpiresAt} />
                    </FormField>
                    <FormField label={t('noteOptional')}>
                        <textarea
                            className="input"
                            rows={2}
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder={t('approveNotePlaceholder')}
                        />
                    </FormField>
                    {error ? (
                        <p
                            className="text-sm text-content-error"
                            data-testid="exception-approve-error"
                        >
                            {error}
                        </p>
                    ) : null}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Button variant="secondary" onClick={onClose}>
                    {tc('cancel')}
                </Button>
                <Button
                    onClick={() => void handleSubmit()}
                    disabled={!expiresAt || submitting}
                    data-testid="exception-approve-submit"
                >
                    {submitting ? t('approving') : tc('approve')}
                </Button>
            </Modal.Footer>
        </Modal>
    );
}

function RejectDialog({
    apiBase,
    exceptionId,
    onClose,
    onSuccess,
}: {
    apiBase: string;
    exceptionId: string;
    onClose: () => void;
    onSuccess: () => void;
}) {
    const t = useTranslations('panels.exceptions');
    const tc = useTranslations('common');
    const [reason, setReason] = useState('');
    const [error, setError] = useState<string | null>(null);

    const [submitting, setSubmitting] = useState(false);
    const handleSubmit = async () => {
        setSubmitting(true);
        try {
            setError(null);
            const res = await fetch(`${apiBase}/${exceptionId}/reject`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason }),
            });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || 'Failed to reject exception');
            }
            onSuccess();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal showModal setShowModal={(v) => !v && onClose()}>
            <Modal.Header title={t('rejectHeader')} />
            <Modal.Body>
                <FormField label={t('reason')} required>
                    <textarea
                        className="input"
                        rows={3}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder={t('rejectPlaceholder')}
                        data-testid="exception-reject-reason"
                    />
                </FormField>
                {error ? (
                    <p
                        className="mt-3 text-sm text-content-error"
                        data-testid="exception-reject-error"
                    >
                        {error}
                    </p>
                ) : null}
            </Modal.Body>
            <Modal.Footer>
                <Button variant="secondary" onClick={onClose}>
                    {tc('cancel')}
                </Button>
                <Button
                    onClick={() => void handleSubmit()}
                    disabled={!reason.trim() || submitting}
                    data-testid="exception-reject-submit"
                >
                    {submitting ? t('rejecting') : tc('reject')}
                </Button>
            </Modal.Footer>
        </Modal>
    );
}

function RenewDialog({
    apiBase,
    exceptionId,
    onClose,
    onSuccess,
}: {
    apiBase: string;
    exceptionId: string;
    onClose: () => void;
    onSuccess: () => void;
}) {
    const t = useTranslations('panels.exceptions');
    const tc = useTranslations('common');
    const [error, setError] = useState<string | null>(null);

    const [submitting, setSubmitting] = useState(false);
    const handleSubmit = async () => {
        setSubmitting(true);
        try {
            setError(null);
            const res = await fetch(`${apiBase}/${exceptionId}/renew`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || 'Failed to renew exception');
            }
            onSuccess();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal showModal setShowModal={(v) => !v && onClose()}>
            <Modal.Header title={t('renewHeader')} />
            <Modal.Body>
                <p className="text-sm text-content-muted">
                    {t('renewBodyPre')} <strong>{t('renewBodyState')}</strong> {t('renewBodySuffix')}
                </p>
                {error ? (
                    <p
                        className="mt-3 text-sm text-content-error"
                        data-testid="exception-renew-error"
                    >
                        {error}
                    </p>
                ) : null}
            </Modal.Body>
            <Modal.Footer>
                <Button variant="secondary" onClick={onClose}>
                    {tc('cancel')}
                </Button>
                <Button
                    onClick={() => void handleSubmit()}
                    disabled={submitting}
                    data-testid="exception-renew-submit"
                >
                    {submitting ? t('renewing') : t('renew')}
                </Button>
            </Modal.Footer>
        </Modal>
    );
}
