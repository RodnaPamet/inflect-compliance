'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useGuardedPush } from '@/lib/nav/use-guarded-push';
import { useTranslations } from 'next-intl';
import type { ColumnDef } from '@/components/ui/table';

import { DataTable, createColumns, TableEmptyState } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Heading } from '@/components/ui/typography';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { LazyDatePicker } from './LazyDatePicker';
import { parseYMD, toYMD } from '@/components/ui/date-picker/date-utils';
import { formatDate } from '@inflect/ui/lib/format-date';
import { apiErrorMessage } from '@/lib/api-error';
import { useHydratedNow } from '@/lib/hooks/use-hydrated-now';

type Row = {
    id: string;
    title: string;
    status: string;
    ownerUserId: string | null;
    ownerName: string | null;
    targetDate: string | null;
    manualProgressPercent: number | null;
    linkCount: number;
    tenantSpan: number;
};

const STATUS_VARIANT: Record<string, 'neutral' | 'info' | 'warning' | 'error' | 'success'> = {
    PLANNED: 'neutral',
    IN_PROGRESS: 'info',
    BLOCKED: 'error',
    COMPLETED: 'success',
    CANCELLED: 'neutral',
};
const STATUS_LABEL_KEY: Record<string, string> = {
    PLANNED: 'widgets.statusPlanned',
    IN_PROGRESS: 'widgets.statusInProgress',
    BLOCKED: 'widgets.statusBlocked',
    COMPLETED: 'widgets.statusCompleted',
    CANCELLED: 'widgets.statusCancelled',
};

/** A person the owner can be: a member of the organization. */
export type MemberOption = { id: string; label: string };

/**
 * Blocked, or past its target date while still open. The clock is the
 * hydrated `now` (#4851): reading `Date.now()` during render gave the server
 * and the browser different answers. Before hydration only a blocked
 * initiative reads at risk.
 */
function atRisk(r: Row, now: Date | null): boolean {
    if (r.status === 'BLOCKED') return true;
    if (!now || !r.targetDate || r.status === 'COMPLETED' || r.status === 'CANCELLED') return false;
    return new Date(r.targetDate).getTime() < now.getTime();
}

