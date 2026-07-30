'use client';

/**
 * Epic G-4 — Access Reviews list client island.
 *
 * Renders the campaign roster with status badges, deadline,
 * reviewer, and a progress bar (% decided). Admin actions:
 *   • New campaign — modal that submits to POST /access-reviews
 *   • Row click → /t/:slug/access-reviews/:id (detail page)
 */
import { useMemo, useState } from 'react';
import { apiErrorMessage } from '@/lib/api-error';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { UserCombobox } from '@/components/ui/user-combobox';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { DataTable, createColumns } from '@/components/ui/table';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { DatePicker } from '@/components/ui/date-picker';
import type { CappedList } from '@/lib/list-backfill-cap';
import { TruncationBanner } from '@/components/ui/TruncationBanner';
import { formatDate } from '@/lib/format-date';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';

/// SSR returns Prisma rows with native Date instances; the SWR
/// fetcher returns the same shape but the dates round-trip through
/// JSON as ISO strings. The client widens to accept both.
interface AccessReviewSummary {
    id: string;
    name: string;
    scope: 'ALL_USERS' | 'ADMIN_ONLY' | 'CUSTOM' | 'CONNECTED_APP';
    status: 'OPEN' | 'IN_REVIEW' | 'CLOSED';
    periodStartAt: string | Date | null;
    periodEndAt: string | Date | null;
    dueAt: string | Date | null;
    closedAt: string | Date | null;
    createdAt: string | Date;
    reviewerUserId: string;
    createdByUserId: string;
    _count: { decisions: number };
    /** Filled by the detail-page hydration; the list endpoint keeps
     *  the response small. */
    decidedCount?: number;
}

const STATUS_VARIANT: Record<
    AccessReviewSummary['status'],
    'warning' | 'info' | 'success'
> = {
    OPEN: 'warning',
    IN_REVIEW: 'info',
    CLOSED: 'success',
};

interface Props {
    tenantSlug: string;
    initialReviews: AccessReviewSummary[];
}

