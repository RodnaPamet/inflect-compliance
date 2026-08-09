'use client';

/**
 * SP-5 / SP-F1 — "Export to SharePoint" for a frozen audit pack. Picks a
 * destination FOLDER via the shared file picker (folder-select mode) and
 * uploads the pack ZIP there. Success/failure surface as toasts (not inline
 * chrome in the icon-button row), and the button explains — via a tooltip —
 * why it is disabled while the SharePoint connection is still being probed.
 */
import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/hooks';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { SharePointFilePicker } from '@/components/integrations/sharepoint/SharePointFilePicker';

export function SharePointExportButton({ packId }: { packId: string }) {
    const tx = useTranslations('audits');
    const toast = useToast();
    const apiUrl = useTenantApiUrl();
    const [available, setAvailable] = useState<boolean | null>(null);
    const [connId, setConnId] = useState('');
    const [pickerOpen, setPickerOpen] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await fetch(apiUrl('/integrations/sharepoint/connections'));
                if (!res.ok) { if (!cancelled) setAvailable(false); return; }
                const conns = (await res.json()) as Array<{ id: string }>;
                if (cancelled) return;
                setAvailable(conns.length > 0);
                setConnId(conns[0]?.id ?? '');
            } catch {
                if (!cancelled) setAvailable(false);
            }
        })();
        return () => { cancelled = true; };
    }, [apiUrl]);

    const exportTo = useCallback(
        async (driveId: string, folderId?: string) => {
            setBusy(true);
            try {
                const res = await fetch(apiUrl(`/audits/packs/${packId}/sharepoint-export`), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ connectionId: connId, driveId, folderId }),
                });
                if (!res.ok) { toast.error(tx('sharepoint.exportFailed')); return; }
                const data = await res.json();
                const webUrl: string | null = data.webUrl || null;
                const viewAction = webUrl
                    ? {
                          action: {
                              label: tx('sharepoint.viewInSharePoint'),
                              onClick: () => window.open(webUrl, '_blank', 'noopener,noreferrer'),
                          },
                      }
                    : undefined;

                // An export that dropped files is NOT a success. The pack may
                // be handed to an external auditor, so the one moment we can
                // tell someone it is incomplete is right here — this used to
                // fire an unconditional success toast off `webUrl` alone.
                const skipped: Record<string, number> = data.skipped ?? {};
                const skippedTotal: number = data.skippedTotal ?? 0;
                if (skippedTotal > 0) {
                    const reasons = (
                        [
                            ['infected', 'sharepoint.skipReasonInfected'],
                            ['unscanned', 'sharepoint.skipReasonUnscanned'],
                            ['deleted', 'sharepoint.skipReasonDeleted'],
                            ['sizeCapped', 'sharepoint.skipReasonSizeCapped'],
                            ['unreadable', 'sharepoint.skipReasonUnreadable'],
                        ] as const
                    )
                        .filter(([key]) => (skipped[key] ?? 0) > 0)
                        .map(([key, msg]) => tx(msg, { n: skipped[key] ?? 0 }));

                    toast.warning(
                        `${tx('sharepoint.exportedPartial', { count: skippedTotal })} ${reasons.join(' · ')}`,
                        viewAction,
                    );
                    return;
                }
                toast.success(tx('sharepoint.exported'), viewAction);
            } catch {
                toast.error(tx('sharepoint.exportFailedNetwork'));
            } finally {
                setBusy(false);
            }
        },
        [apiUrl, connId, packId, toast, tx],
    );

    if (available === false) return null;

    // Still probing for a connected SharePoint account — the button is
    // disabled and the tooltip explains why (rather than a bare disabled
    // control). `busy` self-explains via its "Exporting…" label.
    const probing = available === null;

    return (
        <>
            <Tooltip content={probing ? tx('sharepoint.probingHint') : undefined}>
                <span className="inline-block leading-none">
                    <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy || !connId}
                        onClick={() => setPickerOpen(true)}
                        id="sp-export-pack-btn"
                    >
                        {busy ? tx('sharepoint.exporting') : tx('sharepoint.exportBtn')}
                    </Button>
                </span>
            </Tooltip>
            {connId && (
                <SharePointFilePicker
                    showModal={pickerOpen}
                    setShowModal={setPickerOpen}
                    connectionId={connId}
                    folderSelect
                    onConfirm={() => {}}
                    onConfirmFolder={({ driveId, folderId }) => void exportTo(driveId, folderId)}
                />
            )}
        </>
    );
}
