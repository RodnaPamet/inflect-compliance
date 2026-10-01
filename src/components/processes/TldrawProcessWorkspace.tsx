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
import type { Editor } from 'tldraw';

import type { ProcessMapSummary } from '@/lib/processes/process-map-summary';
import { useToast } from '@/components/ui/hooks';
import { CanvasDocumentBar } from '@/components/processes/CanvasDocumentBar';
import { ProcessInspector } from '@/components/processes/ProcessInspector';
import { ProcessPalette } from '@/components/processes/ProcessPalette';
import { TldrawCanvasExportMenu } from '@/components/processes/TldrawCanvasExportMenu';
import { TldrawProcessMap } from '@/components/processes/TldrawProcessMap';
import { RunModeProvider } from '@/lib/processes/run-mode-context';
import type { AutosaveStatus } from '@/lib/processes/use-canvas-autosave';
import { useTldrawDocumentBar } from '@/lib/processes/use-tldraw-document-bar';
import { useTldrawSelection } from '@/lib/processes/use-tldraw-selection';

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

    const activeProcess = activeId
        ? (processes.find((p) => p.id === activeId) ?? null)
        : null;

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
            </div>
        </div>
    );
}
