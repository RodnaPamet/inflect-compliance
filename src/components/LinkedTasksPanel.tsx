'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useGuardedPush } from '@/lib/nav/use-guarded-push';
import { Plus } from '@inflect/ui/components/ui/icons/nucleo';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { taskStatusVariant, taskStatusLabel, taskSeverityLabels } from '@/lib/task-status-badge';
import { TASK_SEVERITY_VARIANT } from '@/app-layer/domain/entity-status-mapping';
import { DataTable, createColumns } from '@/components/ui/table';
import { TableTitleCell } from '@/components/ui/table-title-cell';
import { TimestampTooltip } from '@/components/ui/timestamp-tooltip';
// The canonical task-create modal (the SAME one the Tasks page "+ Task"
// button opens). Reused here so a task created from a control / asset /
// risk detail page is identical to a standalone task — full fields, and
// it lands in the global Tasks table (visible in the Tasks list) linked
// back to this entity via TaskLink.
import { NewTaskModal } from '@/app/t/[tenantSlug]/(app)/tasks/NewTaskModal';


// Status → badge is the shared `TASK_STATUS_BADGE` map (TP-1); severity
// → badge is the shared `TASK_SEVERITY_VARIANT` (B2-6). Neither is
// local any more: this panel's private severity copy disagreed with the
// task detail page on LOW and HIGH, so a control's linked task and that
// same task's own page showed different tones.

interface LinkedTask {
    id: string;
    key?: string | null;
    title: string;
    type?: string | null;
    status: string;
    severity?: string | null;
    dueAt?: string | null;
    updatedAt?: string | null;
    assignee?: { name?: string | null } | null;
}

interface LinkedTasksPanelProps {
    apiBase: string;
    /**
     * Domain entity the listed tasks are linked to. Drives the filter
     * query AND (when `canWrite`) the entityType passed into the create
     * modal. Canonical values: `'ASSET' | 'RISK' | 'CONTROL'`.
     */
    entityType: string;
    entityId: string;
    tenantHref: (path: string) => string;
    /**
     * The write tier. On its own it surfaces both affordances below, which is
     * what every caller did before #4415 — kept as the DEFAULT for the two
     * keys, so a caller that passes only this is unchanged.
     */
    canWrite?: boolean;
    /**
     * `tasks.create`, which is what the create affordance's POST is gated on
     * (`assertCanCreateTask`). Defaults to `canWrite`.
     *
     * Separate from the key below because the two are separately grantable: a
     * custom role may hold one without the other, and this panel offered both
     * affordances on the coarse tier alone — so such a role was shown a create
     * it would be refused, or bulk actions it would be refused (#4415).
     */
    canCreateTasks?: boolean;
    /**
     * `tasks.edit`, which is what the BULK ACTIONS behind row selection are
     * gated on (`assertCanWriteTasks`). Defaults to `canWrite`.
     */
    canEditTasks?: boolean;
}

