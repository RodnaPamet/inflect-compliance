'use client';

/* TODO(swr-migration): fetch-on-mount + setState, matching the parent
 * integrations page. Migrate together to useTenantSWR. */

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { Combobox } from '@/components/ui/combobox';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { useOffersAdminApiWrite } from '@/lib/auth/use-offers-admin-api-write';
import { apiErrorMessage } from '@/lib/api-error';
import Link from 'next/link';
import { useToastWithUndo } from '@/components/ui/hooks';
import { useTranslations } from 'next-intl';

interface SpConnection {
    id: string;
    name: string;
    isEnabled: boolean;
    configJson: { allowedSiteIds?: string[] } | null;
    lastTestedAt: string | null;
    lastTestStatus: string | null;
}
interface SpSite {
    id: string;
    displayName?: string;
    webUrl?: string;
}

/**
 * SP-1 — SharePoint connection card on Admin → Integrations.
 * Connect (delegated consent), test, choose allowed sites, disconnect.
 */
export function SharePointCard() {
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const searchParams = useSearchParams();
    const triggerUndoToast = useToastWithUndo();
    const t = useTranslations('admin');
    // Every SharePoint call passes the edge, `admin.manage` and the service's
    // `assertCanAdmin`; the card offers its controls only where all three would
    // let the request through (#4466 finding 9).
    const canConfigure = useOffersAdminApiWrite({ key: 'admin.manage', floor: 'canAdmin' });

    const [connections, setConnections] = useState<SpConnection[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [testResult, setTestResult] = useState<Record<string, string>>({});
    const [sitesFor, setSitesFor] = useState<string | null>(null);
    const [sites, setSites] = useState<SpSite[]>([]);
    const [selectedSites, setSelectedSites] = useState<string[]>([]);

    const spStatus = searchParams.get('sp');

    const load = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/admin/integrations/sharepoint'));
            if (res.ok) setConnections(await res.json());
        } catch {
            /* read-only load */
        }
    }, [apiUrl]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { void load(); }, [load]);

    const connect = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/admin/integrations/sharepoint/connect'), { method: 'POST' });
            if (!res.ok) {
                setError(t('sharepoint.consentError'));
                return;
            }
            const { authorizeUrl } = await res.json();
            window.location.href = authorizeUrl; // hand off to Microsoft consent
        } catch {
            setError(t('sharepoint.consentError'));
        } finally {
            setBusy(false);
        }
    }, [apiUrl, t]);

    const test = useCallback(
        async (id: string) => {
            setTestResult((r) => ({ ...r, [id]: t('sharepoint.testing') }));
            try {
                const res = await fetch(apiUrl('/admin/integrations/sharepoint/test'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ connectionId: id }),
                });
                const data = await res.json().catch(() => null);
                // A refusal carries the envelope `{ error: { message } }`, not
                // the `{ ok, message }` of a test that ran.
                const text = res.ok
                    ? data?.message ?? (data?.ok ? t('sharepoint.ok') : t('sharepoint.failed'))
                    : apiErrorMessage(data, t('sharepoint.testFailed'));
                setTestResult((r) => ({ ...r, [id]: text }));
                void load();
            } catch {
                setTestResult((r) => ({ ...r, [id]: t('sharepoint.testFailed') }));
            }
        },
        [apiUrl, load, t],
    );

    /**
     * A site list that cannot be read closes the picker and says why (#4466).
     * It used to open anyway, empty — which reads as "this connection reaches
     * no sites" — and Save sites on that picker would then store an empty list.
     */
    const openSites = useCallback(
        async (conn: SpConnection) => {
            setError(null);
            setSites([]);
            setSitesFor(conn.id);
            setSelectedSites(conn.configJson?.allowedSiteIds ?? []);
            try {
                const res = await fetch(apiUrl(`/admin/integrations/sharepoint/sites?connectionId=${conn.id}`));
                const data = await res.json().catch(() => null);
                if (!res.ok) {
                    setSitesFor(null);
                    setError(apiErrorMessage(data, t('sharepoint.sitesLoadFailed')));
                    return;
                }
                setSites(Array.isArray(data) ? data : []);
            } catch {
                setSitesFor(null);
                setError(t('sharepoint.sitesLoadFailed'));
            }
        },
        [apiUrl, t],
    );

    /**
     * The picker closes only when the save landed (#4466). It used to close on
     * any answer, so a refused save looked exactly like a successful one.
     */
    const saveSites = useCallback(
        async (id: string) => {
            setBusy(true);
            setError(null);
            try {
                const res = await fetch(apiUrl(`/admin/integrations/sharepoint/sites?connectionId=${id}`), {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ siteIds: selectedSites }),
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => null);
                    setError(apiErrorMessage(data, t('sharepoint.saveSitesFailed')));
                    return;
                }
                setSitesFor(null);
                void load();
            } catch {
                setError(t('sharepoint.saveSitesFailed'));
            } finally {
                setBusy(false);
            }
        },
        [apiUrl, selectedSites, load, t],
    );

    const disconnect = useCallback(
        (conn: SpConnection) => {
            setConnections((cs) => cs.filter((c) => c.id !== conn.id)); // optimistic
            triggerUndoToast({
                message: t('sharepoint.disconnectedToast', { name: conn.name }),
                undoMessage: t('sharepoint.undo'),
                action: async () => {
                    const res = await fetch(apiUrl(`/admin/integrations/sharepoint?connectionId=${conn.id}`), {
                        method: 'DELETE',
                    });
                    if (!res.ok && res.status !== 404) throw new Error(`Disconnect failed (${res.status})`);
                },
                undoAction: () => load(),
                onError: () => {
                    setError(t('sharepoint.disconnectFailed'));
                    void load();
                },
            });
        },
        [apiUrl, triggerUndoToast, load, t],
    );

    const siteOptions = sites.map((s) => ({ value: s.id, label: s.displayName ?? s.webUrl ?? s.id }));

    return (
        <Card className="space-y-default p-6">
            <div className="flex items-center justify-between">
                <Heading level={2}>{t('sharepoint.title')}</Heading>
                <div className="flex items-center gap-default">
                    {connections.length > 0 && (
                        <Link href={tenantHref('/admin/integrations/sharepoint-health')} className="text-sm text-content-link">
                            {t('sharepoint.syncHealth')}
                        </Link>
                    )}
                    {canConfigure && connections.length === 0 && (
                        <Button variant="primary" onClick={connect} disabled={busy}>
                            {busy ? t('sharepoint.connecting') : t('sharepoint.connect')}
                        </Button>
                    )}
                </div>
            </div>
            <p className="text-sm text-content-muted">
                {t('sharepoint.description')}
            </p>

            {spStatus === 'connected' && <InlineNotice variant="success">{t('sharepoint.connected')}</InlineNotice>}
            {spStatus === 'declined' && <InlineNotice variant="warning">{t('sharepoint.declined')}</InlineNotice>}
            {spStatus === 'error' && <InlineNotice variant="error">{t('sharepoint.connectionFailed')}</InlineNotice>}
            {error && <InlineNotice variant="error">{error}</InlineNotice>}

            {connections.map((conn) => (
                <div key={conn.id} className="rounded-md border border-border-subtle p-4 space-y-default" data-testid={`sp-connection-${conn.id}`}>
                    <div className="flex items-center gap-default">
                        <span className="font-medium text-content-default">{conn.name}</span>
                        {/* A DISABLED connection read "Connected": the badge looked
                            only at the last test (#4466). The service refuses a
                            disabled connection for test, sites and every read. */}
                        <StatusBadge variant={!conn.isEnabled || conn.lastTestStatus === 'error' ? 'error' : 'success'}>
                            {!conn.isEnabled
                                ? t('sharepoint.statusDisabled')
                                : conn.lastTestStatus === 'error' ? t('sharepoint.statusError') : t('sharepoint.statusConnected')}
                        </StatusBadge>
                        <span className="text-xs text-content-muted">
                            {t('sharepoint.sitesAllowed', { count: conn.configJson?.allowedSiteIds?.length ?? 0 })}
                        </span>
                        {canConfigure && (
                            <div className="ml-auto flex gap-tight">
                                {/* Test and Sites can only fail on a disabled connection,
                                    so it is offered Disconnect alone — after which
                                    Connect is back. */}
                                {conn.isEnabled && (
                                    <>
                                        <Button variant="ghost" size="sm" onClick={() => test(conn.id)}>{t('sharepoint.test')}</Button>
                                        <Button variant="ghost" size="sm" onClick={() => openSites(conn)}>{t('sharepoint.sites')}</Button>
                                    </>
                                )}
                                <Button variant="ghost" size="sm" onClick={() => disconnect(conn)}>{t('sharepoint.disconnect')}</Button>
                            </div>
                        )}
                    </div>
                    {!conn.isEnabled && (
                        <p className="text-xs text-content-muted">{t('sharepoint.disabledHint')}</p>
                    )}
                    {testResult[conn.id] && (
                        <p className="text-xs text-content-muted">{testResult[conn.id]}</p>
                    )}
                    {sitesFor === conn.id && (
                        <div className="space-y-default border-t border-border-subtle pt-default">
                            <p className="text-sm text-content-muted">{t('sharepoint.chooseSites')}</p>
                            <Combobox
                                id={`sp-sites-${conn.id}`}
                                multiple
                                options={siteOptions}
                                selected={siteOptions.filter((o) => selectedSites.includes(o.value))}
                                setSelected={(opts) => setSelectedSites(opts.map((o) => o.value))}
                                placeholder={t('sharepoint.selectSites')}
                                matchTriggerWidth
                            />
                            <div className="flex justify-end gap-tight">
                                <Button variant="ghost" size="sm" onClick={() => setSitesFor(null)}>{t('sharepoint.cancel')}</Button>
                                <Button variant="secondary" size="sm" onClick={() => saveSites(conn.id)} disabled={busy}>
                                    {t('sharepoint.saveSites')}
                                </Button>
                            </div>
                        </div>
                    )}
                </div>
            ))}
        </Card>
    );
}
