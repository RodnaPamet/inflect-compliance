'use client';

/**
 * The export menu, for a tldraw canvas.
 *
 * ── A sibling of `CanvasExportMenu`, not a replacement ───────────────
 *
 * Same five actions, same testids, same i18n keys, same busy/toast behaviour.
 * What differs is the single prop that identifies the canvas: that menu takes
 * `canvasEl` plus the live `nodes` — because html-to-image needs a DOM subtree
 * and xyflow needs the node list to compute a fit-to-content viewport — and
 * this one takes an `Editor`, because tldraw derives both itself.
 *
 * The i18n keys are REUSED rather than duplicated (`automation.exportMenu`).
 * Minting a parallel namespace would mean two copies of "Export as PNG" to keep
 * in step across every locale, and the strings are not what changed.
 *
 * ── One import that outlives its module ──────────────────────────────
 *
 * `canCopyImageToClipboard` comes from `canvas-export.ts` — the xyflow module.
 * It is a five-line feature check with no engine coupling, so it belongs in
 * `canvas-export-shared.ts` with the other three, and it is NOT moved here
 * because `tests/guards/p-polish-b.test.ts` pins its location by source
 * pattern. Phase 4 deletes `canvas-export.ts`, which is the diff that has to
 * touch both the function and that guard anyway; relocating it now would churn
 * the guard twice. Tracked as a cutover item on #2961 rather than left to be
 * rediscovered by a red build.
 */
import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Editor } from 'tldraw';

import { Button } from '@/components/ui/button';
import { Popover } from '@/components/ui/popover';
import { useToast } from '@/components/ui/hooks';
import { canCopyImageToClipboard } from '@/lib/processes/canvas-export';
import {
    attachTldrawCanvasToEvidence,
    copyTldrawCanvasToClipboard,
    exportTldrawCanvasAsPdf,
    exportTldrawCanvasAsPng,
    exportTldrawCanvasAsSvg,
} from '@/lib/processes/tldraw-canvas-export';

export type TldrawExportKind = 'png' | 'svg' | 'pdf' | 'evidence' | 'clipboard';

export interface TldrawCanvasExportMenuProps {
    /**
     * The live editor. Null while the canvas is not mounted (empty state,
     * loading) — the trigger disables itself, mirroring how the xyflow menu
     * treats a null `canvasEl`.
     */
    editor: Editor | null;
    /** Display name of the active map; the download filename stem. */
    mapName: string;
    /**
     * Needed only by the two server-backed actions. Omitted, the PDF and
     * Evidence items are not rendered at all — same contract as the xyflow
     * menu, so a caller without a persisted map cannot reach a route that
     * needs an id.
     */
    tenantSlug?: string;
    mapId?: string;
    /** External disable signal (saving, no active map). */
    disabled?: boolean;
}

export function TldrawCanvasExportMenu({
    editor,
    mapName,
    tenantSlug,
    mapId,
    disabled,
}: TldrawCanvasExportMenuProps) {
    const t = useTranslations('automation.exportMenu');
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const toast = useToast();

    const run = useCallback(
        async (kind: TldrawExportKind) => {
            if (!editor) return;
            setBusy(true);
            try {
                if (kind === 'png') {
                    await exportTldrawCanvasAsPng({ editor, mapName });
                } else if (kind === 'svg') {
                    await exportTldrawCanvasAsSvg({ editor, mapName });
                } else if (kind === 'clipboard') {
                    await copyTldrawCanvasToClipboard({ editor, mapName });
                    toast.success(t('copiedToast'));
                } else if (kind === 'pdf') {
                    // Unreachable through the UI — the item is not rendered
                    // without both. Thrown rather than silently returning so a
                    // future caller that invokes `run` directly finds out.
                    if (!tenantSlug || !mapId) {
                        throw new Error('PDF export needs tenantSlug + mapId');
                    }
                    await exportTldrawCanvasAsPdf({ editor, mapName, tenantSlug, mapId });
                } else if (kind === 'evidence') {
                    if (!tenantSlug || !mapId) {
                        throw new Error('Evidence attachment needs tenantSlug + mapId');
                    }
                    await attachTldrawCanvasToEvidence({
                        editor,
                        mapName,
                        tenantSlug,
                        mapId,
                    });
                    toast.success(t('attachedToast'));
                }
                setOpen(false);
            } catch (err) {
                // The empty-canvas refusal surfaces here too, and its message
                // is already human-readable — so it is shown rather than
                // replaced with the generic fallback.
                toast.error(err instanceof Error ? err.message : t('exportFailed'));
            } finally {
                setBusy(false);
            }
        },
        [editor, mapName, tenantSlug, mapId, toast, t],
    );

    const showServerItems = Boolean(tenantSlug && mapId);
    const showClipboardItem = canCopyImageToClipboard();

    return (
        <Popover
            openPopover={open}
            setOpenPopover={setOpen}
            data-testid="tldraw-export-popover"
            content={
                <Popover.Menu aria-label={t('optionsAria')}>
                    <Popover.Item
                        data-testid="tldraw-export-png"
                        onClick={() => void run('png')}
                        disabled={busy}
                    >
                        {t('exportAsPng')}
                    </Popover.Item>
                    <Popover.Item
                        data-testid="tldraw-export-svg"
                        onClick={() => void run('svg')}
                        disabled={busy}
                    >
                        {t('exportAsSvg')}
                    </Popover.Item>
                    {showClipboardItem && (
                        <Popover.Item
                            data-testid="tldraw-export-clipboard"
                            onClick={() => void run('clipboard')}
                            disabled={busy}
                        >
                            {t('copyAsImage')}
                        </Popover.Item>
                    )}
                    {showServerItems && (
                        <>
                            <Popover.Separator />
                            <Popover.Item
                                data-testid="tldraw-export-pdf"
                                onClick={() => void run('pdf')}
                                disabled={busy}
                            >
                                {t('exportAsPdf')}
                            </Popover.Item>
                            <Popover.Item
                                data-testid="tldraw-export-evidence"
                                onClick={() => void run('evidence')}
                                disabled={busy}
                            >
                                {t('attachToEvidence')}
                            </Popover.Item>
                        </>
                    )}
                </Popover.Menu>
            }
        >
            <Button
                variant="secondary"
                size="sm"
                disabled={disabled || busy || !editor}
                data-testid="tldraw-export-trigger"
                aria-haspopup="menu"
            >
                {busy ? t('exporting') : t('trigger')}
            </Button>
        </Popover>
    );
}
