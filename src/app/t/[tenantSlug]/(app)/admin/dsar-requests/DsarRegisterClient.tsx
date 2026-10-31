'use client';

/**
 * The data subject request register (#4818).
 *
 * A register, not an engine: nothing here exports or erases anything. A person
 * records a request that arrived by email, post or a support ticket, then moves
 * it through its statuses as the work is done out of band. Until #4818 the page
 * could do neither: it listed requests and offered no way to record or advance
 * one, though `POST` and `PATCH /admin/dsar-requests` existed.
 *
 * The statuses a request can move to are read from `DSAR_TRANSITIONS`, the
 * table the server checks, so the page never offers a move the server refuses.
 * A rejection needs one of the server's fixed reasons, offered as a choice.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, UserFocus } from '@inflect/ui/components/ui/icons/nucleo';
import { formatDate } from '@inflect/ui/lib/format-date';

import { EntityListPage } from '@/components/layout/EntityListPage';
import { FilterProvider, useFilterContext, useFilters } from '@/components/ui/filter';
import { createColumns } from '@/components/ui/table';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { TruncationBanner } from '@/components/ui/TruncationBanner';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Sheet } from '@/components/ui/sheet';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { UserCombobox } from '@/components/ui/user-combobox';
import { useToast } from '@/components/ui/hooks';
import { apiRefusalMessage } from '@/lib/api-error';
import { DSAR_REGISTER_CAP, DSAR_REJECTION_REASONS, type DsarRejectionReason } from '@/lib/dsar';
import { DSAR_TRANSITIONS } from '@/app-layer/domain/dsar-status';
import { useTenantHref } from '@/lib/tenant-context-provider';

import { buildDsarFilters, DSAR_FILTER_KEYS, type DsarFilterLabels } from './filter-defs';

export interface DsarRow {
    id: string;
    type: 'EXPORT' | 'ERASURE';
    status: 'RECEIVED' | 'VERIFIED' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED' | 'CANCELED';
    subject: { id: string; email: string | null; name: string | null };
    requestedAt: string;
    verifiedAt: string | null;
    completedAt: string | null;
    rejectionReason: string | null;
    fulfilmentNotes: string | null;
    handledBy: { id: string; name: string | null } | null;
}

const STATUS_TONE: Record<DsarRow['status'], StatusBadgeVariant> = {
    RECEIVED: 'warning',
    VERIFIED: 'info',
    IN_PROGRESS: 'info',
    COMPLETED: 'success',
    REJECTED: 'error',
    CANCELED: 'neutral',
};

const REJECTION_REASONS = Object.values(DSAR_REJECTION_REASONS) as DsarRejectionReason[];

interface Props {
    tenantSlug: string;
    initial: DsarRow[];
    canManage: boolean;
    title: string;
    /** The register holds more than `DSAR_REGISTER_CAP` requests. */
    truncated?: boolean;
}

/** The server's reason for a 4xx, or the fallback for anything else. */
async function refusalOf(res: Response, fallback: string): Promise<string> {
    if (res.status >= 500) return fallback;
    const body: unknown = await res.json().catch(() => null);
    return apiRefusalMessage(body, fallback);
}

const subjectLabel = (s: DsarRow['subject']) => s.name ?? s.email ?? s.id;

/** The filter labels, each key spelled here so the i18n guard can bind it. */
function useDsarFilterLabels(): DsarFilterLabels {
    const tLabels = useTranslations('admin');
    const tGroup = useTranslations('common.filterGroups');
    return useMemo(
        () => ({
            group: tGroup('attributes'),
            status: tLabels('dsar.filters.status'),
            statusDesc: tLabels('dsar.filters.statusDesc'),
            statusOptions: {
                RECEIVED: tLabels('dsar.status.RECEIVED'),
                VERIFIED: tLabels('dsar.status.VERIFIED'),
                IN_PROGRESS: tLabels('dsar.status.IN_PROGRESS'),
                COMPLETED: tLabels('dsar.status.COMPLETED'),
                REJECTED: tLabels('dsar.status.REJECTED'),
                CANCELED: tLabels('dsar.status.CANCELED'),
            },
            type: tLabels('dsar.filters.type'),
            typeDesc: tLabels('dsar.filters.typeDesc'),
            typeOptions: { EXPORT: tLabels('dsar.type.EXPORT'), ERASURE: tLabels('dsar.type.ERASURE') },
        }),
        [tLabels, tGroup],
    );
}

