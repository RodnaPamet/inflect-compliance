'use client';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { DataTable, createColumns } from '@/components/ui/table';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { StatusBadge } from '@/components/ui/status-badge';

// listAuditLogs → AuditLogRepository.list (AuditLog model + user relation).
// createdAt is a string (JSON round-trip via the server page). Cell callbacks
// stay untyped (file-level disable; the colon-any category).
interface AuditLogRow {
    id: string;
    createdAt: string;
    action: string;
    entity: string;
    details: string | null;
    user: { name: string | null; email: string } | null;
}

interface AuditLogClientProps {
    auditLog: AuditLogRow[];
    translations: {
        time: string;
        user: string;
        action: string;
        entity: string;
        details: string;
        noEntries: string;
    };
}

/**
 * R13-PR10 — Audit log table extracted from the admin landing
 * (formerly the "Audit log" tab inside `AdminClient.tsx`) into a
 * dedicated page so admin landing reads as a pure pill-nav surface.
 */
export function AuditLogClient({ auditLog, translations: t }: AuditLogClientProps) {
    const tx = useTranslations('admin');
    const logColumns = useMemo(() => createColumns<AuditLogRow>([
        {
            id: 'time',
            header: t.time,
            accessorFn: (e) => e.createdAt,
            cell: ({ getValue }) => <span className="whitespace-nowrap">{formatDateTime(getValue())}</span>,
        },
        {
            id: 'user',
            header: t.user,
            accessorFn: (e) => e.user?.name || '—',
            cell: ({ getValue }) => <span>{getValue()}</span>,
        },
        {
            accessorKey: 'action',
            header: t.action,
            cell: ({ getValue }) => <StatusBadge variant="info">{getValue()}</StatusBadge>,
        },
        {
            accessorKey: 'entity',
            header: t.entity,
            cell: ({ getValue }) => <span>{getValue()}</span>,
        },
        {
            accessorKey: 'details',
            header: t.details,
            cell: ({ getValue }) => <span className="text-content-muted max-w-xs truncate">{getValue()}</span>,
        },
    ]), [t]);

    return (
        <ListPageShell.Body>
            <DataTable
                fillBody
                data={auditLog}
                columns={logColumns}
                getRowId={(e) => e.id}
                emptyState={t.noEntries}
                resourceName={(p) => (p ? tx('auditLogEntries') : tx('auditLogEntry'))}
                data-testid="audit-log-table"
            />
        </ListPageShell.Body>
    );
}
