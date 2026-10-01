'use client';

/**
 * The tldraw process workspace: canvas, document bar, palette, inspector.
 *
 * ── The same props as the component it replaces ──────────────────────
 *
 * Deliberately identical to `PersistedProcessCanvasProps`, so the branch in
 * `ProcessesClient` is a choice of component and nothing else. A workspace with
 * a different contract would push the flag's shape into the page, where it
 * would have to survive the cutover that deletes one of the two branches.
 *
 * ── How little of this is new ────────────────────────────────────────
 *
 * Almost nothing here is tldraw-specific. The chrome is reused unchanged
 * because none of it was ever engine-coupled — measured, with
 * `PersistedProcessCanvas`'s own 11 engine references as the control:
 *
 *   `CanvasDocumentBar`   479 lines   0 engine references
 *   `ProcessInspector`    714 lines   0
 *   `ProcessPalette`      198 lines   0
 *
 * What is tldraw-specific lives in three hooks that landed separately —
 * `useTldrawDocumentBar`, `useTldrawSelection`, `useTldrawCanvasAutosave` — plus
 * the export menu. This file is the wiring between them, and if it reads as
 * thin that is the point: the adapters earned it.
 *
 * ── What is NOT here yet ─────────────────────────────────────────────
 *
 * Version history, restore and the row-level diff ARE here — see
 * `handleDiffRequest` for the one way this host differs from the xyflow
 * one, which is a deliberate improvement rather than a port artefact.
 *
 * `CanvasCommandPalette`, the `/`-triggered command surface. It needs a command
 * adapter mapping align / distribute / group onto `editor.alignShapes` and
 * friends, which is a distinct concern from this composition and would make
 * this diff one nobody wants to review in a sitting. Its omission costs
 * discoverability, not function: every action it exposes is reachable from the
 * bar or tldraw's own UI. Tracked on #2961.
 *
 * The inspector's SIZE control is visible and inert. It persists to
 * `dataJson.size`, which this renderer deliberately does not read — the owner's
 * option-B decision in #2961 — so `useTldrawSelection` drops the patch rather
 * than saving a value nothing displays. Hiding the control needs a prop on the
 * shared inspector and is awaiting the owner's choice among three options.
 * Inert behind a flag is the honest intermediate state; silently reversing that
 * decision by teaching the renderer to read the column is not mine to do.
 */
import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Editor } from 'tldraw';

import type { ProcessMapSummary } from '@/lib/processes/process-map-summary';
import { useToast } from '@/components/ui/hooks';
import { CanvasDiffOverlay } from '@/components/processes/CanvasDiffOverlay';
import { CanvasDocumentBar } from '@/components/processes/CanvasDocumentBar';
import { CanvasHistorySidebar } from '@/components/processes/CanvasHistorySidebar';
import { ProcessInspector } from '@/components/processes/ProcessInspector';
import { ProcessPalette } from '@/components/processes/ProcessPalette';
import { TldrawCanvasExportMenu } from '@/components/processes/TldrawCanvasExportMenu';
import { TldrawProcessMap } from '@/components/processes/TldrawProcessMap';
import {
    useUnsavedChangesWarning,
    useUnsavedNavigationGuard,
} from '@/lib/hooks';
import { serializeEditorCanvas } from '@/components/processes/tldraw/editor-canvas';
import type { GraphRows } from '@/components/processes/tldraw/serializer';
import type { DiffGraphSnapshot } from '@/lib/processes/canvas-diff';
import { RunModeProvider } from '@/lib/processes/run-mode-context';
import type { AutosaveStatus } from '@/lib/processes/use-canvas-autosave';
import { useTldrawDocumentBar } from '@/lib/processes/use-tldraw-document-bar';
import { useTldrawSelection } from '@/lib/processes/use-tldraw-selection';

/**
 * `GraphRows` → `DiffGraphSnapshot`.
 *
 * The field NAMES line up exactly. The MODIFIERS do not, and that is the whole
 * reason this function exists: `ProcessNodeInput` declares `subtitle`,
 * `parentNodeKey` and `dataJson` OPTIONAL, where `DiffNodeRow` requires them
 * present-and-nullable. Reading the two declarations side by side did not catch
 * it, because the names matched and the names are what I compared; `tsc` did.
 *
 * Behaviourally the two shapes are ALREADY equivalent — `classifyNode` and
 * `classifyEdge` each compare through `?? null`, so an absent field and a null
 * one are the same answer to the diff. This therefore changes no verdict; it
 * satisfies the declared contract using the same collapse the comparison
 * already performs, which is why it is a mapping and not a cast. A cast would
 * have compiled and left `subtitle: undefined` reaching a `string | null`.
 */
