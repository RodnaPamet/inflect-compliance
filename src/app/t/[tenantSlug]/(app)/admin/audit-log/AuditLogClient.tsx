'use client';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import Link from 'next/link';
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { DataTable, createColumns } from '@/components/ui/table';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { StatusBadge } from '@/components/ui/status-badge';
import { buttonVariants } from '@/components/ui/button-variants';

// listAuditLogPage → AuditLogRepository.listPage, projected by the server page
// to what the table shows. createdAt is an ISO string.
export interface AuditLogRow {
    id: string;
    createdAt: string;
    action: string;
    entity: string;
    details: string | null;
    userName: string | null;
}

interface AuditLogClientProps {
    auditLog: AuditLogRow[];
    /** The next (older) page, or null when this page holds the oldest entry. */
    olderHref: string | null;
    /** The first (newest) page, or null when this IS the first page. */
    newestHref: string | null;
    translations: {
        time: string;
        user: string;
        action: string;
        entity: string;
        details: string;
        noEntries: string;
        older: string;
        newest: string;
        pages: string;
    };
}

/**
 * R13-PR10 — Audit log table extracted from the admin landing
 * (formerly the "Audit log" tab inside `AdminClient.tsx`) into a
 * dedicated page so admin landing reads as a pure pill-nav surface.
 */
export function AuditLogClient({ auditLog, olderHref, newestHref, translations: t }: AuditLogClientProps) {
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
            accessorFn: (e) => e.userName || '—',
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
            {olderHref !== null || newestHref !== null ? (
                <nav aria-label={t.pages} className="mt-3 flex justify-center gap-tight" id="audit-log-pages">
                    {newestHref !== null ? (
                        <Link
                            href={newestHref}
                            id="audit-log-newest"
                            className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                        >
                            {t.newest}
                        </Link>
                    ) : null}
                    {olderHref !== null ? (
                        <Link
                            href={olderHref}
                            id="audit-log-older"
                            className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                        >
                            {t.older}
                        </Link>
                    ) : null}
                </nav>
            ) : null}
        </ListPageShell.Body>
    );
}