export default function LinkedTasksPanel({
    apiBase,
    entityType,
    entityId,
    tenantHref,
    canWrite = false,
    canCreateTasks = canWrite,
    canEditTasks = canWrite,
}: LinkedTasksPanelProps) {
    const guardedPush = useGuardedPush();
    const t = useTranslations('panels');
    const tr = useTranslations();
    const tTasks = useTranslations('tasks');
    const TYPE_LABELS = useMemo<Record<string, string>>(() => ({
        AUDIT_FINDING: tr('tasks.typeLabels.AUDIT_FINDING'), CONTROL_GAP: tr('tasks.typeLabels.CONTROL_GAP'),
        INCIDENT: tr('tasks.typeLabels.INCIDENT'), IMPROVEMENT: tr('tasks.typeLabels.IMPROVEMENT'),
        TASK: tr('tasks.typeLabels.TASK'),
    }), [tr]);
    // The same helper the Tasks list and the task detail page use, so all
    // three read one set of strings (`tasks.filterEnums.severity.*`).
    const SEVERITY_LABELS = useMemo<Record<string, string>>(() => taskSeverityLabels(tTasks), [tTasks]);
    const [tasks, setTasks] = useState<LinkedTask[]>([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);

    const loadTasks = useCallback(async () => {
        setLoading(true);
        try {
            // `apiBase` is `apiUrl('')` (trailing slash). Strip it so the
            // request stays same-origin (see prior //tasks 308 bug).
            const base = apiBase.replace(/\/+$/, '');
            const res = await fetch(
                `${base}/tasks?linkedEntityType=${encodeURIComponent(entityType)}&linkedEntityId=${encodeURIComponent(entityId)}`,
            );
            const data: unknown = res.ok ? await res.json() : { rows: [] };
            if (Array.isArray(data)) setTasks(data as LinkedTask[]);
            else if (
                data &&
                typeof data === 'object' &&
                Array.isArray((data as { rows?: unknown }).rows)
            ) {
                setTasks((data as { rows: LinkedTask[] }).rows);
            } else setTasks([]);
        } catch {
            setTasks([]);
        } finally {
            setLoading(false);
        }
    }, [apiBase, entityType, entityId]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void loadTasks();
    }, [loadTasks]);

    const canonicalEntityType: 'ASSET' | 'RISK' | 'CONTROL' | null =
        entityType === 'ASSET' ||
        entityType === 'RISK' ||
        entityType === 'CONTROL'
            ? entityType
            : null;
    // `tasks.create`, not the coarse tier: the create modal POSTs a task and
    // the server asks that key (#4415).
    const showCreate = canCreateTasks && canonicalEntityType !== null;

    // Columns mirror the Tasks page table so this tab reads identically.
    const columns = useMemo(
        () =>
            createColumns<LinkedTask>([
                {
                    id: 'title',
                    header: t('col.title'),
                    accessorFn: (t) => t.title,
                    // Title is a link to the task detail page — same UX
                    // as the global Tasks table. Normal truncation so a
                    // long name can't overrun the next column.
                    cell: ({ row }) => (
                        <TableTitleCell
                            href={tenantHref(`/tasks/${row.original.id}`)}
                        >
                            {row.original.title}
                        </TableTitleCell>
                    ),
                },
                {
                    id: 'type',
                    header: t('col.type'),
                    accessorFn: (t) => t.type ?? '',
                    cell: ({ getValue }) => (
                        <span className="text-xs text-content-muted">
                            {TYPE_LABELS[getValue<string>()] || getValue<string>() || '—'}
                        </span>
                    ),
                },
                {
                    id: 'severity',
                    header: t('col.severity'),
                    accessorFn: (t) => t.severity ?? '',
                    cell: ({ row }) =>
                        row.original.severity ? (
                            <StatusBadge
                                variant={TASK_SEVERITY_VARIANT[row.original.severity] || 'neutral'}
                            >
                                {SEVERITY_LABELS[row.original.severity] ?? row.original.severity}
                            </StatusBadge>
                        ) : (
                            <span className="text-content-subtle">—</span>
                        ),
                },
                {
                    id: 'status',
                    header: t('col.status'),
                    accessorFn: (t) => t.status,
                    cell: ({ row }) => (
                        <StatusBadge
                            variant={taskStatusVariant(row.original.status)}
                        >
                            {taskStatusLabel(row.original.status, tTasks)}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'assignee',
                    header: t('col.assignee'),
                    accessorFn: (t) => t.assignee?.name || '—',
                    cell: ({ getValue }) => (
                        <span className="text-xs text-content-muted">
                            {getValue<string>()}
                        </span>
                    ),
                },
                {
                    id: 'dueAt',
                    header: t('col.dueDate'),
                    cell: ({ row }) => (
                        <TimestampTooltip
                            date={row.original.dueAt ?? null}
                            className="text-xs text-content-muted"
                        />
                    ),
                },
            ]),
        [tenantHref, t, tTasks, TYPE_LABELS, SEVERITY_LABELS],
    );

    return (
        <div className="space-y-default">
            {showCreate && (
                <>
                    <div className="flex justify-end">
                        <Button
                            variant="primary"
                            size="sm"
                            onClick={() => setCreating(true)}
                            id="linked-task-create-btn"
                            data-testid="linked-task-create-btn"
                            text={t('linkedTasks.task')}
                            icon={<Plus className="size-4" aria-hidden="true" />}
                        />
                    </div>
                    <NewTaskModal
                        open={creating}
                        setOpen={setCreating}
                        initialPendingLinks={[
                            {
                                entityType: canonicalEntityType,
                                entityId,
                            },
                        ]}
                        onCreated={() => void loadTasks()}
                    />
                </>
            )}

            <DataTable<LinkedTask>
                data={tasks}
                columns={columns}
                getRowId={(t) => t.id}
                loading={loading}
                // Same UX as the global Tasks table: row select +
                // navigate to the full task detail page on click.
                // Selection is what reveals the bulk actions, and those ask
                // `tasks.edit` (#4415).
                selectionEnabled={canEditTasks}
                onRowClick={(row) =>
                    guardedPush(tenantHref(`/tasks/${row.original.id}`))
                }
                resourceName={(plural) => (plural ? 'tasks' : 'task')}
                emptyState={t('linkedTasks.empty')}
                data-testid="linked-tasks-table"
            />
        </div>
    );
}
