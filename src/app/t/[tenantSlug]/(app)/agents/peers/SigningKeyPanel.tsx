'use client';

/**
 * THE TENANT'S OWN A2A SIGNING KEY, on the peers page (#3679; owner decision
 * 2026-10-19).
 *
 * Shows the public half only — the key in force, its id, and how many retired
 * keys are kept so older receipts still verify. The private seed never reaches
 * the browser: the read route does not select it.
 *
 * Generate and rotate are OWNER acts (`admin.tenant_lifecycle`, the key that
 * rotates the tenant's DEK). The button is not rendered for anyone else, and
 * the sentence saying who can is — a missing control with no reason reads as a
 * bug. The route refuses regardless; this only avoids offering a click that
 * would be refused.
 *
 * `warning`, not `danger`: a rotation destroys nothing — the old key is kept
 * and every receipt it signed still verifies — but every peer must be handed
 * the new public key, which is a consequence worth a confirmation.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyText } from '@/components/ui/copy-text';
import { useToast } from '@/components/ui/hooks';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { apiErrorMessage } from '@/lib/api-error';
import { formatDate } from '@inflect/ui/lib/format-date';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

export interface SigningKeyPublic {
    readonly id: string;
    readonly publicKey: string;
    readonly fingerprint: string;
    readonly createdAt: string;
    readonly retiredAt: string | null;
}

export interface SigningKeyView {
    readonly current: SigningKeyPublic | null;
    readonly retired: readonly SigningKeyPublic[];
    readonly canRotate: boolean;
}

export function SigningKeyPanel({ view }: { view: SigningKeyView }) {
    const t = useTranslations('agents');
    const apiUrl = useTenantApiUrl();
    const router = useRouter();
    const toast = useToast();
    const [confirming, setConfirming] = useState(false);

    const first = view.current === null;

    const rotate = async () => {
        let message: string | null = null;
        try {
            const res = await fetch(apiUrl('/admin/agents/a2a-signing-key'), { method: 'POST' });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                message = apiErrorMessage(body, t('peers.signingKey.failed'));
            }
        } catch {
            message = t('peers.signingKey.failed');
        }
        if (message !== null) {
            toast.error(message);
            // Rejecting keeps the confirmation open over the server's sentence.
            throw new Error(message);
        }
        toast.success(first ? t('peers.signingKey.generated') : t('peers.signingKey.rotated'));
        router.refresh();
    };

    return (
        <Card data-testid="peers-signing-key" className="space-y-default">
            <div className="flex flex-wrap items-center justify-between gap-compact">
                <Heading level={2}>{t('peers.signingKey.title')}</Heading>
                {view.canRotate && (
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => setConfirming(true)}
                        data-testid="peers-signing-key-rotate"
                    >
                        {first ? t('peers.signingKey.generate') : t('peers.signingKey.rotate')}
                    </Button>
                )}
            </div>
            <p className="text-sm text-content-muted">{t('peers.signingKey.description')}</p>

            {view.current === null ? (
                <InlineNotice variant="warning" data-testid="peers-signing-key-none">
                    {t('peers.signingKey.none')}
                </InlineNotice>
            ) : (
                <dl className="grid grid-cols-1 gap-default text-sm md:grid-cols-2" data-testid="peers-signing-key-current">
                    <div className="min-w-0 space-y-tight">
                        <dt className="text-content-muted">{t('peers.signingKey.publicKey')}</dt>
                        <dd>
                            <CopyText value={view.current.publicKey} label={t('peers.signingKey.copyPublicKey')} truncate>
                                <span className="font-mono text-xs" data-testid="peers-signing-key-public">
                                    {view.current.publicKey}
                                </span>
                            </CopyText>
                        </dd>
                    </div>
                    <div className="min-w-0 space-y-tight">
                        <dt className="text-content-muted">{t('peers.signingKey.fingerprint')}</dt>
                        <dd>
                            <CopyText value={view.current.fingerprint} label={t('peers.signingKey.copyFingerprint')} truncate>
                                <span className="font-mono text-xs" data-testid="peers-signing-key-fingerprint">
                                    {view.current.fingerprint}
                                </span>
                            </CopyText>
                        </dd>
                        <dd className="text-xs text-content-muted">
                            {t('peers.signingKey.createdAt', { date: formatDate(view.current.createdAt) })}
                        </dd>
                    </div>
                </dl>
            )}

            {view.retired.length > 0 && (
                <p className="text-xs text-content-muted" data-testid="peers-signing-key-retired">
                    {t('peers.signingKey.retiredKept', { count: view.retired.length })}
                </p>
            )}
            {!view.canRotate && (
                <p className="text-xs text-content-muted" data-testid="peers-signing-key-owner-only">
                    {t('peers.signingKey.ownerOnly')}
                </p>
            )}

            <ConfirmDialog
                showModal={confirming}
                setShowModal={setConfirming}
                tone="warning"
                title={first ? t('peers.signingKey.generateTitle') : t('peers.signingKey.rotateTitle')}
                description={first ? t('peers.signingKey.generateDescription') : t('peers.signingKey.rotateDescription')}
                confirmLabel={first ? t('peers.signingKey.generate') : t('peers.signingKey.rotate')}
                onConfirm={rotate}
            />
        </Card>
    );
}