export function DsarRegisterClient(props: Props) {
    const labels = useDsarFilterLabels();
    const filters = useMemo(() => buildDsarFilters(labels), [labels]);
    const filterCtx = useFilterContext(filters, [...DSAR_FILTER_KEYS]);
    return (
        <FilterProvider value={filterCtx}>
            <DsarRegisterInner {...props} />
        </FilterProvider>
    );
}

function DsarRegisterInner({ tenantSlug, initial, canManage, title, truncated = false }: Props) {
    const t = useTranslations('admin');
    const labels = useDsarFilterLabels();
    const tenantHref = useTenantHref();
    const toast = useToast();
    const [rows, setRows] = useState<DsarRow[]>(initial);
    const [openId, setOpenId] = useState<string | null>(null);
    const [recording, setRecording] = useState(false);

    const filterDefs = useMemo(() => buildDsarFilters(labels), [labels]);
    const { state, hasActive, search } = useFilters();
    const term = search.trim().toLowerCase();

    const visible = useMemo(() => {
        const statuses = (state.status ?? []) as string[];
        const types = (state.type ?? []) as string[];
        return rows.filter((r) => {
            if (statuses.length && !statuses.includes(r.status)) return false;
            if (types.length && !types.includes(r.type)) return false;
            if (!term) return true;
            return [r.subject.name, r.subject.email].some((v) => v != null && v.toLowerCase().includes(term));
        });
    }, [rows, state.status, state.type, term]);

    const columns = useMemo(
        () =>
            createColumns<DsarRow>([
                {
                    id: 'subject',
                    header: t('dsar.col.subject'),
                    accessorFn: (r) => subjectLabel(r.subject),
                    cell: ({ row }) => (
                        <span className="text-sm" data-testid={`dsar-subject-${row.original.id}`}>
                            {subjectLabel(row.original.subject)}
                        </span>
                    ),
                },
                {
                    id: 'type',
                    header: t('dsar.col.type'),
                    accessorKey: 'type',
                    cell: ({ row }) => (
                        <StatusBadge variant={row.original.type === 'ERASURE' ? 'warning' : 'info'}>
                            {t(`dsar.type.${row.original.type}`)}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'status',
                    header: t('dsar.col.status'),
                    accessorKey: 'status',
                    cell: ({ row }) => (
                        <StatusBadge variant={STATUS_TONE[row.original.status]}>
                            {t(`dsar.status.${row.original.status}`)}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'requestedAt',
                    header: t('dsar.col.requested'),
                    accessorKey: 'requestedAt',
                    cell: ({ row }) => (
                        <span className="text-sm text-content-muted">{formatDate(row.original.requestedAt)}</span>
                    ),
                },
                {
                    id: 'handledBy',
                    header: t('dsar.col.handledBy'),
                    accessorFn: (r) => r.handledBy?.name ?? '',
                    cell: ({ row }) => (
                        <span className="text-sm text-content-muted">{row.original.handledBy?.name ?? '—'}</span>
                    ),
                },
            ]),
        [t],
    );

    const open = rows.find((r) => r.id === openId) ?? null;
    const replace = (updated: DsarRow) => setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));

    return (
        <EntityListPage<DsarRow>
            header={{
                breadcrumbs: [
                    { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                    { label: t('title'), href: tenantHref('/admin') },
                    { label: title },
                ],
                back: { smart: true },
                title: (
                    <>
                        <UserFocus className="mr-2 inline-block h-5 w-5 align-text-bottom" />
                        {title}
                    </>
                ),
                actions: canManage ? (
                    <Button variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setRecording(true)} id="dsar-record-btn">
                        {t('dsar.record.button')}
                    </Button>
                ) : undefined,
            }}
            filters={{ defs: filterDefs, searchId: 'dsar-search', searchPlaceholder: t('dsar.searchPlaceholder') }}
            banner={
                <div className="space-y-default">
                    {/* The load-bearing disclosure. Marking a request Completed
                        records that a person did the work out of band. */}
                    <InlineNotice variant="info" title={t('dsar.manualTitle')}>
                        {t('dsar.manualBody')}
                    </InlineNotice>
                    {!canManage && <InlineNotice variant="info">{t('dsar.readOnlyNotice')}</InlineNotice>}
                    <TruncationBanner truncated={truncated} cap={DSAR_REGISTER_CAP} />
                </div>
            }
            table={{
                data: visible,
                columns,
                getRowId: (r) => r.id,
                onRowClick: (row) => setOpenId(row.original.id),
                selectionEnabled: false,
                resourceName: (plural) => (plural ? t('dsar.resourcePlural') : t('dsar.resourceSingular')),
                'data-testid': 'dsar-requests-table',
                emptyState: (
                    <EmptyState
                        icon={UserFocus}
                        title={hasActive || term ? t('dsar.emptyMatchingTitle') : t('dsar.emptyTitle')}
                        description={hasActive || term ? t('dsar.emptyMatchingDesc') : t('dsar.emptyDesc')}
                    />
                ),
            }}
        >
            {recording && (
                <RecordRequestModal
                    tenantSlug={tenantSlug}
                    onClose={() => setRecording(false)}
                    onRecorded={(row) => {
                        setRows((prev) => [row, ...prev]);
                        setRecording(false);
                        toast.success(t('dsar.record.recorded'));
                    }}
                />
            )}
            <RequestSheet
                key={open?.id ?? 'none'}
                tenantSlug={tenantSlug}
                row={open}
                canManage={canManage}
                onClose={() => setOpenId(null)}
                onUpdated={(row) => {
                    replace(row);
                    toast.success(t('dsar.detail.updated'));
                }}
            />
        </EntityListPage>
    );
}

