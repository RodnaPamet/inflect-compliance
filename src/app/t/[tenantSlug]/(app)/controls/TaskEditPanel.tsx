"use client";

/**
 * Task side-panel — EDITABLE (replaces the old read-only TaskQuickView).
 *
 * Opened by a single click on a task row beneath a control. Two tabs:
 *   - Details: edit the task (title / description / type / severity / priority
 *     / due date / assignee) inline.
 *   - Activity: the task's audit feed.
 *
 * Renders inside the docked <AsidePanel> (no overlay → the table stays
 * visible). Seeds the form from a fresh GET /tasks/{id} on mount.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Heading } from "@/components/ui/typography";
import { StatusBadge } from "@/components/ui/status-badge";
import { taskStatusVariant, taskStatusLabel } from "@/lib/task-status-badge";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { UserCombobox } from "@/components/ui/user-combobox";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PanelTabs } from "./PanelTabs";
import { DatePicker } from "@/components/ui/date-picker/date-picker";
import { parseYMD, startOfUtcDay, toYMD } from "@/components/ui/date-picker/date-utils";
import { PanelActivityFeed } from "./PanelActivityFeed";
import { EvidenceUploadSection } from "@/components/evidence/EvidenceUploadSection";
import { TERMINAL_WORK_ITEM_STATUSES } from "@/app-layer/domain/work-item-status";
import { Button } from "@/components/ui/button";
import type { ControlTask } from "./ControlTaskRows";

type OptT = (key: string) => string;
const buildSeverityOptions = (t: OptT): ComboboxOption[] => [
    { value: "INFO", label: t("severityLabels.INFO") },
    { value: "LOW", label: t("severityLabels.LOW") },
    { value: "MEDIUM", label: t("severityLabels.MEDIUM") },
    { value: "HIGH", label: t("severityLabels.HIGH") },
    { value: "CRITICAL", label: t("severityLabels.CRITICAL") },
];
const buildPriorityOptions = (t: OptT): ComboboxOption[] => [
    { value: "P0", label: t("priorityLabels.P0") },
    { value: "P1", label: t("priorityLabels.P1") },
    { value: "P2", label: t("priorityLabels.P2") },
    { value: "P3", label: t("priorityLabels.P3") },
];
const buildTypeOptions = (t: OptT): ComboboxOption[] => [
    { value: "TASK", label: t("typeLabels.TASK") },
    { value: "AUDIT_FINDING", label: t("typeLabels.AUDIT_FINDING") },
    { value: "CONTROL_GAP", label: t("typeLabels.CONTROL_GAP") },
    { value: "INCIDENT", label: t("typeLabels.INCIDENT") },
    { value: "IMPROVEMENT", label: t("typeLabels.IMPROVEMENT") },
];
// TP-4 — the panel now carries the FULL field set, incl. status.
// RESOLVED is retired from the picker (redundant with CLOSED). Status
// commits through the setTaskStatus endpoint (state machine + TP-3
// source reconciliation), NOT a raw field PATCH. Labels come from the
// shared task-status map — no local status→variant redeclaration.
const SELECTABLE_STATUSES = ["OPEN", "TRIAGED", "IN_PROGRESS", "IN_REVIEW", "BLOCKED", "CLOSED", "CANCELED"];
const buildStatusOptions = (t: OptT): ComboboxOption[] =>
    SELECTABLE_STATUSES.map((value) => ({ value, label: taskStatusLabel(value, t) }));
type Tab = "details" | "activity";

interface TaskDetail {
    id: string;
    key: string | null;
    title: string;
    description: string | null;
    type: string;
    severity: string;
    priority: string;
    status: string;
    dueAt: string | null;
    assigneeUserId: string | null;
    assignee: { id: string; name: string | null; email: string | null } | null;
}

export function TaskEditPanel({
    tenantSlug,
    task,
    canWrite,
    onSaved,
    variant = "panel",
}: {
    tenantSlug: string;
    task: ControlTask;
    canWrite: boolean;
    /** Retained for API compatibility (AsidePanel owns the close affordance). */
    onClose?: () => void;
    onSaved: () => void;
    /**
     * TP-4 — `panel` (default): the docked quick-view with its own
     * heading + Details/Activity tabs + evidence upload. `form`: just
     * the autosave field set, for embedding in the task-detail edit
     * modal (retires the old EditTaskModal). Same fields either way —
     * ONE edit surface, no divergent field sets.
     */
    variant?: "panel" | "form";
}) {
    const tx = useTranslations("controls");
    const tTask = useTranslations("tasks");
    const SEVERITY_OPTIONS = useMemo(() => buildSeverityOptions(tTask), [tTask]);
    const PRIORITY_OPTIONS = useMemo(() => buildPriorityOptions(tTask), [tTask]);
    const TYPE_OPTIONS = useMemo(() => buildTypeOptions(tTask), [tTask]);
    const STATUS_OPTIONS = useMemo(() => buildStatusOptions(tTask), [tTask]);
    const [tab, setTab] = useState<Tab>("details");
    const base = `/api/t/${tenantSlug}/tasks/${task.id}`;

    // ── Edit form (seeded async from GET /tasks/{id}) — AUTO-SAVED ──
    // Text fields debounce (~800ms) + flush on blur; the type/severity/
    // priority dropdowns, the due-date picker, and the assignee picker commit
    // on change. A live status line replaces the old Cancel/Save buttons.
    const [title, setTitle] = useState(task.title ?? "");
    const [description, setDescription] = useState("");
    const [type, setType] = useState("TASK");
    const [severity, setSeverity] = useState(task.severity ?? "MEDIUM");
    const [priority, setPriority] = useState("P2");
    const [dueAt, setDueAt] = useState("");
    const [assigneeId, setAssigneeId] = useState("");
    // TP-4 — status is part of the field set now. It commits through
    // the setTaskStatus endpoint (never a raw PATCH). Terminal moves
    // (CLOSED / CANCELED) collect a required resolution note first.
    const [status, setStatus] = useState(task.status ?? "OPEN");
    const [pendingTerminalStatus, setPendingTerminalStatus] = useState<string | null>(null);
    const [resolutionDraft, setResolutionDraft] = useState("");
    const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
    const [error, setError] = useState("");
    // The initial GET can fail. Until it succeeds, `loadedRef` stays false and
    // `commitFields` early-returns — so edits would silently NOT persist. Track
    // the failure explicitly, block the form, and offer a retry (bumping
    // `reloadKey` re-runs the load effect).
    const [loadError, setLoadError] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const loadedRef = useRef(false);

    // Latest field values so a debounced/blurred commit PATCHes the current
    // form, never a stale closure. `update()` is the sole writer.
    const fieldsRef = useRef({
        title: task.title ?? "",
        description: "",
        type: "TASK",
        severity: task.severity ?? "MEDIUM",
        priority: "P2",
        dueAt: "",
    });
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const titleInvalid = title.trim().length < 1;

    useEffect(() => {
        let active = true;
        loadedRef.current = false;
        setLoadError(false);
        fetch(base)
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load failed"))))
            .then((t: TaskDetail) => {
                if (!active) return;
                setTitle(t.title ?? "");
                setDescription(t.description ?? "");
                setType(t.type ?? "TASK");
                setSeverity(t.severity ?? "MEDIUM");
                setPriority(t.priority ?? "P2");
                setDueAt(t.dueAt ? String(t.dueAt).slice(0, 10) : "");
                setAssigneeId(t.assigneeUserId ?? "");
                setStatus(t.status ?? "OPEN");
                fieldsRef.current = {
                    title: t.title ?? "",
                    description: t.description ?? "",
                    type: t.type ?? "TASK",
                    severity: t.severity ?? "MEDIUM",
                    priority: t.priority ?? "P2",
                    dueAt: t.dueAt ? String(t.dueAt).slice(0, 10) : "",
                };
                loadedRef.current = true;
            })
            .catch(() => {
                if (!active) return;
                setLoadError(true);
            });
        return () => {
            active = false;
        };
    }, [base, reloadKey]);

    const commitFields = useCallback(async () => {
        if (!canWrite || !loadedRef.current) return;
        const f = fieldsRef.current;
        if (f.title.trim().length < 1) {
            setError(tx("detail.errors.titleRequired"));
            setSaveState("error");
            return;
        }
        setSaveState("saving");
        setError("");
        try {
            const res = await fetch(base, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    title: f.title.trim(),
                    description: f.description.trim() || null,
                    type: f.type,
                    severity: f.severity,
                    priority: f.priority,
                    dueAt: f.dueAt || null,
                }),
            });
            if (!res.ok) throw new Error("save failed");
            setSaveState("saved");
            onSaved();
        } catch {
            // Both the server-not-ok and network-throw paths land here — always
            // surface the translated fallback (never a raw "Failed to fetch").
            setError(tx("detail.errors.saveFailed"));
            setSaveState("error");
        }
    }, [canWrite, base, onSaved, tx]);

    const scheduleCommit = useCallback(() => {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => void commitFields(), 800);
    }, [commitFields]);

    const commitNow = useCallback(() => {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        void commitFields();
    }, [commitFields]);

    /** Update a field's ref + state in lockstep, then save (debounced or now). */
    const update = useCallback(
        (partial: Partial<typeof fieldsRef.current>, immediate: boolean) => {
            fieldsRef.current = { ...fieldsRef.current, ...partial };
            if (partial.title !== undefined) setTitle(partial.title);
            if (partial.description !== undefined) setDescription(partial.description);
            if (partial.type !== undefined) setType(partial.type);
            if (partial.severity !== undefined) setSeverity(partial.severity);
            if (partial.priority !== undefined) setPriority(partial.priority);
            if (partial.dueAt !== undefined) setDueAt(partial.dueAt);
            if (immediate) commitNow();
            else scheduleCommit();
        },
        [commitNow, scheduleCommit],
    );

    /** Assignee persists via its own POST endpoint, on change. */
    const commitAssignee = useCallback(
        async (userId: string) => {
            if (!canWrite) return;
            setSaveState("saving");
            setError("");
            try {
                const res = await fetch(`${base}/assign`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ assigneeUserId: userId || null }),
                });
                if (!res.ok) throw new Error("assignee update failed");
                setSaveState("saved");
                onSaved();
            } catch {
                setError(tx("detail.errors.assigneeUpdateFailed"));
                setSaveState("error");
            }
        },
        [canWrite, base, onSaved, tx],
    );

    /**
     * Status persists via the dedicated /status endpoint (setTaskStatus)
     * so the work-item state machine + TP-3 source reconciliation apply.
     * Terminal moves need a resolution note; non-terminal commit at once.
     */
    const commitStatus = useCallback(
        async (nextStatus: string, resolution?: string) => {
            if (!canWrite) return;
            setSaveState("saving");
            setError("");
            try {
                const res = await fetch(`${base}/status`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(resolution ? { status: nextStatus, resolution } : { status: nextStatus }),
                });
                if (!res.ok) {
                    // A rejected transition carries a meaningful server message
                    // (state-machine / reconciliation error) — surface it as-is.
                    // Fall back to the translated string when the body is empty.
                    const data = await res.json().catch(() => ({}));
                    const serverMessage =
                        (typeof data?.error === "string" && data.error) ||
                        (typeof data?.message === "string" && data.message) ||
                        "";
                    setError(serverMessage || tx("detail.errors.saveFailed"));
                    setSaveState("error");
                    return;
                }
                setStatus(nextStatus);
                setPendingTerminalStatus(null);
                setResolutionDraft("");
                setSaveState("saved");
                onSaved();
            } catch {
                // Network / unexpected throw — no server message to show.
                setError(tx("detail.errors.saveFailed"));
                setSaveState("error");
            }
        },
        [canWrite, base, onSaved, tx],
    );

    const handleStatusChange = useCallback(
        (next: string) => {
            if (!next || next === status) return;
            if ((TERMINAL_WORK_ITEM_STATUSES as readonly string[]).includes(next)) {
                setResolutionDraft("");
                setPendingTerminalStatus(next);
                return;
            }
            void commitStatus(next);
        },
        [status, commitStatus],
    );

    const details = (
        <div className="space-y-default">
            {loadError && (
                <div
                    className="flex flex-wrap items-center justify-between gap-tight rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                    role="alert"
                    data-testid="task-edit-load-error"
                >
                    <span>{tx("detail.errors.loadFailed")}</span>
                    <Button variant="secondary" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
                        {tx("detail.status.retry")}
                    </Button>
                </div>
            )}
            {error && (
                <div className="rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error" role="alert">
                    {error}
                </div>
            )}
            {/* Auto-saved edit form (PATCH on change/blur) — no Save button.
                Disabled while the initial load has failed: `commitFields`
                early-returns until `loadedRef` is set, so editing must be
                visibly blocked (never let edits look saved when they can't be). */}
            <div className="space-y-default" data-testid="task-edit-form">
                <fieldset className="space-y-default" disabled={!canWrite || loadError}>
                    <FormField label={tx("detail.fields.title")} required>
                        <Input
                            id="task-panel-title"
                            type="text"
                            value={title}
                            onChange={(e) => update({ title: e.target.value }, false)}
                            onBlur={commitNow}
                            required
                            invalid={titleInvalid}
                        />
                    </FormField>
                    <FormField label={tx("detail.fields.description")}>
                        <Textarea
                            id="task-panel-description"
                            rows={3}
                            value={description}
                            onChange={(e) => update({ description: e.target.value }, false)}
                            onBlur={commitNow}
                        />
                    </FormField>
                    {/* Status — commits via setTaskStatus (state machine + reconciliation). */}
                    <div>
                        <label className="mb-1 block text-sm text-content-default" htmlFor="task-panel-status">{tx("detail.fields.status")}</label>
                        <Combobox
                            id="task-panel-status"
                            name="status"
                            options={STATUS_OPTIONS}
                            selected={STATUS_OPTIONS.find((o) => o.value === (pendingTerminalStatus ?? status)) ?? null}
                            setSelected={(o) => handleStatusChange(o?.value ?? status)}
                            disabled={!canWrite || loadError}
                            hideSearch
                            matchTriggerWidth
                            forceDropdown
                            buttonProps={{ className: "w-full", size: "sm" }}
                            caret
                        />
                        {pendingTerminalStatus && (
                            <div className="mt-2 space-y-tight" data-testid="task-panel-terminal-prompt">
                                <FormField label={tx("detail.fields.resolution")} required>
                                    <Textarea
                                        id="task-panel-resolution"
                                        rows={2}
                                        placeholder={tx("detail.fields.resolutionPlaceholder")}
                                        value={resolutionDraft}
                                        onChange={(e) => setResolutionDraft(e.target.value)}
                                    />
                                </FormField>
                                <div className="flex gap-tight">
                                    <Button
                                        variant="primary"
                                        size="sm"
                                        disabled={!resolutionDraft.trim() || saveState === "saving"}
                                        onClick={() => void commitStatus(pendingTerminalStatus, resolutionDraft.trim())}
                                        data-testid="task-panel-terminal-apply"
                                    >
                                        {tx("detail.status.apply")}
                                    </Button>
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        disabled={saveState === "saving"}
                                        onClick={() => {
                                            setPendingTerminalStatus(null);
                                            setResolutionDraft("");
                                        }}
                                    >
                                        {tx("detail.status.cancel")}
                                    </Button>
                                </div>
                            </div>
                        )}
                    </div>
                    <div>
                        <label className="mb-1 block text-sm text-content-default" htmlFor="task-panel-type">{tx("detail.fields.type")}</label>
                        <Combobox
                            id="task-panel-type"
                            name="type"
                            options={TYPE_OPTIONS}
                            selected={TYPE_OPTIONS.find((o) => o.value === type) ?? null}
                            setSelected={(o) => update({ type: o?.value ?? "TASK" }, true)}
                            disabled={!canWrite}
                            hideSearch
                            matchTriggerWidth
                            forceDropdown
                            buttonProps={{ className: "w-full", size: "sm" }}
                            caret
                        />
                    </div>
                    <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                        <div>
                            <label className="mb-1 block text-sm text-content-default" htmlFor="task-panel-severity">{tx("detail.fields.severity")}</label>
                            <Combobox
                                id="task-panel-severity"
                                name="severity"
                                options={SEVERITY_OPTIONS}
                                selected={SEVERITY_OPTIONS.find((o) => o.value === severity) ?? null}
                                setSelected={(o) => update({ severity: o?.value ?? "MEDIUM" }, true)}
                                disabled={!canWrite}
                                hideSearch
                                matchTriggerWidth
                                forceDropdown
                                buttonProps={{ className: "w-full", size: "sm" }}
                                caret
                            />
                        </div>
                        <div>
                            <label className="mb-1 block text-sm text-content-default" htmlFor="task-panel-priority">{tx("detail.fields.priority")}</label>
                            <Combobox
                                id="task-panel-priority"
                                name="priority"
                                options={PRIORITY_OPTIONS}
                                selected={PRIORITY_OPTIONS.find((o) => o.value === priority) ?? null}
                                setSelected={(o) => update({ priority: o?.value ?? "P2" }, true)}
                                disabled={!canWrite}
                                hideSearch
                                matchTriggerWidth
                                forceDropdown
                                buttonProps={{ className: "w-full", size: "sm" }}
                                caret
                            />
                        </div>
                    </div>
                    <FormField label={tx("detail.fields.dueDate")}>
                        <DatePicker
                            id="task-panel-due"
                            className="w-full"
                            placeholder={tx("detail.fields.selectDate")}
                            clearable
                            align="start"
                            value={parseYMD(dueAt)}
                            onChange={(next) => update({ dueAt: toYMD(next) ?? "" }, true)}
                            disabledDays={{ before: startOfUtcDay(new Date()) }}
                            aria-label={tx("detail.fields.dueDateAria")}
                        />
                    </FormField>
                    <FormField label={tx("detail.fields.assignee")} description={tx("detail.fields.ownerHint")}>
                        <UserCombobox
                            id="task-panel-assignee"
                            name="assigneeUserId"
                            tenantSlug={tenantSlug}
                            disabled={!canWrite || loadError}
                            size="sm"
                            selectedId={assigneeId || null}
                            onChange={(userId) => {
                                setAssigneeId(userId ?? "");
                                void commitAssignee(userId ?? "");
                            }}
                            placeholder={task.assignee?.name || tx("detail.fields.unassigned")}
                        />
                    </FormField>
                </fieldset>
                {canWrite && !loadError && (
                    <p
                        className="text-xs text-content-muted"
                        data-testid="task-edit-autosave-status"
                        aria-live="polite"
                    >
                        {saveState === "saving"
                            ? tx("detail.autosave.saving")
                            : saveState === "saved"
                              ? tx("detail.autosave.saved")
                              : saveState === "error"
                                ? tx("detail.autosave.notSaved")
                                : tx("detail.autosave.auto")}
                    </p>
                )}
            </div>
        </div>
    );

    // `form` variant — just the autosave field set, for the task-detail
    // edit modal. No heading / tabs / activity / evidence chrome.
    if (variant === "form") {
        return (
            <div className="space-y-default" role="region" aria-label={tx("detail.editorAria.task")} data-testid="task-edit-panel">
                {details}
            </div>
        );
    }

    return (
        <div className="space-y-default" role="region" aria-label={tx("detail.editorAria.task")} data-testid="task-edit-panel">
            <div className="flex items-center gap-tight">
                {task.key && <span className="font-mono text-xs text-content-muted">{task.key}</span>}
                <StatusBadge variant={taskStatusVariant(status)} size="sm">
                    {taskStatusLabel(status, tTask)}
                </StatusBadge>
            </div>
            <Heading level={3} className="break-words">{task.title}</Heading>

            <PanelTabs<Tab>
                tabs={[{ id: "details", label: tx("detail.tabs.details") }, { id: "activity", label: tx("detail.tabs.activity") }]}
                active={tab}
                onSelect={setTab}
            />

            {tab === "details" ? (
                <div className="space-y-default">
                    {details}
                    {/* Drag-and-drop evidence upload (canonical FileDropzone, compact in the rail). */}
                    <EvidenceUploadSection
                        tenantSlug={tenantSlug}
                        linkField="taskId"
                        linkId={task.id}
                        canWrite={canWrite}
                        compactDropzone
                        listEndpoint={`/tasks/${task.id}/evidence`}
                        urlLinkEndpoint={`/tasks/${task.id}/evidence`}
                    />
                </div>
            ) : (
                <PanelActivityFeed tenantSlug={tenantSlug} endpoint={`/tasks/${task.id}/activity`} />
            )}
        </div>
    );
}
