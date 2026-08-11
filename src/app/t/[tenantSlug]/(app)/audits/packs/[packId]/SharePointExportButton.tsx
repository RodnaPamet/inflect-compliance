'use client';

/**
 * SP-5 / SP-F1 — "Export to SharePoint" for a frozen audit pack. Picks a
 * destination FOLDER via the shared file picker (folder-select mode) and
 * uploads the pack ZIP there. Success/failure surface as toasts (not inline
 * chrome in the icon-button row), and the button explains — via a tooltip —
 * why it is disabled while the SharePoint connection is still being probed.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/hooks';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { SharePointFilePicker } from '@/components/integrations/sharepoint/SharePointFilePicker';

interface SharePointConnection {
    id: string;
}

/**
 * What `POST /audits/packs/{id}/sharepoint-export` returns. Every field is
 * optional at the boundary because the toast logic already defaults each one —
 * the counts arrived in SP-F2 and older responses simply won't carry them.
 */
interface ExportResult {
    webUrl?: string | null;
    skipped?: Record<string, number>;
    skippedTotal?: number;
}

export function SharePointExportButton({ packId }: { packId: string }) {
    const tx = useTranslations('audits');
    const toast = useToast();
    const apiUrl = useTenantApiUrl();
    const [pickerOpen, setPickerOpen] = useState(false);

    // ─── Read ───
    //
    // The hand-rolled `fetch` + `useEffect` + `useState` probe became one SWR
    // key. It is shared with the other two pickers that read the same path, so
    // opening this page after an upload modal costs no second request.
    const connectionsQuery = useTenantSWR<SharePointConnection[]>(
        CACHE_KEYS.integrations.sharepointConnections(),
    );
    const connId = connectionsQuery.data?.[0]?.id ?? '';

    // The tri-state the old probe carried: `null` while probing, `false` when
    // there is nothing to export to, `true` otherwise.
    //
    // Ordered DATA-FIRST, and the order is the whole point. A failed probe
    // still reads `false` — that is what the old `catch` did, and it is right
    // for a COLD START: with no connection id there is no destination, so
    // offering the button would only produce a picker that cannot open.
    //
    // But the old probe ran once per mount, so that branch could only ever be
    // reached before the button first rendered. `useTenantSWR` revalidates on
    // focus and on reconnect and SWR keeps the cached data when one fails, so
    // an error-first ternary would flip `available` to `false` on a blip and
    // unmount a button whose `connId` is still perfectly valid — taking an
    // in-progress folder selection in `<SharePointFilePicker>` with it.
    // Reading `data` first confines the error branch to the cold-start case it
    // was actually written for.
    const available: boolean | null = connectionsQuery.data
        ? connectionsQuery.data.length > 0
        : connectionsQuery.error
          ? false
          : null;

    // ─── Write ───
    const exportMutation = useTenantMutation<
        unknown,
        { driveId: string; folderId?: string },
        ExportResult
    >({
        // The export writes `spExportItemId` / `spExportWebUrl` /
        // `spExportedAt` onto the AuditPack row, and the pack-detail payload
        // carries them — so that is the entry this revalidates.
        key: CACHE_KEYS.audits.pack(packId),
        // No optimistic prediction. Everything the response reports is minted
        // server-side while the ZIP is built and uploaded: the SharePoint item
        // id, its webUrl, the export timestamp, and the per-reason skip counts
        // that decide whether this was a success or a PARTIAL. Guessing any of
        // it would be a claim about what SharePoint accepted.
        mutationFn: async ({ driveId, folderId }) => {
            // Keep the two failure shapes apart — they have always had
            // different toasts, and the distinction is what tells an operator
            // whether the server refused the export (non-2xx) or the request
            // never landed (throw).
            const res = await fetch(apiUrl(`/audits/packs/${packId}/sharepoint-export`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connectionId: connId, driveId, folderId }),
            }).catch(() => null);
            if (!res) throw new Error(tx('sharepoint.exportFailedNetwork'));
            if (!res.ok) throw new Error(tx('sharepoint.exportFailed'));
            // An unparseable body used to land in the same catch as a network
            // throw (the old code read `data.webUrl` inside the try), so it
            // keeps that toast rather than surfacing a raw parse error.
            const data = (await res.json().catch(() => null)) as ExportResult | null;
            if (!data) throw new Error(tx('sharepoint.exportFailedNetwork'));
            return data;
        },
    });
    const busy = exportMutation.isMutating;

    const exportTo = async (driveId: string, folderId?: string) => {
        try {
            const data = await exportMutation.trigger({ driveId, folderId });
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
                        ['foreignKey', 'sharepoint.skipReasonForeignKey'],
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
        } catch (e) {
            // The message IS the distinction: `mutationFn` throws the refused
            // toast for a non-2xx and the network one for a request that never
            // landed. The fallback covers a non-Error throw, as the old
            // catch-all did.
            toast.error(e instanceof Error ? e.message : tx('sharepoint.exportFailedNetwork'));
        }
    };

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
