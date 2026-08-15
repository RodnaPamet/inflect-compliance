"use client";

/**
 * R32-PR10 — CanvasDocumentBar.
 *
 * The single-strip document bar that sits above the canvas plane.
 * Pre-R32 this lived as ~195 lines of inline JSX in
 * `PersistedProcessCanvas` (already 2000+ lines). Extracted to its
 * own file so the canvas component stays readable + so future
 * polish on the bar (icon buttons, overflow menu, tab/mode
 * switcher) doesn't drag the whole canvas into reformatting churn.
 *
 * Shape:
 *
 *   [breadcrumb] [process selector] [name input] [New] [Duplicate]
 *                                              [Undo] [Redo] [Snap]
 *                                              [error] [autosave]
 *                                              [version] [Save]
 *
 * Every testid the R26-PR-E / R28 / R31 ratchets pin is preserved
 * verbatim — the visual shape is byte-identical to the pre-R32
 * inline version. This component takes 5 grouped props so the
 * call-site reads as a single composition node, not 20-prop salad:
 *
 *   • doc          — document identity + the list of processes
 *   • busy         — the four-flag loading map
 *   • editorState  — snap toggle + autosave status + history flags
 *   • handlers     — every callback wired into a button
 *   • tenantSlug   — passed directly for the breadcrumb link
 *
 * The bar owns NO state. Every field flows from `Inner` upstream.
 */

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useRunMode } from "@/lib/processes/run-mode-context";
import { useIsAutomationMode } from "@/lib/processes/canvas-mode-context";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { CanvasMapDeleteControl } from "./CanvasMapDeleteControl";
import type { ProcessMapSummary } from "@/app/t/[tenantSlug]/(app)/processes/ProcessesClient";

import type { AutosaveStatus } from "@/lib/processes/use-canvas-autosave";

export interface CanvasDocumentBarDoc {
    activeId: string | null;
    processes: ProcessMapSummary[];
    activeProcess: ProcessMapSummary | null;
    editedName: string;
    loadedMap: { version: number } | null;
    error: string | null;
}

export interface CanvasDocumentBarBusy {
    saving: boolean;
    loading: boolean;
    creating: boolean;
    duplicating: boolean;
}

export interface CanvasDocumentBarEditorState {
    snapEnabled: boolean;
    autosaveStatus: AutosaveStatus;
    /** Message from the failed save, surfaced as the status chip's title. */
    autosaveError: string | null;
    canUndo: boolean;
    canRedo: boolean;
}

export interface CanvasDocumentBarHandlers {
    onActiveIdChange: (id: string | null) => void;
    setEditedName: (next: string) => void;
    handleSave: () => void | Promise<void>;
    handleNew: () => void | Promise<void>;
    handleDuplicate: () => void | Promise<void>;
    handleRenameCommit: () => void | Promise<void>;
    handleUndo: () => void;
    handleRedo: () => void;
    setSnapEnabled: (next: boolean | ((prev: boolean) => boolean)) => void;
    /** PR-B follow-up — convert the active map DOCUMENT ⇄ AUTOMATION. */
    onSwitchMode: () => void | Promise<void>;
    /** Lifecycle — transition the active map's status. */
    onChangeStatus: (status: ProcessMapSummary["status"]) => void | Promise<void>;
    /** Lifecycle — soft-delete the active map. Throws on failure. */
    onDelete: () => void | Promise<void>;
}

export interface CanvasDocumentBarProps {
    tenantSlug: string;
    doc: CanvasDocumentBarDoc;
    busy: CanvasDocumentBarBusy;
    editorState: CanvasDocumentBarEditorState;
    handlers: CanvasDocumentBarHandlers;
    /**
     * Epic P3-PR-A — Optional slot for the export menu. The bar
     * stays presentational; the canvas owns the menu's ref +
     * nodes + mapName and renders <CanvasExportMenu> into this
     * slot. Omit on contexts where export isn't appropriate
     * (e.g. empty state).
     */
    exportSlot?: import("react").ReactNode;
}