function RecordRequestModal({
    tenantSlug,
    onClose,
    onRecorded,
}: {
    tenantSlug: string;
    onClose: () => void;
    onRecorded: (row: DsarRow) => void;
}) {
    const tRecord = useTranslations('admin');
    const [userId, setUserId] = useState<string | null>(null);
    const [type, setType] = useState<DsarRow['type']>('EXPORT');
    const [notes, setNotes] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function submit() {
        if (!userId) return;
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(`/api/t/${tenantSlug}/admin/dsar-requests`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, type, notes: notes.trim() || null }),
            });
            if (!res.ok) {
                setError(await refusalOf(res, tRecord('dsar.record.failed')));
                return;
            }
            onRecorded((await res.json()) as DsarRow);
        } catch {
            setError(tRecord('dsar.record.failed'));
        } finally {
            setSaving(false);
        }
    }

    return (
        <Modal showModal setShowModal={(v) => { if (!v && !saving) onClose(); }} size="md" preventDefaultClose={saving}>
            <Modal.Header title={tRecord('dsar.record.title')} description={tRecord('dsar.record.description')} />
            <Modal.Body>
                <div className="space-y-default">
                    {error && <InlineNotice variant="error" icon={null}><span data-testid="dsar-record-error">{error}</span></InlineNotice>}
                    <FormField label={tRecord('dsar.record.subject')} required>
                        <UserCombobox
                            tenantSlug={tenantSlug}
                            id="dsar-record-subject"
                            selectedId={userId}
                            onChange={(id) => setUserId(id)}
                            placeholder={tRecord('dsar.record.subjectPlaceholder')}
                        />
                    </FormField>
                    <FormField label={tRecord('dsar.record.type')} required>
                        <RadioGroup
                            value={type}
                            onValueChange={(v) => setType(v as DsarRow['type'])}
                            aria-label={tRecord('dsar.record.type')}
                            className="space-y-1.5"
                        >
                            {(['EXPORT', 'ERASURE'] as const).map((value) => (
                                <label key={value} htmlFor={`dsar-record-type-${value}`} className="flex items-center gap-compact text-sm">
                                    <RadioGroupItem id={`dsar-record-type-${value}`} value={value} size="sm" />
                                    {tRecord(`dsar.type.${value}`)}
                                </label>
                            ))}
                        </RadioGroup>
                    </FormField>
                    <FormField label={tRecord('dsar.record.notes')} description={tRecord('dsar.record.notesHint')}>
                        <Textarea id="dsar-record-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="w-full" />
                    </FormField>
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
                    {tRecord('dsar.record.cancel')}
                </Button>
                <Button
                    type="button"
                    variant="primary"
                    onClick={() => void submit()}
                    disabled={saving || !userId}
                    loading={saving}
                    id="dsar-record-submit"
                >
                    {tRecord('dsar.record.submit')}
                </Button>
            </Modal.Footer>
        </Modal>
    );
}

