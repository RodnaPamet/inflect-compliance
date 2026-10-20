'use client';

/**
 * WHO IS ACCOUNTABLE FOR THIS AGENT, and how that moves (#3807, the card for
 * step 2a's `/admin/agents/:agentId/ownership-transfer`).
 *
 * An agent's owner moves only when two people act: one proposes, and the
 * person named accepts. Both routes had no page, so a transfer — including the
 * one that lifts an owner-orphan pass's stop — was two console requests from
 * two sessions. This card makes the same three requests and adds no authority:
 * it renders only for holders of `admin.agent_ownership`, the routes' key, and
 * every refusal is the usecase's sentence.
 *
 * WHAT THE VIEWER IS OFFERED follows who they are on the open transfer, and the
 * server decides it again:
 *   - the person it names: Accept, through a confirmation that says what they
 *     take on, or Decline;
 *   - the person who started it: Withdraw. They are never offered Accept — the
 *     two-person rule refuses it first, from the stored row;
 *   - any other key holder: Cancel.
 * Declining, withdrawing and cancelling close a proposal that can be made
 * again, so they go through the undo window rather than a dialog.
 *
 * With no open transfer, a key holder proposes a new owner. The picker leaves
 * out the current owner and the viewer, whom the usecase refuses outright; it
 * cannot tell who holds the key, so a recipient who could not accept is
 * refused by the server in its own words.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FormField } from '@/components/ui/form-field';
import { useToast, useToastWithUndo } from '@/components/ui/hooks';
import { InlineNotice } from '@/components/ui/inline-notice';
import { SkeletonCard } from '@/components/ui/skeleton';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { apiErrorMessage } from '@/lib/api-error';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

import type { AgentTabProps } from './types';

interface Transfer {
    id: string;
    fromOwnerUserId: string;
    toOwnerUserId: string;
    initiatedByUserId: string;
    status: string;
    effectiveStatus: string;
    expiresAt: string;
    completedAt: string | null;
    cancelledAt: string | null;
    createdAt: string;
}

interface TransferState {
    agentId: string;
    ownerUserId: string;
    open: Transfer | null;
    history: Transfer[];
}

export interface OwnershipTransferCardProps extends AgentTabProps {
    /** The signed-in person, to say which side of an open transfer they are on. */
    viewerUserId: string;
    /** Active members, as the amend form lists them. */
    owners: { id: string; label: string }[];
    /** A retired agent's register entry is closed; the usecase refuses a proposal. */
    retired: boolean;
}

const STATUS_VARIANT: Readonly<Record<string, StatusBadgeVariant>> = {
    COMPLETED: 'success',
    CANCELLED: 'neutral',
    EXPIRED: 'neutral',
    PENDING: 'warning',
};