export function CanvasDocumentBar({
    tenantSlug,
    doc,
    busy,
    editorState,
    handlers,
    exportSlot,
}: CanvasDocumentBarProps) {
    const t = useTranslations("automation.documentBar");
    // VR-6 — Run Mode toggle (automation canvases only). Flips the canvas
    // between Design (edit) and Live (overlay live execution state on nodes).
    const isAutomation = useIsAutomationMode();
    const { isRunMode, setRunMode } = useRunMode();
    const {
        activeId,
        processes,
        activeProcess,
        editedName,
        loadedMap,
        error,
    } = doc;
    // R32-PR12 — Combobox option mapping. Stable references so the
    // primitive doesn't re-render on every parent tick.
    const processOptions = useMemo<ComboboxOption[]>(
        () =>
            processes.map((p) => ({
                value: p.id,
                label: p.name,
            })),
        [processes],
    );
    const selectedProcessOption = useMemo<ComboboxOption | null>(
        () =>
            activeId
                ? processOptions.find((o) => o.value === activeId) ?? null
                : null,
        [activeId, processOptions],
    );
    // Lifecycle — status selector options. Stable references so the
    // Combobox doesn't churn on every parent tick.
    const statusOptions = useMemo<ComboboxOption[]>(
        () => [
            { value: "DRAFT", label: t("statusDraft") },
            { value: "ACTIVE", label: t("statusActive") },
            { value: "ARCHIVED", label: t("statusArchived") },
        ],
        [t],
    );
    const selectedStatusOption = useMemo<ComboboxOption | null>(
        () =>
            activeProcess
                ? statusOptions.find((o) => o.value === activeProcess.status) ??
                  null
                : null,
        [activeProcess, statusOptions],
    );
    const { saving, loading, creating, duplicating } = busy;
    const { snapEnabled, autosaveStatus, autosaveError, canUndo, canRedo } = editorState;
    const {
        onActiveIdChange,
        setEditedName,
        handleSave,
        handleNew,
        handleDuplicate,
        handleRenameCommit,
        handleUndo,
        handleRedo,
        setSnapEnabled,
        onSwitchMode,
        onChangeStatus,
        onDelete,
    } = handlers;
    const currentMode = activeProcess?.canvasMode ?? "DOCUMENT";

    return (
        // R31 Bundle 3 (PR 1) — single document bar above the canvas.
        // The page above retired its Heading + breadcrumb +
        // description block; this strip carries the editor's own
        // identity inline (Figma-style).
        <div
            className="flex items-center gap-default border-b border-canvas-border px-default py-2.5"
            data-persisted-canvas-toolbar="true"
            data-canvas-document-bar="true"
        >
            {/* Inline breadcrumb — the editor's own identity, not
                a separate page header. */}
            <nav
                className="flex items-center gap-1 text-[11px] text-content-subtle"
                aria-label={t("breadcrumb")}
                data-canvas-document-breadcrumb="true"
            >
                <a
                    href={`/t/${tenantSlug}/dashboard`}
                    className="rounded-[4px] px-1 text-content-muted hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:bg-bg-muted"
                >
                    {t("dashboard")}
                </a>
                <span aria-hidden="true" className="text-content-subtle">
                    ›
                </span>
                <span className="px-1 font-medium text-content-emphasis">
                    {t("processes")}
                </span>
                <span aria-hidden="true" className="text-content-subtle">
                    ›
                </span>
            </nav>
            {/* R32-PR12 — process selector promoted from the raw
                native picker to the canonical `<Combobox>` (Epic
                55). Combobox brings keyboard search, fuzzy match,
                large-list virtualisation, and the IC token
                vocabulary the rest of the app uses. The bar wraps
                it in a fixed-width sleeve so the selector reads as
                a confident pill in the chrome row. */}
            <div data-testid="process-selector" className="min-w-[160px]">
                <Combobox
                    selected={selectedProcessOption}
                    setSelected={(option) =>
                        onActiveIdChange(option?.value ?? null)
                    }
                    options={processOptions}
                    disabled={
                        processes.length === 0 || loading || saving
                    }
                    aria-label={t("selectProcessAria")}
                    placeholder={t("selectProcessPlaceholder")}
                />
            </div>
            {activeId && (
                // R26-PR-E — inline rename. Commits on blur or Enter;
                // pressing Escape reverts to the active process's
                // stored name.
                //
                // R32-PR12 — Figma-style auto-grow. The input's
                // visible width tracks the typed content via the
                // `ch` unit (1ch ≈ width of "0"), with floor /
                // ceiling clamped via CSS min/max so empty inputs
                // still read as a target and long names don't
                // crowd the action cluster.
                <input
                    type="text"
                    value={editedName}
                    onChange={(e) => setEditedName(e.target.value)}
                    onBlur={handleRenameCommit}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.currentTarget.blur();
                        } else if (e.key === "Escape") {
                            setEditedName(activeProcess?.name ?? "");
                            e.currentTarget.blur();
                        }
                    }}
                    disabled={saving || loading}
                    aria-label={t("processNameAria")}
                    placeholder={t("untitledProcess")}
                    data-testid="process-name-input"
                    style={{
                        width: `${Math.max(
                            (editedName.length || t("untitledProcess").length) + 2,
                            12,
                        )}ch`,
                    }}
                    className="max-w-[28ch] rounded-[6px] border border-transparent bg-transparent px-2 py-1 text-xs font-medium text-content-emphasis hover:border-canvas-border focus:border-border-emphasis focus:bg-canvas-surface focus:outline-none"
                />
            )}
            <Button
                size="sm"
                variant="secondary"
                onClick={handleNew}
                disabled={creating}
                data-testid="new-process-btn"
            >
                {creating ? t("creating") : t("newProcess")}
            </Button>
            {activeId && (
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={handleDuplicate}
                    disabled={duplicating || saving || loading}
                    data-testid="duplicate-process-btn"
                >
                    {duplicating ? t("duplicating") : t("duplicate")}
                </Button>
            )}
            {activeId && (
                // Lifecycle — DRAFT / ACTIVE / ARCHIVED status selector.
                // Reflects the active map's stored status; on change it
                // PATCHes `{ status }` and the parent patches the list
                // in place so the pill stays in sync.
                <div data-testid="process-status-selector" className="min-w-[130px]">
                    <Combobox
                        selected={selectedStatusOption}
                        setSelected={(option) => {
                            if (option) {
                                void onChangeStatus(
                                    option.value as ProcessMapSummary["status"],
                                );
                            }
                        }}
                        options={statusOptions}
                        disabled={loading || saving}
                        aria-label={t("statusAria")}
                        placeholder={t("statusPlaceholder")}
                    />
                </div>
            )}
            <div className="ml-auto flex items-center gap-default">
                {activeId && (
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={onSwitchMode}
                        data-testid="canvas-mode-toggle"
                        title={
                            currentMode === "AUTOMATION"
                                ? t("convertToProcessMap")
                                : t("convertToAutomation")
                        }
                    >
                        {currentMode === "AUTOMATION"
                            ? t("modeAutomation")
                            : t("modeProcessMap")}
                    </Button>
                )}
                {activeId && (
                    // Lifecycle — delete affordance. Opens a
                    // typed-confirmation modal (the sanctioned pattern
                    // for top-level entity deletion — NOT the undo-toast).
                    <CanvasMapDeleteControl
                        mapName={activeProcess?.name ?? ""}
                        onDelete={onDelete}
                        disabled={saving || loading}
                        t={t}
                    />
                )}
                {isAutomation && activeId && (
                    <Button
                        size="sm"
                        variant={isRunMode ? "primary" : "secondary"}
                        onClick={() => setRunMode(!isRunMode)}
                        data-testid="run-mode-toggle"
                    >
                        {isRunMode ? t("live") : t("design")}
                    </Button>
                )}
                {/* R28 — undo / redo. Pure icon buttons live in the
                    toolbar's right-side cluster so the keyboard-bind
                    discovery (Cmd+Z / Cmd+Shift+Z) is mirrored
                    visually. Disabled states drop out via the
                    history hook's flags. */}
                {activeId && (
                    <>
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={handleUndo}
                            disabled={!canUndo || saving || loading}
                            aria-label={t("undo")}
                            title={t("undoTitle")}
                            data-testid="canvas-undo-btn"
                        >
                            {t("undo")}
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={handleRedo}
                            disabled={!canRedo || saving || loading}
                            aria-label={t("redo")}
                            title={t("redoTitle")}
                            data-testid="canvas-redo-btn"
                        >
                            {t("redo")}
                        </Button>
                        {/* Snap-to-grid toggle. Persists per tenant
                            in localStorage; reads as a soft pill so
                            it stays calm next to the action buttons. */}
                        <button
                            type="button"
                            onClick={() => setSnapEnabled((v) => !v)}
                            className="rounded-[6px] border border-canvas-border bg-canvas-surface px-2 py-1 text-[11px] font-medium text-content-muted hover:border-border-emphasis hover:text-content-emphasis aria-pressed:border-border-emphasis aria-pressed:bg-canvas-node aria-pressed:text-content-emphasis"
                            aria-pressed={snapEnabled}
                            aria-label={t("snapToGrid")}
                            title={t("snapToGrid")}
                            data-testid="canvas-snap-toggle"
                        >
                            {t("snap")}
                        </button>
                    </>
                )}
                {error && (
                    <span
                        className="text-xs text-content-error"
                        role="alert"
                    >
                        {error}
                    </span>
                )}
                {/* R32-PR12 — version pill moves AHEAD of the
                    autosave status so the status reads adjacent
                    to the Save button (Notion's "All changes
                    saved" placement). The pill is the persistent
                    document identity; the status is the verb-tense
                    of the Save action it sits next to. */}
                {loadedMap && (
                    <span className="text-xs text-content-subtle tabular-nums">
                        v{loadedMap.version}
                    </span>
                )}
                {/* R28 — autosave status. Quietly reports the debounce
                    state; vanishes when idle so the toolbar isn't
                    carrying constant chrome. R32-PR12 placed it
                    adjacent to the Save button. */}
                {autosaveStatus === "pending" && (
                    <span
                        className="text-[11px] text-content-subtle"
                        data-testid="autosave-status"
                        data-autosave-status="pending"
                    >
                        {t("unsaved")}
                    </span>
                )}
                {autosaveStatus === "saving" && (
                    <span
                        className="text-[11px] text-content-subtle"
                        data-testid="autosave-status"
                        data-autosave-status="saving"
                    >
                        {t("saving")}
                    </span>
                )}
                {autosaveStatus === "saved" && (
                    <span
                        className="text-[11px] text-content-success"
                        data-testid="autosave-status"
                        data-autosave-status="saved"
                    >
                        {t("saved")}
                    </span>
                )}
                {/* The error branch. There was none — because the canvas
                    swallowed save failures, so the hook could never reach
                    `error` and the missing branch was invisible.
                    
                    This has to be PERSISTENT, not a toast. Autosave does not
                    retry after a failure (the deliberate no-thrash property),
                    the canvas stays fully interactive, and a dismissed or
                    missed toast left NO indication that saving had stopped —
                    the user keeps editing into nothing. Modelled on the 409
                    treatment, which warns before the user acts rather than
                    after. */}
                {autosaveStatus === "error" && (
                    <span
                        className="text-[11px] font-medium text-content-error"
                        data-testid="autosave-status"
                        data-autosave-status="error"
                        title={autosaveError ?? undefined}
                    >
                        {t("saveFailed")}
                    </span>
                )}
                {exportSlot}
                <Button
                    size="sm"
                    variant="primary"
                    onClick={handleSave}
                    disabled={!activeId || saving || loading}
                    data-testid="save-process-btn"
                >
                    {saving ? t("saving") : t("save")}
                </Button>
            </div>
        </div>
    );
}
