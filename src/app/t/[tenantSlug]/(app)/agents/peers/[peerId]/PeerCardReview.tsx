'use client';

/**
 * READ A PEER'S LIVE CARD, AND APPROVE IT AS THE PIN (#3807, the card for
 * step 2e's `/admin/agents/peers/:peerId/card` and `…/card/approve`).
 *
 * No trust on first use: a registered peer is refused until a person reads its
 * card and approves it, and again whenever the card changes. Both were API
 * calls. This card makes the same two and adds no authority — the register
 * key gates both, and an API key never approves a pin.
 *
 * WHAT IS APPROVED IS WHAT WAS SHOWN. The card's text is shown here, as text,
 * because a person cannot approve a hash of text they were not shown; it is
 * the peer's text, untrusted, and goes nowhere else — not into state that
 * outlives the page, not into a toast. The approval names the hash of the card
 * read here (`expectedCardHash`), and the server reads the card again and
 * refuses if it has moved, so a card that changed between reading and
 * approving is never pinned.
 *
 * Reading is on request, not on load: each read fetches another
 * organisation's URL and records the hash it saw.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/hooks';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { apiErrorMessage } from '@/lib/api-error';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

type Verdict =
    | { status: 'UNPINNED' }
    | { status: 'MATCH'; revision: number }
    | { status: 'CHANGED'; revision: number; moved: string[] };

interface CardRead {
    peerId: string;
    live: { readable: true; hashes: { cardHash: string }; card: unknown } | { readable: false; reason: string };
    verdict: Verdict | null;
    admission: { admitted: true } | { admitted: false; reason: string };
}

/**
 * The codes the card read and the admission check name, in words (#4902).
 * A code this page does not know reads as the generic sentence, never as the
 * code: a new one is a reason to add a sentence, not to show an identifier.
 */
const READ_REASONS = new Set([
    'SCHEME_REFUSED',
    'TIMEOUT',
    'EGRESS_REFUSED',
    'HTTP_ERROR',
    'TOO_LARGE',
    'NOT_JSON',
    'NOT_AN_AGENT_CARD',
    'ENDPOINT_NOT_HTTPS',
]);
const ADMISSION_REFUSALS = new Set([
    'PEER_NOT_ACTIVE',
    'PEER_OWNER_INACTIVE',
    'PEER_UNSCORED',
    'PEER_UNPINNED',
    'PEER_CARD_UNREADABLE',
    'PEER_CARD_CHANGED',
]);
const MOVED_PARTS = new Set(['TEXT', 'ENDPOINT', 'OTHER']);

const VERDICT_VARIANT: Readonly<Record<Verdict['status'], StatusBadgeVariant>> = {
    MATCH: 'success',
    CHANGED: 'error',
    UNPINNED: 'warning',
};