export function InitiativesClient({
    orgSlug,
    canManage,
    members,
    initiatives,
}: {
    orgSlug: string;
    canManage: boolean;
    members: MemberOption[];
    initiatives: Row[];
}) {
    const router = useRouter();
    const guardedPush = useGuardedPush();
    const t = useTranslations('org');
    const now = useHydratedNow();
    const [createOpen, setCreateOpen] = useState(false);

    const columns = useMemo(
        () =>
            createColumns<Row>([
                {
                    accessorKey: 'title',
                    header: t('initiatives.colInitiative'),
                    cell: ({ row }) => <span className="font-medium">{row.original.title}</span>,
                },
                {
                    accessorKey: 'status',
                    header: t('initiatives.colStatus'),
                    cell: ({ row }) => (
                        <StatusBadge variant={STATUS_VARIANT[row.original.status] ?? 'neutral'} size="sm">
                            {STATUS_LABEL_KEY[row.original.status]
                                ? t(STATUS_LABEL_KEY[row.original.status])
                                : row.original.status}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'owner',
                    header: t('initiatives.colOwner'),
                    cell: ({ row }) =>
                        row.original.ownerName ? (
                            <span className="text-content-default">{row.original.ownerName}</span>
                        ) : (
                            <span className="text-content-muted text-xs">{t('initiatives.noOwner')}</span>
                        ),
                },
                {
                    id: 'risk',
                    header: t('initiatives.colRisk'),
                    cell: ({ row }) =>
                        atRisk(row.original, now) ? (
                            <StatusBadge variant="warning" size="sm">{t('initiatives.atRisk')}</StatusBadge>
                        ) : (
                            <span className="text-content-muted text-xs">—</span>
                        ),
                },
                {
                    id: 'linked',
                    header: t('initiatives.colLinkedWork'),
                    cell: ({ row }) => (
                        <span className="text-content-muted tabular-nums">
                            {row.original.linkCount}
                            {row.original.tenantSpan > 0
                                ? t('initiatives.tenantSpan', { count: row.original.tenantSpan })
                                : ''}
                        </span>
                    ),
                },
                {
                    accessorKey: 'targetDate',
                    header: t('initiatives.colTarget'),
                    cell: ({ row }) =>
                        row.original.targetDate ? (
                            <span className="text-content-muted">{formatDate(new Date(row.original.targetDate))}</span>
                        ) : (
                            <span className="text-content-muted text-xs">—</span>
                        ),
                },
            ]),
        [t, now],
    );

    return (
        <div className="space-y-section p-4">
            <div className="flex items-center justify-between gap-compact flex-wrap">
                <Heading level={1}>{t('initiatives.title')}</Heading>
                {canManage && (
                    <Button variant="primary" onClick={() => setCreateOpen(true)}>
                        {t('initiatives.newInitiative')}
                    </Button>
                )}
            </div>

            <DataTable
                data={initiatives}
                columns={columns}
                getRowId={(r) => r.id}
                onRowClick={(r) => guardedPush(`/org/${orgSlug}/initiatives/${r.id}`)}
                resourceName={(plural) => (plural ? t('initiatives.resourceMany') : t('initiatives.resourceOne'))}
                emptyState={
                    <TableEmptyState
                        title={t('initiatives.emptyTitle')}
                        description={canManage ? t('initiatives.emptyDescManage') : t('initiatives.emptyDescRead')}
                    />
                }
                data-testid="org-initiatives-table"
            />

            {createOpen && (
                <CreateInitiativeModal
                    orgSlug={orgSlug}
                    members={members}
                    onClose={() => setCreateOpen(false)}
                    onCreated={(id) => router.push(`/org/${orgSlug}/initiatives/${id}`)}
                />
            )}
        </div>
    );
}

function CreateInitiativeModal({
    orgSlug,
    members,
    onClose,
    onCreated,
}: {
    orgSlug: string;
    members: MemberOption[];
    onClose: () => void;
    onCreated: (id: string) => void;
}) {
    const t = useTranslations('org');
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [ownerUserId, setOwnerUserId] = useState<string>('');
    const [targetDate, setTargetDate] = useState<string>('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const ownerOptions = useMemo<ComboboxOption[]>(
        () => members.map((m) => ({ value: m.id, label: m.label })),
        [members],
    );

    const save = async () => {
        if (!title.trim()) {
            setError(t('initiatives.titleRequired'));
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(`/api/org/${orgSlug}/initiatives`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title,
                    description: description || null,
                    ownerUserId: ownerUserId || null,
                    targetDate: targetDate || null,
                }),
            });
            if (!res.ok) {
                // The server's reason when it gives one (#4851), not a fixed
                // sentence that hides why.
                const body = await res.json().catch(() => ({}));
                setError(apiErrorMessage(body, t('initiatives.failedCreate')));
                return;
            }
            const data = await res.json();
            onCreated(data.initiative.id);
        } catch {
            setError(t('initiatives.failedCreate'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal showModal setShowModal={(o) => (o ? null : onClose())}>
            <Modal.Header title={t('initiatives.createModalTitle')} />
            <Modal.Body>
                <div className="space-y-default" data-testid="org-initiative-create-form">
                    <FormField label={t('initiatives.titleLabel')} required>
                        <Input
                            id="org-initiative-title"
                            maxLength={200}
                            value={title}
                            placeholder={t('initiatives.titlePlaceholder')}
                            onChange={(e) => setTitle(e.target.value)}
                        />
                    </FormField>
                    <FormField label={t('initiatives.descriptionLabel')}>
                        <Textarea
                            id="org-initiative-description"
                            rows={3}
                            maxLength={8000}
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                        />
                    </FormField>
                    <FormField label={t('initiatives.ownerLabel')} description={t('initiatives.ownerHint')}>
                        <Combobox
                            id="org-initiative-owner"
                            options={ownerOptions}
                            selected={ownerOptions.find((o) => o.value === ownerUserId) ?? null}
                            setSelected={(opt) => setOwnerUserId(opt?.value ?? '')}
                            placeholder={t('initiatives.noOwner')}
                            matchTriggerWidth
                            buttonProps={{ className: 'w-full' }}
                        />
                    </FormField>
                    <FormField label={t('initiatives.targetLabel')} description={t('initiatives.targetHint')}>
                        <LazyDatePicker
                            id="org-initiative-target"
                            className="w-full"
                            clearable
                            align="start"
                            value={parseYMD(targetDate)}
                            onChange={(next) => setTargetDate(toYMD(next) ?? '')}
                            aria-label={t('initiatives.targetLabel')}
                        />
                    </FormField>
                    {error && (
                        <p className="text-sm text-content-error" role="alert" data-testid="org-initiative-create-error">
                            {error}
                        </p>
                    )}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Modal.Actions>
                    <Button variant="ghost" onClick={onClose} disabled={saving}>
                        {t('common.cancel')}
                    </Button>
                    <Button variant="primary" onClick={save} disabled={saving} loading={saving} id="org-initiative-create-submit">
                        {t('initiatives.createInitiative')}
                    </Button>
                </Modal.Actions>
            </Modal.Footer>
        </Modal>
    );
}