function toDiffSnapshot(rows: GraphRows): DiffGraphSnapshot {
    return {
        nodes: rows.nodes.map((n) => ({
            nodeKey: n.nodeKey,
            nodeType: n.nodeType,
            label: n.label,
            subtitle: n.subtitle ?? null,
            posX: n.posX,
            posY: n.posY,
            parentNodeKey: n.parentNodeKey ?? null,
            dataJson: n.dataJson ?? null,
        })),
        edges: rows.edges.map((e) => ({
            edgeKey: e.edgeKey,
            sourceKey: e.sourceKey,
            targetKey: e.targetKey,
            edgeKind: e.edgeKind,
            labelOverride: e.labelOverride ?? null,
            dataJson: e.dataJson ?? null,
        })),
    };
}

export interface TldrawProcessWorkspaceProps {
    tenantSlug: string;
    processes: ProcessMapSummary[];
    activeId: string | null;
    onActiveIdChange: (id: string | null) => void;
    onProcessesChange: (next: ProcessMapSummary[]) => void;
}

export function TldrawProcessWorkspace(props: TldrawProcessWorkspaceProps) {
    // Run Mode must be PRESENT but off for a document map: the overlay poll is
    // gated on the flag, so the provider missing is not the same as the mode
    // being off — consumers would throw rather than read false.
    return (
        <RunModeProvider>
            <Inner {...props} />
        </RunModeProvider>
    );
}

