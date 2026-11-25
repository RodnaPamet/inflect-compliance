'use client';

/**
 * The keys that may AUTHORISE a probe engagement (step 8b) — list, register
 * (`POST /admin/probe-approver-keys`) and revoke
 * (`DELETE /admin/probe-approver-keys/:id`). Rendered only for an owner: every
 * verb takes `admin.tenant_lifecycle` and refuses anything but a person, and
 * the server read this card under that key (owner decision, 2026-11-25).
 *
 * An approver key signs the engagement scope a prober runs under; a report
 * whose scope it did not sign, or which arrives after it was revoked, is
 * refused. A key held in the prober register is refused here, and the
 * reverse: the party that runs probes never authorises them.
 *
 * NO KEY IS A FINDING: with none registered, every probe report is refused,
 * and the card says so rather than rendering an empty table.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus } from '@inflect/ui/components/ui/icons/glyphs';

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
import type { ApproverKeyRow, ApproverKeysView } from '@/lib/agentic/probe-run-read-model';

import { RegisterSigningKeyModal } from '../keys/RegisterSigningKeyModal';

export function ApproverKeysCard({ view }: { view: ApproverKeysView }) {
    const t = useTranslations('agents');
    const tCommon = useTranslations('common');
    const apiUrl = useTenantApiUrl();
    const router = useRouter();
    const toast = useToast();

    const [registering, setRegistering] = useState(false);
    const [revoking, setRevoking] = useState<ApproverKeyRow | null>(null);
    const [revokeError, setRevokeError] = useState<string | null>(null);

    const columns = useMemo(
        () =>
            createColumns<ApproverKeyRow>([
                {
                    id: 'label',
                    header: t('reports.probes.approverKeys.colLabel'),
                    enableSorting: false,
                    cell: ({ row }) => <span className="text-sm text-content-emphasis">{row.original.label}</span>,
                },
                {
                    id: 'fingerprint',
                    header: t('reports.probes.keys.colFingerprint'),
                    enableSorting: false,
                    cell: ({ row }) => (
                        <CopyText value={row.original.keyFingerprint} label={t('reports.probes.keys.copyFingerprint')} truncate>
                            <span className="font-mono text-xs">{row.original.keyFingerprint}</span>
                        </CopyText>
                    ),
                },
                {
                    id: 'added',
                    header: t('reports.probes.keys.colAdded'),
                    enableSorting: false,
                    cell: ({ row }) => <span className="text-xs">{formatDateTime(row.original.createdAt)}</span>,
                },
                {
                    id: 'status',
                    header: t('reports.probes.keys.colStatus'),
                    enableSorting: false,
                    cell: ({ row }) =>
                        row.original.revokedAt === null ? (
                            <StatusBadge variant="success" size="sm">{t('reports.probes.keys.statusActive')}</StatusBadge>
                        ) : (
                            <StatusBadge variant="neutral" size="sm">
                                {t('reports.probes.keys.statusRevoked', { date: formatDate(row.original.revokedAt) })}
                            </StatusBadge>
                        ),
                },
                {
                    id: 'actions',
                    header: t('reports.probes.keys.colActions'),
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
                                data-testid={`approver-key-revoke-${row.original.id}`}
                            >
                                {t('reports.probes.keys.revoke')}
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
            const res = await fetch(apiUrl(`/admin/probe-approver-keys/${revoking.id}`), { method: 'DELETE' });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                message = apiErrorMessage(body, t('reports.probes.keys.revokeFailed'));
            }
        } catch {
            message = t('reports.probes.keys.revokeFailed');
        }
        if (message !== null) {
            setRevokeError(message);
            toast.error(message);
            throw new Error(message);
        }
        toast.success(t('reports.probes.keys.revoked'));
        router.refresh();
    };

    return (
        <Card data-testid="approver-keys" className="space-y-default">
            <div className="flex flex-wrap items-center justify-between gap-compact">
                <Heading level={2}>{t('reports.probes.approverKeys.heading')}</Heading>
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    icon={<Plus />}
                    onClick={() => setRegistering(true)}
                    data-testid="approver-key-register-button"
                >
                    {t('reports.probes.approverKeys.register')}
                </Button>
            </div>
            <p className="text-sm text-content-muted">{t('reports.probes.approverKeys.intro')}</p>
            {view.rows.length === 0 ? (
                <InlineNotice variant="warning" data-testid="approver-keys-empty">
                    {t('reports.probes.approverKeys.empty')}
                </InlineNotice>
            ) : (
                <DataTable<ApproverKeyRow>
                    data={[...view.rows]}
                    columns={columns}
                    getRowId={(r) => r.id}
                    selectionEnabled={false}
                    data-testid="approver-keys-table"
                />
            )}
            {view.truncated && (
                <InlineNotice variant="warning" icon={null} data-testid="approver-keys-truncated">
                    {t('reports.probes.keys.truncated', { count: view.rows.length })}
                </InlineNotice>
            )}
            {registering && <RegisterSigningKeyModal register="approver" onClose={() => setRegistering(false)} />}
            <ConfirmDialog
                showModal={revoking !== null}
                setShowModal={(open) => {
                    const next = typeof open === 'function' ? open(revoking !== null) : open;
                    if (!next) setRevoking(null);
                }}
                tone="danger"
                confirmLabel={t('reports.probes.approverKeys.revokeConfirm')}
                cancelLabel={tCommon('cancel')}
                title={t('reports.probes.approverKeys.revokeTitle')}
                description={
                    <>
                        {t('reports.probes.approverKeys.revokeBody', { label: revoking?.label ?? '' })}
                        {revokeError && (
                            <span role="alert" className="mt-2 block text-content-error" data-testid="approver-key-revoke-error">
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
