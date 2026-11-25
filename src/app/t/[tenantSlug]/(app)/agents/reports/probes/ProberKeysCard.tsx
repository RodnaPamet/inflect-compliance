'use client';

/**
 * The keys this tenant trusts to sign PROBE reports (step 8b) — list, register
 * (`POST /admin/agents/prober-keys`) and revoke
 * (`DELETE /admin/agents/prober-keys/:id`), all under `admin.agent_registry`,
 * the key the server read this card under.
 *
 * A register of its own, never the scanner keys (owner decision, 2026-11-25):
 * each key belongs to a registered agent, the prober, and a report signed by
 * it is that agent's. The prober's own credential is a different thing: an API
 * key with the `admin:agent_probes_ingest` scope, which the intro names in
 * text.
 *
 * NO KEY IS A FINDING: with none registered, no probe report can be accepted,
 * and the card says so rather than rendering an empty table. A revoke is
 * confirmed: the row stays for the runs it signed, and the same key cannot be
 * registered again.
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
import type { ProberKeyRow, ProberKeysView } from '@/lib/agentic/probe-run-read-model';

import { RegisterSigningKeyModal } from '../keys/RegisterSigningKeyModal';

export function ProberKeysCard({ view }: { view: ProberKeysView }) {
    const t = useTranslations('agents');
    const tCommon = useTranslations('common');
    const apiUrl = useTenantApiUrl();
    const router = useRouter();
    const toast = useToast();

    const [registering, setRegistering] = useState(false);
    const [revoking, setRevoking] = useState<ProberKeyRow | null>(null);
    const [revokeError, setRevokeError] = useState<string | null>(null);

    const columns = useMemo(
        () =>
            createColumns<ProberKeyRow>([
                {
                    id: 'prober',
                    header: t('reports.probes.proberKeys.colProber'),
                    enableSorting: false,
                    cell: ({ row }) => (
                        <span className="text-sm text-content-emphasis">{row.original.agentName ?? row.original.agentId}</span>
                    ),
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
                                data-testid={`prober-key-revoke-${row.original.id}`}
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
            const res = await fetch(apiUrl(`/admin/agents/prober-keys/${revoking.id}`), { method: 'DELETE' });
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
        <Card data-testid="prober-keys" className="space-y-default">
            <div className="flex flex-wrap items-center justify-between gap-compact">
                <Heading level={2}>{t('reports.probes.proberKeys.heading')}</Heading>
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    icon={<Plus />}
                    onClick={() => setRegistering(true)}
                    data-testid="prober-key-register-button"
                >
                    {t('reports.probes.proberKeys.register')}
                </Button>
            </div>
            <p className="text-sm text-content-muted">{t('reports.probes.proberKeys.intro')}</p>
            {view.keys.rows.length === 0 ? (
                <InlineNotice variant="warning" data-testid="prober-keys-empty">
                    {t('reports.probes.proberKeys.empty')}
                </InlineNotice>
            ) : (
                <DataTable<ProberKeyRow>
                    data={[...view.keys.rows]}
                    columns={columns}
                    getRowId={(r) => r.id}
                    selectionEnabled={false}
                    data-testid="prober-keys-table"
                />
            )}
            {view.keys.truncated && (
                <InlineNotice variant="warning" icon={null} data-testid="prober-keys-truncated">
                    {t('reports.probes.keys.truncated', { count: view.keys.rows.length })}
                </InlineNotice>
            )}
            {registering && (
                <RegisterSigningKeyModal register="prober" candidates={view.candidates} onClose={() => setRegistering(false)} />
            )}
            <ConfirmDialog
                showModal={revoking !== null}
                setShowModal={(open) => {
                    const next = typeof open === 'function' ? open(revoking !== null) : open;
                    if (!next) setRevoking(null);
                }}
                tone="danger"
                confirmLabel={t('reports.probes.proberKeys.revokeConfirm')}
                cancelLabel={tCommon('cancel')}
                title={t('reports.probes.proberKeys.revokeTitle')}
                description={
                    <>
                        {t('reports.probes.proberKeys.revokeBody', {
                            prober: revoking ? (revoking.agentName ?? revoking.agentId) : '',
                        })}
                        {revokeError && (
                            <span role="alert" className="mt-2 block text-content-error" data-testid="prober-key-revoke-error">
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
