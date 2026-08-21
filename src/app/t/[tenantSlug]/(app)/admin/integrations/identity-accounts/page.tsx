'use client';

/**
 * P1 — synced-identity roster. Gives ConnectedIdentityAccount a browse surface
 * (like Personnel / Devices) so an Okta / Google Workspace directory sync
 * produces something visible, and a CONNECTED_APP access review can be
 * pre-checked instead of throwing "zero subjects" on empty.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDate } from '@/lib/format-date';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { DataTable, createColumns } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/textarea';

interface AccountRow {
    id: string;
    provider: string;
    email: string | null;
    displayName: string | null;
    status: string;
    isAdmin: boolean;
    mfaEnrolled: boolean;
    lastActiveAt: string | null;
    syncedAt: string | null;
    isProtected: boolean;
    protectionReason: string | null;
}

export default function IdentityAccountsPage() {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const [rows, setRows] = useState<AccountRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    // The account awaiting a reason. Protecting REQUIRES one — the usecase
    // refuses without it — because the value of this list a year from now is
    // that every entry says why it is there.
    const [protecting, setProtecting] = useState<AccountRow | null>(null);
    const [reason, setReason] = useState('');
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState(false);

    const load = useCallback(async () => {
        setError(false);
        try {
            const res = await fetch(apiUrl('/admin/integrations/identity-accounts'));
            if (!res.ok) { setError(true); return; }
            setRows((await res.json()).accounts ?? []);
        } catch {
            setError(true);
        } finally {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setLoading(false);
        }
    }, [apiUrl]);
    useEffect(() => { void load(); }, [load]);

    const setProtection = useCallback(async (account: AccountRow, isProtected: boolean, why: string | null) => {
        setSaving(true);
        setSaveError(false);
        try {
            const res = await fetch(apiUrl(`/admin/identity-account-protection/${account.id}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isProtected, reason: why }),
            });
            if (!res.ok) { setSaveError(true); return; }
            setProtecting(null);
            setReason('');
            // Refetch rather than patch in place: the server owns protectedAt and
            // protectedByUserId, and a row assembled here would drift from it.
            await load();
        } catch {
            setSaveError(true);
        } finally {
            setSaving(false);
        }
    }, [apiUrl, load]);

    const cols = createColumns<AccountRow>([
        { accessorKey: 'provider', header: t('integrations.colProvider'), cell: ({ getValue }) => <StatusBadge variant="info">{getValue()}</StatusBadge> },
        { accessorKey: 'email', header: t('identityAccounts.colEmail'), cell: ({ row }) => <span className="font-medium">{row.original.email ?? row.original.displayName ?? '—'}</span> },
        { id: 'name', accessorKey: 'displayName', header: t('identityAccounts.colName'), cell: ({ getValue }) => <span className="text-content-muted">{String(getValue() ?? '—')}</span> },
        { id: 'status', accessorKey: 'status', header: t('integrations.colStatus'), cell: ({ row }) => <StatusBadge variant={row.original.status === 'ACTIVE' ? 'success' : 'neutral'}>{row.original.status}</StatusBadge> },
        { id: 'admin', accessorKey: 'isAdmin', header: t('identityAccounts.colAdmin'), cell: ({ row }) => row.original.isAdmin ? <StatusBadge variant="warning">{t('identityAccounts.admin')}</StatusBadge> : <span className="text-content-subtle">—</span> },
        {
            id: 'protected',
            accessorKey: 'isProtected',
            header: t('identityAccounts.colProtected'),
            // Plain text and a Button rather than a StatusBadge. This page is at
            // the badge-density cap of 5 and a sixth would trip the ratchet — but
            // the better reason is that this is an ACTION column, and a badge
            // that cannot be clicked next to a button that can reads as two
            // controls where there is one.
            cell: ({ row }) => (
                <div className="flex items-center gap-tight">
                    {row.original.isProtected && (
                        <span className="text-sm text-content-default" title={row.original.protectionReason ?? undefined}>
                            {t('identityAccounts.protected')}
                        </span>
                    )}
                    <Button
                        variant="secondary"
                        size="sm"
                        disabled={saving}
                        onClick={() => {
                            if (row.original.isProtected) {
                                // Releasing needs no reason — see the usecase.
                                void setProtection(row.original, false, null);
                            } else {
                                setSaveError(false);
                                setReason('');
                                setProtecting(row.original);
                            }
                        }}
                    >
                        {row.original.isProtected ? t('identityAccounts.release') : t('identityAccounts.protect')}
                    </Button>
                </div>
            ),
        },
        { id: 'mfa', accessorKey: 'mfaEnrolled', header: t('identityAccounts.colMfa'), cell: ({ row }) => row.original.mfaEnrolled ? <StatusBadge variant="success">{t('identityAccounts.mfaOn')}</StatusBadge> : <StatusBadge variant="error">{t('identityAccounts.mfaOff')}</StatusBadge> },
        { id: 'synced', accessorKey: 'syncedAt', header: t('identityAccounts.colSynced'), cell: ({ row }) => <span className="text-content-muted tabular-nums">{row.original.syncedAt ? formatDate(row.original.syncedAt) : '—'}</span> },
    ]);

    return (
        <div className="space-y-section">
            <BackAffordance />
            <PageBreadcrumbs items={[{ label: t('integrations.title'), href: tenantHref('/admin/integrations') }, { label: t('identityAccounts.breadcrumb') }]} />
            <Heading level={1}>{t('identityAccounts.title')}</Heading>
            <p className="text-sm text-content-muted">{t('identityAccounts.intro')}</p>

            <Card className="space-y-default p-6">
                {error ? (
                    <InlineNotice variant="error">{t('identityAccounts.loadError')}</InlineNotice>
                ) : loading ? (
                    <p className="text-sm text-content-subtle">{t('integrations.fetching')}</p>
                ) : rows.length === 0 ? (
                    <p className="text-sm text-content-muted">{t('identityAccounts.empty')}</p>
                ) : (
                    <DataTable data={rows} columns={cols} getRowId={(r) => r.id} emptyState={t('identityAccounts.empty')} />
                )}
            {protecting && (
                <Modal showModal setShowModal={(v) => { if (!v && !saving) setProtecting(null); }} size="md" preventDefaultClose={saving}>
                    <Modal.Header
                        title={t('identityAccounts.protect')}
                        description={t('identityAccounts.protectPrompt')}
                    />
                    <Modal.Body>
                        {saveError && <InlineNotice variant="error">{t('identityAccounts.protectError')}</InlineNotice>}
                        {/* The PROMPT is the modal description; the field label is
                            just "Reason". Rendering the same sentence twice made
                            the control ambiguous to a screen reader and to any
                            query that looks it up by name. */}
                        <FormField label={t('identityAccounts.reasonLabel')} required>
                            <Textarea
                                id="protection-reason"
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                rows={3}
                                className="w-full"
                            />
                        </FormField>
                    </Modal.Body>
                    <Modal.Footer>
                        {/* Cancel, not "Release" — reusing the row action's key here
                            put the word for the OPPOSITE operation on the button
                            that abandons this one. */}
                        <Button type="button" variant="secondary" onClick={() => setProtecting(null)} disabled={saving}>
                            {t('identityAccounts.cancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="primary"
                            disabled={saving || reason.trim().length === 0}
                            onClick={() => void setProtection(protecting, true, reason.trim())}
                        >
                            {t('identityAccounts.protect')}
                        </Button>
                    </Modal.Footer>
                </Modal>
            )}
            </Card>
        </div>
    );
}