function RequestSheet({
    tenantSlug,
    row,
    canManage,
    onClose,
    onUpdated,
}: {
    tenantSlug: string;
    row: DsarRow | null;
    canManage: boolean;
    onClose: () => void;
    onUpdated: (row: DsarRow) => void;
}) {
    const tSheet = useTranslations('admin');
    const [notes, setNotes] = useState(row?.fulfilmentNotes ?? '');
    const [reason, setReason] = useState<DsarRejectionReason | null>(null);
    const [busy, setBusy] = useState<DsarRow['status'] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const next = row ? [...DSAR_TRANSITIONS[row.status]] : [];

    async function move(to: DsarRow['status']) {
        if (!row) return;
        setBusy(to);
        setError(null);
        try {
            const res = await fetch(`/api/t/${tenantSlug}/admin/dsar-requests`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: row.id,
                    to,
                    notes: notes.trim() || null,
                    ...(to === 'REJECTED' ? { reason } : {}),
                }),
            });
            if (!res.ok) {
                setError(await refusalOf(res, tSheet('dsar.detail.failed')));
                return;
            }
            onUpdated((await res.json()) as DsarRow);
        } catch {
            setError(tSheet('dsar.detail.failed'));
        } finally {
            setBusy(null);
        }
    }

    const fact = (label: string, value: string | null, testId?: string) => (
        <div className="flex justify-between gap-default">
            <dt className="text-content-muted">{label}</dt>
            <dd className="text-right" data-testid={testId}>{value ?? '—'}</dd>
        </div>
    );

    return (
        <Sheet open={row !== null} onOpenChange={(v) => { if (!v) onClose(); }} size="md" title={row ? subjectLabel(row.subject) : tSheet('dsar.detail.title')}>
            {row && (
                <>
                    <Sheet.Header title={subjectLabel(row.subject)} />
                    <Sheet.Body>
                        <div className="space-y-section" data-testid="dsar-request-sheet">
                            <dl className="space-y-tight text-sm">
                                {fact(tSheet('dsar.col.type'), tSheet(`dsar.type.${row.type}`))}
                                {fact(tSheet('dsar.col.status'), tSheet(`dsar.status.${row.status}`), 'dsar-sheet-status')}
                                {fact(tSheet('dsar.col.requested'), formatDate(row.requestedAt))}
                                {fact(tSheet('dsar.detail.verified'), row.verifiedAt ? formatDate(row.verifiedAt) : null)}
                                {fact(tSheet('dsar.detail.completed'), row.completedAt ? formatDate(row.completedAt) : null)}
                                {fact(tSheet('dsar.col.handledBy'), row.handledBy?.name ?? null)}
                                {row.rejectionReason &&
                                    fact(
                                        tSheet('dsar.detail.rejectionReason'),
                                        REJECTION_REASONS.includes(row.rejectionReason as DsarRejectionReason)
                                            ? tSheet(`dsar.rejection.${row.rejectionReason}`)
                                            : row.rejectionReason,
                                        'dsar-sheet-reason',
                                    )}
                            </dl>

                            {!canManage || next.length === 0 ? (
                                <div className="space-y-tight text-sm">
                                    <p className="text-content-muted">{tSheet('dsar.detail.notes')}</p>
                                    <p className="whitespace-pre-wrap" data-testid="dsar-sheet-notes">{row.fulfilmentNotes ?? '—'}</p>
                                </div>
                            ) : (
                                <div className="space-y-default">
                                    {error && <InlineNotice variant="error" icon={null}><span data-testid="dsar-sheet-error">{error}</span></InlineNotice>}
                                    <FormField label={tSheet('dsar.detail.notes')} description={tSheet('dsar.detail.notesHint')}>
                                        <Textarea id="dsar-sheet-notes-input" value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} className="w-full" />
                                    </FormField>
                                    {next.includes('REJECTED') && (
                                        <FormField label={tSheet('dsar.detail.reasonLabel')} description={tSheet('dsar.detail.reasonHint')}>
                                            <RadioGroup
                                                value={reason ?? ''}
                                                onValueChange={(v) => setReason(v as DsarRejectionReason)}
                                                aria-label={tSheet('dsar.detail.reasonLabel')}
                                                className="space-y-1.5"
                                            >
                                                {REJECTION_REASONS.map((value) => (
                                                    <label key={value} htmlFor={`dsar-reason-${value}`} className="flex items-center gap-compact text-sm">
                                                        <RadioGroupItem id={`dsar-reason-${value}`} value={value} size="sm" />
                                                        {tSheet(`dsar.rejection.${value}`)}
                                                    </label>
                                                ))}
                                            </RadioGroup>
                                        </FormField>
                                    )}
                                    <div className="flex flex-wrap gap-tight">
                                        {next.map((to) => (
                                            <Button
                                                key={to}
                                                variant="secondary"
                                                size="sm"
                                                onClick={() => void move(to)}
                                                disabled={busy !== null || (to === 'REJECTED' && reason === null)}
                                                loading={busy === to}
                                                id={`dsar-move-${to}`}
                                            >
                                                {tSheet(`dsar.action.${to}`)}
                                            </Button>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </Sheet.Body>
                </>
            )}
        </Sheet>
    );
}