export function OwnershipTransferCard({
    agentId,
    refreshToken,
    onChanged,
    viewerUserId,
    owners,
    retired,
}: OwnershipTransferCardProps) {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const toast = useToast();
    const triggerUndo = useToastWithUndo();
    const path = `/admin/agents/${agentId}/ownership-transfer`;
    const { data, error, isLoading, mutate } = useTenantSWR<TransferState>(path);
    useEffect(() => {
        void mutate();
    }, [refreshToken, mutate]);

    const [recipient, setRecipient] = useState<ComboboxOption | null>(null);
    const [proposing, setProposing] = useState(false);
    const [proposeError, setProposeError] = useState<string | null>(null);
    const [accepting, setAccepting] = useState(false);
    const [acceptError, setAcceptError] = useState<string | null>(null);
    // The transfer whose close is waiting out the undo window.
    const [closing, setClosing] = useState<string | null>(null);

    const nameOf = useMemo(() => {
        const labels = new Map(owners.map((o) => [o.id, o.label]));
        return (userId: string) => labels.get(userId) ?? userId;
    }, [owners]);

    if (isLoading && !data) return <SkeletonCard lines={3} />;

    const open = data?.open && data.open.id !== closing ? data.open : null;
    const recipientOptions: ComboboxOption[] = owners
        .filter((o) => o.id !== data?.ownerUserId && o.id !== viewerUserId)
        .map((o) => ({ value: o.id, label: o.label }));

    const propose = async () => {
        if (!recipient) return;
        setProposing(true);
        setProposeError(null);
        try {
            const res = await fetch(apiUrl(path), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ toOwnerUserId: recipient.value }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                setProposeError(apiErrorMessage(body, t('agentDetail.ownership.proposeFailed')));
                return;
            }
            toast.success(t('agentDetail.ownership.proposed', { name: nameOf(recipient.value) }));
            setRecipient(null);
            await mutate();
        } catch {
            setProposeError(t('agentDetail.ownership.proposeFailed'));
        } finally {
            setProposing(false);
        }
    };

    const accept = async () => {
        if (!open) return;
        setAcceptError(null);
        let message: string | null = null;
        try {
            const res = await fetch(apiUrl(`${path}/complete`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transferId: open.id }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                message = apiErrorMessage(body, t('agentDetail.ownership.acceptFailed'));
            }
        } catch {
            message = t('agentDetail.ownership.acceptFailed');
        }
        if (message !== null) {
            setAcceptError(message);
            // Rejecting keeps the confirmation open over the server's sentence.
            throw new Error(message);
        }
        toast.success(t('agentDetail.ownership.accepted'));
        setAccepting(false);
        await mutate();
        // The owner shows in the header and on the overview.
        onChanged?.();
    };

    const close = (transfer: Transfer, kind: 'decline' | 'withdraw' | 'cancel') => {
        setClosing(transfer.id);
        triggerUndo({
            message: t(`agentDetail.ownership.closing.${kind}`),
            undoMessage: t('agentDetail.ownership.undo'),
            action: async () => {
                const res = await fetch(apiUrl(`${path}?transferId=${encodeURIComponent(transfer.id)}`), {
                    method: 'DELETE',
                });
                if (!res.ok) {
                    const body = await res.json().catch(() => null);
                    throw new Error(apiErrorMessage(body, t('agentDetail.ownership.closeFailed')));
                }
            },
            undoAction: () => setClosing(null),
            onCommit: () => {
                setClosing(null);
                void mutate();
            },
            onError: (err) => {
                setClosing(null);
                toast.error(err instanceof Error ? err.message : t('agentDetail.ownership.closeFailed'));
            },
        });
    };

    const history = (data?.history ?? []).filter((h) => h.effectiveStatus !== 'PENDING');

    return (
        <Card as="section" className="space-y-default" data-testid="agent-ownership">
            <Heading level={2}>{t('agentDetail.ownership.heading')}</Heading>
            <p className="text-sm text-content-muted">{t('agentDetail.ownership.intro')}</p>

            {error || !data ? (
                <InlineNotice variant="error">{t('agentDetail.ownership.loadError')}</InlineNotice>
            ) : (
                <>
                    <p className="text-sm" data-testid="agent-ownership-owner">
                        {t('agentDetail.ownership.currentOwner', { name: nameOf(data.ownerUserId) })}
                    </p>

                    {open ? (
                        <div className="space-y-compact" data-testid="agent-ownership-open">
                            <p className="text-sm">
                                {t('agentDetail.ownership.openLine', {
                                    to: nameOf(open.toOwnerUserId),
                                    by: nameOf(open.initiatedByUserId),
                                    until: formatDateTime(open.expiresAt),
                                })}
                            </p>
                            <div className="flex flex-wrap items-center gap-compact">
                                {open.toOwnerUserId === viewerUserId ? (
                                    <>
                                        <Button
                                            type="button"
                                            variant="secondary"
                                            size="sm"
                                            onClick={() => {
                                                setAcceptError(null);
                                                setAccepting(true);
                                            }}
                                            data-testid="agent-ownership-accept"
                                        >
                                            {t('agentDetail.ownership.accept')}
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => close(open, 'decline')}
                                            data-testid="agent-ownership-decline"
                                        >
                                            {t('agentDetail.ownership.decline')}
                                        </Button>
                                    </>
                                ) : (
                                    <>
                                        <span className="text-xs text-content-muted">
                                            {t('agentDetail.ownership.onlyRecipient', { to: nameOf(open.toOwnerUserId) })}
                                        </span>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            onClick={() =>
                                                close(open, open.initiatedByUserId === viewerUserId ? 'withdraw' : 'cancel')
                                            }
                                            data-testid="agent-ownership-close"
                                        >
                                            {open.initiatedByUserId === viewerUserId
                                                ? t('agentDetail.ownership.withdraw')
                                                : t('agentDetail.ownership.cancelTransfer')}
                                        </Button>
                                    </>
                                )}
                            </div>
                        </div>
                    ) : retired ? (
                        <InlineNotice variant="info" icon={null} data-testid="agent-ownership-retired">
                            {t('agentDetail.ownership.retired')}
                        </InlineNotice>
                    ) : (
                        <div className="space-y-compact" data-testid="agent-ownership-propose">
                            <FormField
                                label={t('agentDetail.ownership.recipientLabel')}
                                description={t('agentDetail.ownership.recipientHint')}
                            >
                                <Combobox
                                    id="agent-ownership-recipient"
                                    options={recipientOptions}
                                    selected={recipient}
                                    setSelected={(o) => {
                                        setProposeError(null);
                                        setRecipient(o);
                                    }}
                                    placeholder={t('agentDetail.ownership.recipientPlaceholder')}
                                    searchPlaceholder={t('agentDetail.ownership.recipientSearch')}
                                    matchTriggerWidth
                                    forceDropdown
                                    buttonProps={{ className: 'w-full max-w-md' }}
                                    caret
                                />
                            </FormField>
                            {proposeError && (
                                <InlineNotice variant="error" data-testid="agent-ownership-propose-error">
                                    {proposeError}
                                </InlineNotice>
                            )}
                            <Button
                                type="button"
                                // Secondary: a card action on the overview; step
                                // two, by somebody else, is what moves the owner.
                                variant="secondary"
                                size="sm"
                                disabled={!recipient || proposing}
                                loading={proposing}
                                onClick={() => void propose()}
                                data-testid="agent-ownership-propose-submit"
                            >
                                {t('agentDetail.ownership.propose')}
                            </Button>
                        </div>
                    )}

                    {history.length > 0 && (
                        <div className="space-y-tight" data-testid="agent-ownership-history">
                            <p className="text-xs font-medium text-content-muted">
                                {t('agentDetail.ownership.historyHeading')}
                            </p>
                            <ul className="space-y-tight text-xs text-content-muted">
                                {history.map((h) => (
                                    <li key={h.id} className="flex flex-wrap items-center gap-compact">
                                        <StatusBadge variant={STATUS_VARIANT[h.effectiveStatus] ?? 'neutral'} size="sm">
                                            {t(`agentDetail.ownership.status.${h.effectiveStatus}`)}
                                        </StatusBadge>
                                        <span>
                                            {t('agentDetail.ownership.historyLine', {
                                                from: nameOf(h.fromOwnerUserId),
                                                to: nameOf(h.toOwnerUserId),
                                                at: formatDateTime(h.completedAt ?? h.cancelledAt ?? h.createdAt),
                                            })}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </>
            )}

            <ConfirmDialog
                showModal={accepting && open !== null}
                setShowModal={(next) => {
                    const value = typeof next === 'function' ? next(accepting) : next;
                    if (!value) setAccepting(false);
                }}
                tone="warning"
                title={t('agentDetail.ownership.acceptTitle')}
                description={
                    <>
                        {t('agentDetail.ownership.acceptBody', {
                            from: open ? nameOf(open.fromOwnerUserId) : '',
                        })}
                        {acceptError && (
                            <span role="alert" className="mt-2 block text-content-error" data-testid="agent-ownership-accept-error">
                                {acceptError}
                            </span>
                        )}
                    </>
                }
                confirmLabel={t('agentDetail.ownership.acceptAction')}
                cancelLabel={t('agentDetail.ownership.cancel')}
                onConfirm={accept}
            />
        </Card>
    );
}