function Inner({
    tenantSlug,
    processes,
    activeId,
    onActiveIdChange,
    onProcessesChange,
}: TldrawProcessWorkspaceProps) {
    const toast = useToast();
    const [editor, setEditor] = useState<Editor | null>(null);
    const [version, setVersion] = useState<number | undefined>(undefined);
    const [autosaveStatus, setAutosaveStatus] = useState<AutosaveStatus>('idle');
    const [reloadKey, setReloadKey] = useState(0);
    /**
     * The open diff, holding the live snapshot CAPTURED AT CLICK TIME.
     *
     * The xyflow host passes `currentSnapshot={buildLiveSnapshot(nodes, edges)}`
     * — recomputed in its render body on every pass. Doing the same here would
     * be wrong twice over, and the first reason is a crash:
     * `serializeEditorCanvas` THROWS `EdgeEndpointError`, where
     * `serializeGraphForSave` has no `throw` in it at all. A read-only "show me
     * what changed" surface must not be able to take down the canvas it
     * describes, and a throw from a render body does exactly that.
     *
     * Capturing once at click time also makes the comparison STABLE: the
     * baseline cannot shift under the reader while they are looking at it,
     * which for a diff is the whole point.
     */
    const [diff, setDiff] = useState<{
        version: number;
        snapshot: DiffGraphSnapshot;
    } | null>(null);

    const t = useTranslations('automation.canvas');
    const tHistory = useTranslations('automation.history');

    const activeProcess = activeId
        ? (processes.find((p) => p.id === activeId) ?? null)
        : null;

    /**
     * Unsaved work must not leave silently.
     *
     * Regression-list item on #2962, and the only gap found so far that
     * DESTROYS something rather than merely missing it: without these two the
     * tldraw canvas would let a tab close or a sidebar click discard edits
     * with no word, which is strictly worse than any feature not yet ported.
     *
     * The window is the same one the xyflow canvas guards, and the status
     * values are why: `pending` is the debounce — markDirty has fired and the
     * save has not — which is where most unsaved work lives during normal
     * editing. `saving` is in flight, `error` is work that failed to land.
     *
     * BOTH hooks, because they cover different exits and neither subsumes the
     * other: `beforeunload` never fires for an App Router client-side
     * transition, so the tab-close guard alone would still lose work to a
     * sidebar link.
     */
    const hasUnsavedWork =
        autosaveStatus === 'pending' ||
        autosaveStatus === 'saving' ||
        autosaveStatus === 'error';
    useUnsavedChangesWarning(hasUnsavedWork);
    useUnsavedNavigationGuard(hasUnsavedWork, t('unsavedLeaveConfirm'));

    const handleState = useCallback(
        (s: { version: number | undefined; autosaveStatus: AutosaveStatus }) => {
            setVersion(s.version);
            setAutosaveStatus(s.autosaveStatus);
        },
        [],
    );

    /**
     * A 409 remounts the map rather than patching it.
     *
     * The conflict means somebody else's version is authoritative, so the only
     * correct next state is whatever the server now holds. Bumping a key
     * discards the local editor and reloads — the same move the xyflow canvas
     * makes with its `reloadCounter`, and for the same reason: merging two
     * divergent graphs is not something either canvas can do.
     */
    const handleConflict = useCallback(() => setReloadKey((k) => k + 1), []);

    /**
     * Open the diff against `version`, reading the live canvas once.
     *
     * The throw is believed unreachable — `editor-canvas.ts` records that
     * deleting an endpoint takes the binding count to zero rather than
     * leaving a dangling one, so the validator is belt-and-braces. "Believed
     * unreachable" is still not "cannot happen", and the cost of being wrong
     * here would be a blank page instead of a toast.
     */
    const handleDiffRequest = useCallback(
        (version: number) => {
            if (!editor) return;
            try {
                setDiff({
                    version,
                    snapshot: toDiffSnapshot(serializeEditorCanvas(editor).rows),
                });
            } catch {
                setDiff(null);
                toast.error(tHistory('diffFailed'));
            }
        },
        [editor, toast, tHistory],
    );

    /**
     * A restore remounts the map, for the same reason a 409 does: the server
     * now holds a different graph, and the only correct next state is whatever
     * it says. Separate callback from `handleConflict` despite the identical
     * body — they are different events, and collapsing them would make the
     * next reader think a restore is a conflict.
     */
    const handleRestored = useCallback(() => {
        setDiff(null);
        setReloadKey((k) => k + 1);
    }, []);

    const handleSaved = useCallback(
        (saved: { id: string; version: number; updatedAt: string }) => {
            // Keep the summary list's version in step, so the bar's pill and a
            // later rename both carry the fresh token.
            onProcessesChange(
                processes.map((p) =>
                    p.id === saved.id
                        ? { ...p, version: saved.version, updatedAt: saved.updatedAt }
                        : p,
                ),
            );
        },
        [processes, onProcessesChange],
    );

    const bar = useTldrawDocumentBar({
        tenantSlug,
        editor,
        mapId: activeId,
        processes,
        activeProcess,
        version,
        autosaveStatus,
        autosaveError: null,
        toast,
        onActiveIdChange,
        onProcessesChange,
        onSaved: handleSaved,
        onConflict: handleConflict,
    });

    const selection = useTldrawSelection(editor);

    return (
        <div className="flex h-full w-full flex-col">
            <CanvasDocumentBar
                tenantSlug={tenantSlug}
                doc={bar.doc}
                busy={bar.busy}
                editorState={bar.editorState}
                handlers={bar.handlers}
                exportSlot={
                    activeId && activeProcess ? (
                        <TldrawCanvasExportMenu
                            editor={editor}
                            mapName={activeProcess.name}
                            tenantSlug={tenantSlug}
                            mapId={activeId}
                            disabled={bar.busy.saving}
                        />
                    ) : null
                }
            />

            <div className="flex min-h-0 flex-1">
                <ProcessPalette />

                <div className="min-w-0 flex-1">
                    <TldrawProcessMap
                        // Remounts on a conflict; see `handleConflict`.
                        key={`${activeId ?? 'none'}:${reloadKey}`}
                        tenantSlug={tenantSlug}
                        mapId={activeId}
                        onEditorReady={setEditor}
                        onStateChange={handleState}
                        onSaved={handleSaved}
                    />
                </div>

                <ProcessInspector
                    node={selection.node}
                    edge={selection.edge}
                    tenantSlug={tenantSlug}
                    onUpdate={selection.onUpdate}
                    onEdgeUpdate={selection.onEdgeUpdate}
                    {...(activeId ? { mapId: activeId } : {})}
                />

                {/* Both components are engine-FREE — measured at 0 xyflow
                    references each against `PersistedProcessCanvas`'s 19, the
                    same control that found the bar, palette and inspector
                    reusable. So this is wiring, not a port: the server-side
                    snapshot API, the restore and `computeCanvasDiff` are all
                    shared with the old canvas unchanged. */}
                {activeId && (
                    <CanvasHistorySidebar
                        tenantSlug={tenantSlug}
                        mapId={activeId}
                        currentVersion={version ?? null}
                        onDiffRequest={handleDiffRequest}
                        onRestored={handleRestored}
                    />
                )}
                {activeId && diff && version != null && (
                    <CanvasDiffOverlay
                        open
                        onOpenChange={(next) => {
                            if (!next) setDiff(null);
                        }}
                        tenantSlug={tenantSlug}
                        mapId={activeId}
                        targetVersion={diff.version}
                        currentVersion={version}
                        currentSnapshot={diff.snapshot}
                    />
                )}
            </div>
        </div>
    );
}
