'use client';

/**
 * The scanner keys this tenant trusts to sign harness reports (#3687) — list,
 * register (`POST /admin/agents/harness-scanner-keys`) and revoke
 * (`DELETE /admin/agents/harness-scanner-keys/:id`).
 *
 * The routes carry the page's own gate (`admin.agent_registry`), so every
 * viewer of the tab may manage keys. The SCANNER'S credential is a different
 * thing: an API key with the `admin:harness_ingest` scope, minted on the API
 * keys page, which is gated by another key. The intro names that scope in
 * text and does not link there, because a link to a page the viewer cannot
 * open is an action that always refuses.
 *
 * NO KEY IS A FINDING. With none registered, no harness report can be
 * accepted at all, and the card says so rather than rendering an empty table.
 *
 * A revoke is confirmed, and irreversible in a way worth saying: the row stays
 * for the scans it signed, and the same key cannot be registered again (the
 * fingerprint is unique per tenant). A credential revoke follows the API-key
 * precedent — a confirmation, not an undo window.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus } from '@inflect/ui/components/ui/icons/nucleo';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyText } from '@/components/ui/copy-text';
import { useToast } from '@/components/ui/hooks';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { DataTable, createColumns } from '@/components/ui/table';
import { Heading } from '@/components/ui/typography';
import { apiErrorMessage } from '@/lib/api-error';
import { formatDate, formatDateTime } from '@inflect/ui/lib/format-date';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import type { HarnessScannerKeyRow, HarnessScannerKeysView } from '@/lib/agentic/harness-read-model';

import { RegisterScannerKeyModal } from './RegisterScannerKeyModal';

export function ScannerKeysCard({ view }: { view: HarnessScannerKeysView }) {
    const t = useTranslations('agents');
    const tCommon = useTranslations('common');
    const apiUrl = useTenantApiUrl();
    const router = useRouter();
    const toast = useToast();

    const [registering, setRegistering] = useState(false);
    const [revoking, setRevoking] = useState<HarnessScannerKeyRow | null>(null);
    const [revokeError, setRevokeError] = useState<string | null>(null);

    const columns = useMemo(
        () =>
            createColumns<HarnessScannerKeyRow>([
                {
                    id: 'scanner',
                    header: t('harness.keys.colScanner'),
                    enableSorting: false,
                    cell: ({ row }) => (
                        <div className="flex flex-col items-start gap-tight">
                            <span className="text-sm text-content-emphasis">
                                {row.original.agentName ?? row.original.agentId}
                            </span>
                            {row.original.agentName === null && (
                                <span className="text-xs text-content-muted">{t('harness.keys.agentRemoved')}</span>
                            )}
                        </div>
                    ),
                },
                {
                    id: 'fingerprint',
                    header: t('harness.keys.colFingerprint'),
                    enableSorting: false,
                    cell: ({ row }) => (
                        <CopyText value={row.original.keyFingerprint} label={t('harness.keys.copyFingerprint')} truncate>
                            <span className="font-mono text-xs">{row.original.keyFingerprint}</span>
                        </CopyText>
                    ),
                },
                {
                    id: 'added',
                    header: t('harness.keys.colAdded'),
                    enableSorting: false,
                    cell: ({ row }) => <span className="text-xs">{formatDateTime(row.original.createdAt)}</span>,
                },
                {
                    id: 'status',
                    header: t('harness.keys.colStatus'),
                    enableSorting: false,
                    cell: ({ row }) =>
                        row.original.revokedAt === null ? (
                            <StatusBadge variant="success" size="sm" data-testid={`harness-key-status-${row.original.id}`}>
                                {t('harness.keys.statusActive')}
                            </StatusBadge>
                        ) : (
                            <StatusBadge variant="neutral" size="sm" data-testid={`harness-key-status-${row.original.id}`}>
                                {t('harness.keys.statusRevoked', { date: formatDate(row.original.revokedAt) })}
                            </StatusBadge>
                        ),
                },
                {
                    id: 'actions',
                    header: t('harness.keys.colActions'),
                    enableSorting: false,
                    cell: ({ row }) =>
                        row.original.revokedAt === null ? (
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                onClick={() => {
                                    setRevokeError(null);
                                    setRevoking(row.original);
                                }}
                                data-testid={`harness-key-revoke-${row.original.id}`}
                            >
                                {t('harness.keys.revoke')}
                            </Button>
                        ) : null,
                },
            ]),
        [t],
    );

    const revoke = async () => {
        if (!revoking) return;
        setRevokeError(null);
        let message: string | null = null;
        try {
            const res = await fetch(apiUrl(`/admin/agents/harness-scanner-keys/${revoking.id}`), { method: 'DELETE' });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                message = apiErrorMessage(body, t('harness.keys.revokeFailed'));
            }
        } catch {
            message = t('harness.keys.revokeFailed');
        }
        if (message !== null) {
            setRevokeError(message);
            toast.error(message);
            // Rejecting keeps the confirmation open over the server's sentence.
            throw new Error(message);
        }
        toast.success(t('harness.keys.revoked'));
        router.refresh();
    };

    return (
        <Card data-testid="harness-scanner-keys" className="space-y-default">
            <div className="flex flex-wrap items-center justify-between gap-compact">
                <Heading level={2}>{t('harness.keys.heading')}</Heading>
                {/* Secondary, not primary: a card action inside a tab, on a
                    page where the product-wide primary ceiling has no slot to
                    give. The dialog it opens carries the one primary — its
                    submit, which `modal-action-order` requires. */}
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    icon={<Plus />}
                    onClick={() => setRegistering(true)}
                    data-testid="harness-key-register-button"
                >
                    {t('harness.keys.register')}
                </Button>
            </div>
            <p className="text-sm text-content-muted">{t('harness.keys.intro')}</p>

            {view.keys.rows.length === 0 ? (
                <InlineNotice variant="warning" data-testid="harness-scanner-keys-empty">
                    {t('harness.keys.empty')}
                </InlineNotice>
            ) : (
                <DataTable<HarnessScannerKeyRow>
                    data={[...view.keys.rows]}
                    columns={columns}
                    getRowId={(r) => r.id}
                    selectionEnabled={false}
                    resourceName={(plural) => (plural ? t('harness.keys.resourceKeys') : t('harness.keys.resourceKey'))}
                    emptyState={t('harness.keys.empty')}
                    data-testid="harness-scanner-keys-table"
                />
            )}
            {view.keys.truncated && (
                <InlineNotice variant="warning" icon={null} data-testid="harness-scanner-keys-truncated">
                    {t('harness.keys.truncated', { count: view.keys.rows.length })}
                </InlineNotice>
            )}

            {registering && (
                <RegisterScannerKeyModal candidates={view.candidates} onClose={() => setRegistering(false)} />
            )}

            <ConfirmDialog
                showModal={revoking !== null}
                setShowModal={(open) => {
                    const next = typeof open === 'function' ? open(revoking !== null) : open;
                    if (!next) setRevoking(null);
                }}
                tone="danger"
                confirmLabel={t('harness.keys.revokeConfirm')}
                cancelLabel={tCommon('cancel')}
                title={t('harness.keys.revokeTitle')}
                description={
                    <>
                        {t('harness.keys.revokeBody', {
                            scanner: revoking ? (revoking.agentName ?? revoking.agentId) : '',
                        })}
                        {revokeError && (
                            <span
                                role="alert"
                                className="mt-2 block text-content-error"
                                data-testid="harness-key-revoke-error"
                            >
                                {revokeError}
                            </span>
                        )}
                    </>
                }
                onConfirm={revoke}
            />
        </Card>
    );
}