export function AccessReviewsClient({ tenantSlug, initialReviews }: Props) {
    const t = useTranslations('accessReviews');
    const router = useRouter();

    const reviewsQuery = useTenantSWR<CappedList<AccessReviewSummary>>(
        CACHE_KEYS.accessReviews.list(),
        { fallbackData: { rows: initialReviews, truncated: false } },
    );

    const reviews = reviewsQuery.data?.rows ?? [];
    const truncated = reviewsQuery.data?.truncated ?? false;

    const columns = useMemo(
        () =>
            createColumns<AccessReviewSummary>([
                {
                    id: 'name',
                    header: t('colCampaign'),
                    cell: ({ row }) => (
                        <Link
                            href={`/t/${tenantSlug}/access-reviews/${row.original.id}`}
                            className="font-medium text-content-default hover:text-brand-emphasis"
                        >
                            {row.original.name}
                        </Link>
                    ),
                },
                {
                    id: 'status',
                    header: t('colStatus'),
                    cell: ({ row }) => (
                        <StatusBadge variant={STATUS_VARIANT[row.original.status]}>
                            {row.original.status}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'scope',
                    header: t('colScope'),
                    cell: ({ row }) => (
                        <span className="text-sm text-content-muted">
                            {row.original.scope.replace('_', ' ').toLowerCase()}
                        </span>
                    ),
                },
                {
                    id: 'period',
                    header: t('colPeriod'),
                    cell: ({ row }) =>
                        row.original.periodStartAt && row.original.periodEndAt
                            ? `${formatDate(row.original.periodStartAt)} → ${formatDate(row.original.periodEndAt)}`
                            : '—',
                },
                {
                    id: 'dueAt',
                    header: t('colDue'),
                    cell: ({ row }) =>
                        row.original.dueAt ? formatDate(row.original.dueAt) : '—',
                },
                {
                    id: 'progress',
                    header: t('colProgress'),
                    cell: ({ row }) => {
                        const total = row.original._count.decisions;
                        const decided = row.original.decidedCount ?? 0;
                        const pct = total === 0 ? 0 : Math.round((decided / total) * 100);
                        const variant =
                            row.original.status === 'CLOSED'
                                ? 'success'
                                : pct >= 80
                                    ? 'info'
                                    : pct > 0
                                        ? 'brand'
                                        : 'neutral';
                        return (
                            <div className="flex items-center gap-tight">
                                <ProgressBar
                                    value={pct}
                                    variant={variant}
                                    size="sm"
                                    aria-label={t('decisionsAria', { decided, total })}
                                />
                                <span className="text-xs text-content-muted whitespace-nowrap">
                                    {decided}/{total}
                                </span>
                            </div>
                        );
                    },
                },
            ]),
        [tenantSlug, t],
    );

    return (
        <ListPageShell>
            <ListPageShell.Header>
                <div className="flex items-center justify-between">
                    <div>
                        <PageBreadcrumbs
                            items={[
                                { label: t('crumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                                { label: t('crumbList') },
                            ]}
                            className="mb-1"
                        />
                        <Heading level={1} data-testid="access-reviews-title">
                            {t('title')}
                        </Heading>
                        <p className="text-sm text-content-muted">
                            {t('campaignsCount', { count: reviews.length })}
                        </p>
                    </div>
                    <CreateCampaignButton
                        tenantSlug={tenantSlug}
                        onCreated={(reviewId) => {
                            reviewsQuery.mutate();
                            router.push(
                                `/t/${tenantSlug}/access-reviews/${reviewId}`,
                            );
                        }}
                    />
                </div>
                {truncated ? <TruncationBanner truncated /> : null}
            </ListPageShell.Header>
            <ListPageShell.Body>
                {reviews.length === 0 ? (
                    <div
                        className="rounded border border-border-subtle bg-bg-subtle p-12 text-center"
                        data-testid="access-reviews-empty"
                    >
                        <p className="text-content-muted">
                            {t.rich('emptyList', { b: (c) => <strong>{c}</strong> })}
                        </p>
                    </div>
                ) : (
                    <div data-testid="access-reviews-table">
                        <DataTable
                            fillBody
                            data={reviews}
                            columns={columns}
                            getRowId={(r) => r.id}
                            resourceName={(plural) =>
                                plural ? 'access reviews' : 'access review'
                            }
                        />
                        {/* Per-row testid markers for downstream tests
                         *  that don't reach into DataTable internals. */}
                        <div hidden>
                            {reviews.map((r) => (
                                <span
                                    key={r.id}
                                    data-testid={`access-review-row-${r.id}`}
                                />
                            ))}
                        </div>
                    </div>
                )}
            </ListPageShell.Body>
        </ListPageShell>
    );
}

// ─── Create campaign modal ─────────────────────────────────────────

interface CreateCampaignButtonProps {
    tenantSlug: string;
    onCreated: (reviewId: string) => void;
}

function CreateCampaignButton({
    tenantSlug,
    onCreated,
}: CreateCampaignButtonProps) {
    const t = useTranslations('accessReviews');
    const [open, setOpen] = useState(false);
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [scope, setScope] = useState<'ALL_USERS' | 'ADMIN_ONLY' | 'CONNECTED_APP'>('ALL_USERS');
    // Directory scope for a CONNECTED_APP review — 'all' reviews every synced
    // provider; a specific id (e.g. 'entra-id', 'active-directory') scopes the
    // campaign to one directory. Matches the ScheduledCheckProvider ids the
    // access-review-connected usecase accepts.
    const [directory, setDirectory] = useState<string>('all');
    const [reviewerUserId, setReviewerUserId] = useState('');

    // Which directories actually have ACTIVE synced accounts.
    //
    // The option list used to be a static four-provider array with no idea
    // what was connected, so picking an unsynced directory was allowed and
    // only failed on submit — the server correctly refuses a campaign that
    // would have zero subjects, but by then the operator has filled in the
    // whole form. Fetch the accounts and let the picker say so up front.
    const accountsQuery = useTenantSWR<
        Array<{ provider: string; status: string }>
    >(`/api/t/${tenantSlug}/admin/integrations/identity-accounts`);
    const syncedProviders = useMemo(() => {
        // Shape-guarded rather than `data ?? []`. Several list endpoints in
        // this codebase return `{ rows, truncated }` rather than a bare
        // array, so assuming the array form would take the whole page down
        // with a render-time TypeError if this one ever grew a cap — and
        // there would be no type error to catch it, because the response is
        // untyped at the wire.
        const rows = Array.isArray(accountsQuery.data)
            ? accountsQuery.data
            : [];
        return new Set(
            rows.filter((a) => a?.status === 'ACTIVE').map((a) => a.provider),
        );
    }, [accountsQuery.data]);
    // Only gate once the fetch has resolved — while it is in flight we cannot
    // tell "not synced" from "not loaded yet", and disabling on the latter
    // would block a directory that is perfectly usable.
    const accountsKnown = Array.isArray(accountsQuery.data);

    const directoryOptions: ComboboxOption[] = useMemo(() => {
        const gate = (value: string, label: string): ComboboxOption =>
            accountsKnown && !syncedProviders.has(value)
                ? { value, label, disabledTooltip: t('directoryNotSynced') }
                : { value, label };
        return [
            // 'all' spans every synced provider, so it is unavailable only
            // when nothing at all is synced.
            accountsKnown && syncedProviders.size === 0
                ? { value: 'all', label: t('directoryAll'), disabledTooltip: t('directoryNoneSynced') }
                : { value: 'all', label: t('directoryAll') },
            gate('okta', t('directoryOkta')),
            gate('google-workspace', t('directoryGoogle')),
            gate('entra-id', t('directoryEntra')),
            gate('active-directory', t('directoryAd')),
        ];
    }, [accountsKnown, syncedProviders, t]);
    const [dueAt, setDueAt] = useState<Date | null>(null);
    const [error, setError] = useState<string | null>(null);

    const apiUrl = `/api/t/${tenantSlug}/access-reviews`;

    const [submitting, setSubmitting] = useState(false);
    const handleCreate = async () => {
        setSubmitting(true);
        setError(null);
        try {
            // A CONNECTED_APP review runs over synced identity-provider accounts
            // (Okta / Google Workspace / Entra ID / Active Directory) via a
            // separate endpoint + usecase; the member scopes (ALL_USERS /
            // ADMIN_ONLY) use the roster endpoint. A specific `directory` scopes
            // the campaign to one provider; 'all' omits the filter.
            const isConnected = scope === 'CONNECTED_APP';
            const body = isConnected
                ? {
                      name,
                      description: description || undefined,
                      provider: directory !== 'all' ? directory : undefined,
                      reviewerUserId,
                      dueAt: dueAt ? dueAt.toISOString() : undefined,
                  }
                : {
                      name,
                      description: description || undefined,
                      scope,
                      reviewerUserId,
                      dueAt: dueAt ? dueAt.toISOString() : undefined,
                  };
            const res = await fetch(isConnected ? `${apiUrl}/connected` : apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                // Was `await res.text()` used verbatim as the message, so the
                // whole API envelope was rendered into the form — braces,
                // quotes, error code and requestId included. The server's
                // message here is genuinely useful ("connect and sync a
                // directory first"); it was just buried in JSON.
                const body = (await res.json().catch(() => null)) as unknown;
                throw new Error(apiErrorMessage(body, t('createFailed')));
            }
            const data = (await res.json()) as { accessReviewId: string };
            setOpen(false);
            setName('');
            setDescription('');
            setReviewerUserId('');
            setDirectory('all');
            setScope('ALL_USERS');
            setDueAt(null);
            onCreated(data.accessReviewId);
        } catch (err) {
            setError(err instanceof Error ? err.message : t('unknownError'));
        } finally {
            setSubmitting(false);
        }
    };

    const submit = () => {
        if (!name.trim() || !reviewerUserId.trim()) {
            setError(t('nameReviewerRequired'));
            return;
        }
        void handleCreate();
    };

    return (
        <>
            <Button
                onClick={() => setOpen(true)}
                data-testid="access-review-new-campaign-button"
            >{t('newCampaign')}</Button>
            {open ? (
                <Modal showModal={open} setShowModal={setOpen}>
                    <Modal.Header title={t('createTitle')} />
                    <Modal.Body>
                        <div className="space-y-default">
                            <FormField label={t('fieldName')} required>
                                <input
                                    className="input"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder={t('namePlaceholder')}
                                    data-testid="access-review-new-name"
                                />
                            </FormField>
                            <FormField label={t('fieldDescription')}>
                                <textarea
                                    className="input"
                                    rows={3}
                                    value={description}
                                    onChange={(e) =>
                                        setDescription(e.target.value)
                                    }
                                    placeholder={t('descPlaceholder')}
                                />
                            </FormField>
                            <FormField label={t('fieldScope')}>
                                <RadioGroup
                                    value={scope}
                                    onValueChange={(v) =>
                                        setScope(
                                            v as 'ALL_USERS' | 'ADMIN_ONLY' | 'CONNECTED_APP',
                                        )
                                    }
                                    className="flex flex-col gap-tight"
                                >
                                    {(
                                        [
                                            ['ALL_USERS', t('scopeAllUsers')],
                                            ['ADMIN_ONLY', t('scopeAdminOnly')],
                                            // Reviews connected identity-provider accounts (Okta /
                                            // Google Workspace / Entra ID / Active Directory) synced
                                            // via the integrations connector; scoped by the Directory
                                            // picker below.
                                            ['CONNECTED_APP', t('scopeConnectedApp')],
                                        ] as const
                                    ).map(([value, labelText]) => (
                                        <label
                                            key={value}
                                            htmlFor={`access-review-scope-${value}`}
                                            className="flex items-center gap-tight text-sm cursor-pointer"
                                        >
                                            <RadioGroupItem
                                                id={`access-review-scope-${value}`}
                                                value={value}
                                                size="sm"
                                            />
                                            {labelText}
                                        </label>
                                    ))}
                                </RadioGroup>
                            </FormField>
                            {scope === 'CONNECTED_APP' ? (
                                <FormField
                                    label={t('fieldDirectory')}
                                    hint={t('directoryHint')}
                                >
                                    <div data-testid="access-review-new-directory">
                                        <Combobox
                                            hideSearch
                                            id="access-review-directory-select"
                                            selected={
                                                directoryOptions.find(
                                                    (o) => o.value === directory,
                                                ) ?? null
                                            }
                                            setSelected={(opt) =>
                                                setDirectory(opt?.value ?? 'all')
                                            }
                                            options={directoryOptions}
                                            matchTriggerWidth
                                        />
                                        {/* When nothing is synced, every
                                            directory option is disabled and the
                                            only way forward is to connect one.
                                            A tooltip on a disabled option is
                                            too easy to miss for the one thing
                                            the operator has to do next, so the
                                            route is offered inline as a real
                                            link rather than described in
                                            prose. */}
                                        {accountsKnown && syncedProviders.size === 0 && (
                                            <p
                                                className="mt-tight text-xs text-content-warning"
                                                data-testid="access-review-no-directories"
                                            >
                                                {t('directoryNoneSynced')}{' '}
                                                <Link
                                                    href={`/t/${tenantSlug}/admin/integrations/identity-accounts`}
                                                    className="text-content-info hover:underline"
                                                    id="access-review-connect-directory-link"
                                                >
                                                    {t('directoryConnectLink')}
                                                </Link>
                                            </p>
                                        )}
                                    </div>
                                </FormField>
                            ) : null}
                            <FormField label={t('fieldReviewer')} required>
                                {/* People-picker over the tenant's members
                                    (replaces the raw "usr_…" id input). The
                                    wrapping div keeps the stable test id; the
                                    combobox value is the selected user's id. */}
                                <div data-testid="access-review-new-reviewer">
                                    <UserCombobox
                                        tenantSlug={tenantSlug}
                                        selectedId={reviewerUserId || null}
                                        onChange={(userId) =>
                                            setReviewerUserId(userId ?? '')
                                        }
                                        placeholder={t('reviewerPlaceholder')}
                                        searchPlaceholder={t('searchMembers')}
                                        forceDropdown
                                        matchTriggerWidth
                                        id="access-review-reviewer-select"
                                    />
                                </div>
                            </FormField>
                            <FormField label={t('fieldDue')}>
                                <DatePicker
                                    value={dueAt}
                                    onChange={setDueAt}
                                    clearable
                                />
                            </FormField>
                            {error ? (
                                <p
                                    className="text-sm text-content-error"
                                    data-testid="access-review-new-error"
                                >
                                    {error}
                                </p>
                            ) : null}
                        </div>
                    </Modal.Body>
                    <Modal.Footer>
                        <Button
                            variant="secondary"
                            onClick={() => setOpen(false)}
                        >{t('cancel')}</Button>
                        <Button
                            onClick={submit}
                            disabled={submitting}
                            data-testid="access-review-new-submit"
                        >
                            {submitting ? t('creating') : t('createCampaign')}
                        </Button>
                    </Modal.Footer>
                </Modal>
            ) : null}
        </>
    );
}
