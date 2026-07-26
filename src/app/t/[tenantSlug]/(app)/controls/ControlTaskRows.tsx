"use client";

/**
 * Controls — inline task rows rendered under an expanded control row.
 *
 * These are REAL `<tr>`/`<td>` rows (rendered via the DataTable
 * `renderAlignedSubRows` slot as direct `<tbody>` siblings), NOT a colSpan
 * blob — so the browser's table layout aligns each task's cells under the
 * parent CONTROL columns. A task surfaces, in the matching columns:
 *   - name      → the task title (indented to read as a child)
 *   - category  → the parent control's category (inherited; tasks have none)
 *   - status    → the task's own status (StatusBadge, same `sm` size)
 *   - owner     → the task's assignee (avatar initial + name)
 *   - evidence  → the task's linked-evidence count (icon + count, via the
 *                 `renderEvidence` render-prop so the glyph matches the
 *                 control row's Evidence cell exactly)
 * Every other column renders an empty cell. These are display-only — the list
 * filter targets controls, not these sub-rows.
 *
 * Mounts only when the control row is expanded, so the fetch is lazy.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { StatusBadge } from "@/components/ui/status-badge";
import { taskStatusVariant, taskStatusLabel } from "@/lib/task-status-badge";

export interface ControlTask {
    id: string;
    key?: string;
    title: string;
    status: string;
    severity?: string | null;
    assignee?: { name?: string | null } | null;
    /** Linked-evidence count (from the task list `_count.evidence`). */
    _count?: { evidence?: number } | null;
}

export function ControlTaskRows({
    tenantSlug,
    controlId,
    controlCategory,
    columnIds,
    renderEvidence,
    onTaskClick,
    refreshToken,
}: {
    tenantSlug: string;
    controlId: string;
    /**
     * The parent control's category — tasks have no category of their own, so
     * the row INHERITS and displays the control's, as a tag in the Category
     * column. Display-only (not a filter dimension).
     */
    controlCategory?: string | null;
    /** Ordered visible column ids of the parent table — one `<td>` per id. */
    columnIds: string[];
    /**
     * Renders the Evidence cell content for a given count. Supplied by the
     * control page so the icon + colour match the control row's Evidence cell
     * exactly (keeps the lucide import on the page, not here).
     */
    renderEvidence?: (count: number) => ReactNode;
    /** Whole-row click → task quick-view in the side panel. */
    onTaskClick?: (task: ControlTask) => void;
    /**
     * Monotonic refresh token. The fetch keys on `[tenantSlug, controlId]`,
     * which never change while a task is edited in the side-panel quick-view —
     * so without this the sub-row keeps stale title/status/owner/evidence after
     * a save. The parent bumps this (in its post-save handler) to force a
     * refetch, mirroring the `reloadKey`-in-deps revalidation the edit panels
     * use. Absent/unchanged ⇒ no extra fetch (backwards-compatible default).
     */
    refreshToken?: number;
}) {
    const tx = useTranslations("controls");
    const tTask = useTranslations("tasks");
    const [tasks, setTasks] = useState<ControlTask[] | null>(null);
    const [error, setError] = useState(false);

    useEffect(() => {
        let active = true;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setTasks(null);
        setError(false);
        fetch(
            `/api/t/${tenantSlug}/tasks?linkedEntityType=CONTROL&linkedEntityId=${encodeURIComponent(controlId)}`,
        )
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load failed"))))
            .then((data) => {
                if (!active) return;
                const rows: ControlTask[] = Array.isArray(data) ? data : (data?.rows ?? []);
                setTasks(rows);
            })
            .catch(() => active && setError(true));
        return () => {
            active = false;
        };
    }, [tenantSlug, controlId, refreshToken]);

    // First non-utility column carries the (indented) task title.
    const firstContentId = columnIds.find((id) => id !== "select" && id !== "menu");

    // A single full-width message row (loading / error / empty) spanning every
    // column so it sits cleanly under the control.
    const messageRow = (text: string, tone: string) => (
        <tr className="bg-bg-subtle/30" data-control-task-rows={controlId}>
            <td colSpan={columnIds.length} className={`border-b border-border-subtle px-4 py-2 pl-12 text-xs ${tone}`}>
                {text}
            </td>
        </tr>
    );

    if (error) return messageRow(tx("detail.taskRows.error"), "text-content-error");
    if (tasks === null) return messageRow(tx("detail.taskRows.loading"), "text-content-subtle animate-pulse");
    if (tasks.length === 0) return messageRow(tx("detail.taskRows.empty"), "text-content-subtle");

    const cellFor = (columnId: string, t: ControlTask): ReactNode => {
        switch (columnId) {
            case firstContentId:
                // Task title, indented to read as a child of the control.
                return (
                    <span className="block truncate pl-6 text-sm text-content-default transition-colors group-hover/subrow:text-[var(--brand-default)]">
                        {t.title}
                    </span>
                );
            case "category":
                return controlCategory ? (
                    <StatusBadge size="sm">{controlCategory}</StatusBadge>
                ) : (
                    <span className="text-xs text-content-subtle">—</span>
                );
            case "status":
                return (
                    <StatusBadge variant={taskStatusVariant(t.status)} size="sm">
                        {taskStatusLabel(t.status, tTask)}
                    </StatusBadge>
                );
            case "owner": {
                const name = t.assignee?.name;
                if (!name) return <span className="text-xs text-content-subtle">—</span>;
                const initial = name.charAt(0).toUpperCase();
                return (
                    <span className="inline-flex items-center gap-1.5">
                        <span
                            aria-hidden
                            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bg-elevated text-[10px] font-medium text-content-emphasis"
                        >
                            {initial}
                        </span>
                        <span className="block truncate text-xs text-content-emphasis leading-tight">
                            {name}
                        </span>
                    </span>
                );
            }
            case "evidence": {
                const n = t._count?.evidence ?? 0;
                return renderEvidence ? renderEvidence(n) : <span className="text-xs text-content-subtle">{n}</span>;
            }
            default:
                return null; // utility / non-surfaced column → empty cell
        }
    };

    return (
        <>
            {tasks.map((t) => (
                <tr
                    key={t.id}
                    data-control-task={t.id}
                    data-task-quickview={t.id}
                    onClick={onTaskClick ? () => onTaskClick(t) : undefined}
                    className={`group/subrow bg-bg-subtle/30 ${onTaskClick ? "cursor-pointer hover:bg-bg-muted/50" : ""} transition-colors`}
                >
                    {columnIds.map((columnId) => {
                        const isUtility = columnId === "select" || columnId === "menu";
                        return (
                            <td
                                key={columnId}
                                className={`border-b border-border-subtle align-middle ${isUtility ? "px-1 py-2" : "px-4 py-2"}`}
                            >
                                {cellFor(columnId, t)}
                            </td>
                        );
                    })}
                </tr>
            ))}
        </>
    );
}
