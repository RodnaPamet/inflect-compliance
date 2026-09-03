'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { DataTable } from '@/components/ui/table';
import type { ColumnDef } from '@/components/ui/table';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { formatDate } from '@/lib/format-date';

export interface MembersTableRow {
    id: string;
    name: string | null;
    email: string;
    role: string;
    createdAtIso: string;
}

interface MembersTableProps {
    members: MembersTableRow[];
}

const ROLE_TONE: Record<string, StatusBadgeVariant> = {
    OWNER: 'error',
    ADMIN: 'error',
    EDITOR: 'info',
    AUDITOR: 'warning',
    READER: 'neutral',
};

export function MembersTable({ members }: MembersTableProps) {
    const t = useTranslations('admin');
    const columns = useMemo<ColumnDef<MembersTableRow>[]>(
        () => [
            {
                id: 'name',
                header: t('rbac.colName'),
                accessorKey: 'name',
                cell: ({ getValue }) => (
                    <span className="text-sm font-medium text-content-emphasis">
                        {(getValue() as string | null) || '—'}
                    </span>
                ),
            },
            {
                id: 'email',
                header: t('rbac.colEmail'),
                accessorKey: 'email',
                cell: ({ getValue }) => (
                    <span className="text-content-muted">
                        {getValue() as string}
                    </span>
                ),
            },
            {
                id: 'role',
                header: t('rbac.colRole'),
                accessorKey: 'role',
                cell: ({ getValue }) => {
                    const role = getValue() as string;
                    return (
                        <StatusBadge variant={ROLE_TONE[role] ?? 'neutral'}>
                            {role}
                        </StatusBadge>
                    );
                },
            },
            {
                id: 'joined',
                header: t('rbac.colJoined'),
                accessorKey: 'createdAtIso',
                cell: ({ getValue }) => (
                    <span className="text-content-subtle whitespace-nowrap">
                        {formatDate(getValue() as string)}
                    </span>
                ),
            },
        ],
        [t],
    );

    return (
        <DataTable
            data={members}
            columns={columns}
            getRowId={(m) => m.id}
            emptyState={t('rbac.emptyMembers')}
            resourceName={(p) => (p ? t('rbac.membersPlural') : t('rbac.memberSingular'))}
            data-testid="rbac-members-table"
        />
    );
}