export function PeerCardReview({
    peerId,
    retired,
    canManage,
}: {
    peerId: string;
    retired: boolean;
    canManage: boolean;
}) {
    const t = useTranslations('agents');
    const apiUrl = useTenantApiUrl();
    const router = useRouter();
    const toast = useToast();

    const [read, setRead] = useState<CardRead | null>(null);
    const [reading, setReading] = useState(false);
    const [readError, setReadError] = useState<string | null>(null);
    const [approving, setApproving] = useState(false);
    const [approveError, setApproveError] = useState<string | null>(null);

    const readCard = async () => {
        setReading(true);
        setReadError(null);
        try {
            const res = await fetch(apiUrl(`/admin/agents/peers/${peerId}/card`));
            const body = await res.json().catch(() => null);
            if (!res.ok) {
                setReadError(apiErrorMessage(body, t('peers.cardReview.readFailed')));
                return;
            }
            setRead(body as CardRead);
        } catch {
            setReadError(t('peers.cardReview.readFailed'));
        } finally {
            setReading(false);
        }
    };

    const live = read?.live.readable ? read.live : null;

    const approve = async () => {
        if (!live) return;
        setApproveError(null);
        let message: string | null = null;
        try {
            const res = await fetch(apiUrl(`/admin/agents/peers/${peerId}/card/approve`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ expectedCardHash: live.hashes.cardHash }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                message = apiErrorMessage(body, t('peers.cardReview.approveFailed'));
            }
        } catch {
            message = t('peers.cardReview.approveFailed');
        }
        if (message !== null) {
            setApproveError(message);
            // Rejecting keeps the confirmation open over the server's sentence.
            throw new Error(message);
        }
        toast.success(t('peers.cardReview.approved'));
        setApproving(false);
        setRead(null);
        router.refresh();
    };

    const approvable = canManage && !retired && live !== null && read?.verdict?.status !== 'MATCH';

    return (
        <Card className="space-y-default" data-testid="peer-card-review">
            <Heading level={2}>{t('peers.cardReview.heading')}</Heading>
            <p className="text-sm text-content-muted">{t('peers.cardReview.intro')}</p>
            <div className="flex flex-wrap gap-compact">
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    loading={reading}
                    disabled={reading}
                    onClick={() => void readCard()}
                    data-testid="peer-card-read"
                >
                    {read ? t('peers.cardReview.readAgain') : t('peers.cardReview.read')}
                </Button>
                {approvable && (
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                            setApproveError(null);
                            setApproving(true);
                        }}
                        data-testid="peer-card-approve"
                    >
                        {t('peers.cardReview.approve')}
                    </Button>
                )}
            </div>
            {!canManage && <p className="text-xs text-content-muted">{t('peers.cardReview.readOnly')}</p>}

            {readError && (
                <InlineNotice variant="error" data-testid="peer-card-read-error">
                    {readError}
                </InlineNotice>
            )}

            {read && !read.live.readable && (
                <InlineNotice variant="warning" data-testid="peer-card-unreadable">
                    {t('peers.cardReview.unreadable', {
                        reason: t(`peers.cardReview.readReason.${READ_REASONS.has(read.live.reason) ? read.live.reason : 'UNKNOWN'}`),
                    })}
                </InlineNotice>
            )}

            {read && live && (
                <div className="space-y-compact" data-testid="peer-card-live">
                    <div className="flex flex-wrap items-center gap-compact text-sm">
                        <span className="text-content-muted">{t('peers.cardReview.liveHash')}</span>
                        <span className="font-mono text-xs break-all" data-testid="peer-card-live-hash">
                            {live.hashes.cardHash}
                        </span>
                        {read.verdict && (
                            <StatusBadge variant={VERDICT_VARIANT[read.verdict.status]} size="sm">
                                {t(`peers.cardReview.verdict.${read.verdict.status}`)}
                            </StatusBadge>
                        )}
                    </div>
                    {read.verdict?.status === 'CHANGED' && read.verdict.moved.length > 0 && (
                        <p className="text-xs text-content-muted">
                            {t('peers.cardReview.moved', {
                                parts: read.verdict.moved
                                    .map((m) => t(`peers.cardReview.movedPart.${MOVED_PARTS.has(m) ? m : 'OTHER'}`))
                                    .join(', '),
                            })}
                        </p>
                    )}
                    <p className="text-xs font-medium text-content-muted">{t('peers.cardReview.textHeading')}</p>
                    <pre
                        className="max-h-96 overflow-auto rounded-md border border-border-subtle bg-bg-muted p-3 text-xs whitespace-pre-wrap break-all"
                        data-testid="peer-card-text"
                    >
                        {JSON.stringify(live.card, null, 2)}
                    </pre>
                </div>
            )}

            {read && (
                <p className="text-sm" data-testid="peer-card-admission">
                    {read.admission.admitted
                        ? t('peers.cardReview.admitted')
                        : t('peers.cardReview.refused', {
                              reason: t(
                                  `peers.cardReview.refusal.${ADMISSION_REFUSALS.has(read.admission.reason) ? read.admission.reason : 'UNKNOWN'}`,
                              ),
                          })}
                </p>
            )}

            <ConfirmDialog
                showModal={approving && live !== null}
                setShowModal={(next) => {
                    const value = typeof next === 'function' ? next(approving) : next;
                    if (!value) setApproving(false);
                }}
                tone="warning"
                title={t('peers.cardReview.confirmTitle')}
                description={
                    <>
                        {t('peers.cardReview.confirmBody', { hash: live?.hashes.cardHash ?? '' })}
                        {approveError && (
                            <span role="alert" className="mt-2 block text-content-error" data-testid="peer-card-approve-error">
                                {approveError}
                            </span>
                        )}
                    </>
                }
                confirmLabel={t('peers.cardReview.confirmAction')}
                cancelLabel={t('peers.cardReview.cancel')}
                onConfirm={approve}
            />
        </Card>
    );
}
