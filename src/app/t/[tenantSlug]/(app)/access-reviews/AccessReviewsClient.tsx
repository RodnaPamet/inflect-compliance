'use client';

/**
 * Epic G-4 — Access Reviews list client island.
 *
 * Renders the campaign roster with status badges, deadline,
 * reviewer, and a progress bar (% decided). Admin actions:
 *   • New campaign — modal that submits to POST /access-reviews, or to the
 *     scope's own route (`/connected`, `/agents`, `/legacy`). Shown only to a
 *     caller holding `access_reviews.create` (#4130), the key every one of
 *     those routes takes: every other role used to fill the form in and then
 *     meet "Permission denied".
 *   • Row click → /t/:slug/access-reviews/:id (detail page)
 */
import { useMemo, useState } from 'react';
import { apiErrorMessage } from '@/lib/api-error';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useThresholdLoadMore } from '@/components/ui/hooks';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { usePublishDisplayedOrder } from '@/lib/hooks/use-entity-list-ids';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { UserCombobox } from '@/components/ui/user-combobox';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { DataTable, createColumns } from '@/components/ui/table';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { DatePicker } from '@/components/ui/date-picker';
import { DateRangePicker } from '@/components/ui/date-picker/date-range-picker';
import type { DateRangeValue } from '@/components/ui/date-picker/types';
import type { CappedList } from '@/lib/list-backfill-cap';
import { IDENTITY_ROSTER_PAGE_SIZE } from '@/lib/identity-roster';
import { TruncationBanner } from '@/components/ui/TruncationBanner';
import { formatDate } from '@inflect/ui/lib/format-date';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { scopeLabelKey, type StoredAccessReviewScope } from '@/lib/access-review/scope';

/// SSR returns Prisma rows with native Date instances; the SWR
/// fetcher returns the same shape but the dates round-trip through
/// JSON as ISO strings. The client widens to accept both.
interface AccessReviewSummary {
    id: string;
    name: string;
    /** Every stored scope, AGENT included (#3674). */
    scope: StoredAccessReviewScope;
    status: 'OPEN' | 'IN_REVIEW' | 'CLOSED';
    periodStartAt: string | Date | null;
    periodEndAt: string | Date | null;
    dueAt: string | Date | null;
    closedAt: string | Date | null;
    createdAt: string | Date;
    reviewerUserId: string;
    createdByUserId: string;
    /**
     * Subjects live in ONE of two tables: member rows, or connected rows for
     * CONNECTED_APP / LEGACY_APP / AGENT. `connectedDecisions` is optional
     * because a row cached before the count carried it has none.
     */
    _count: { decisions: number; connectedDecisions?: number };
    /**
     * Subjects with a verdict, across both subject tables. Sent by
     * `listAccessReviews` (#4130); optional because a row cached before it
     * was sent has none, and such a row reads as zero until it refetches.
     */
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
    /**
     * The caller holds `access_reviews.create` — the key `POST /access-reviews`
     * and its connected, agent and legacy siblings take. The New campaign
     * button, and so every scope it offers, follows it, so it is offered only
     * to those the server will let create.
     */
    canCreate: boolean;
}

export function AccessReviewsClient({ tenantSlug, initialReviews, canCreate }: Props) {
    const t = useTranslations('accessReviews');
    const router = useRouter();

    const reviewsQuery = useTenantSWR<CappedList<AccessReviewSummary>>(
        CACHE_KEYS.accessReviews.list(),
        { fallbackData: { rows: initialReviews, truncated: false } },
    );

    const reviews = reviewsQuery.data?.rows ?? [];
    const truncated = reviewsQuery.data?.truncated ?? false;

    // #107 PUBLISH side. `reviews` — the backfill-capped set the table is
    // driving — not `visibleReviews`, which is only the scroll window.
    //
    // This register applies no filter and no client sort, so the published
    // order matches the cache order today. Publishing anyway is what makes
    // the campaign detail's stepper honest the moment either arrives, and it
    // saves the detail page a redundant list fetch in the common case.
    usePublishDisplayedOrder(CACHE_KEYS.accessReviews.list(), reviews);

    // Render a window, not the whole backfill-capped set. Without this the
    // page mounts every row it fetched — up to `LIST_BACKFILL_CAP` — and
    // never virtualizes, because `VIRTUALIZE_DEFAULT_THRESHOLD` is 1000 and
    // a tenant can sit under it while still rendering hundreds of rows on
    // every re-render. `onReachEnd` extends the window as the user scrolls,
    // which is the same contract every other list page here already uses.
    const {
        visibleRows: visibleReviews,
        hasMore: hasMoreReviews,
        loadMore: loadMoreReviews,
    } = useThresholdLoadMore(reviews);

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
                            {t(`statusLabels.${row.original.status}`)}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'scope',
                    header: t('colScope'),
                    cell: ({ row }) => (
                        <span className="text-sm text-content-muted" data-testid={`access-review-scope-cell-${row.original.id}`}>
                            {t(`scopeLabels.${scopeLabelKey(row.original.scope)}`)}
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
                        const total =
                            row.original._count.decisions + (row.original._count.connectedDecisions ?? 0);
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
                {/*
                  * #3252. This page is a SUBPAGE of `/tests`, not a sidebar
                  * destination — it has not been in the sidebar since #1538, and the
                  * button on Tests is its only link anywhere in the UI. Until this
                  * mount a user who arrived that way had no way back, and on mobile no
                  * way out at all.
                  */}
                <BackAffordance />
                <div className="flex items-center justify-between">
                    <div>
                        <PageBreadcrumbs
                            items={[
                                { label: t('crumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                                // The real parent, now that the model says so.
                                { label: t('crumbTests'), href: `/t/${tenantSlug}/tests` },
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
                    {canCreate ? (
                        <CreateCampaignButton
                            tenantSlug={tenantSlug}
                            onCreated={(reviewId) => {
                                reviewsQuery.mutate();
                                router.push(
                                    `/t/${tenantSlug}/access-reviews/${reviewId}`,
                                );
                            }}
                        />
                    ) : null}
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
                            {canCreate
                                ? t.rich('emptyList', { b: (c) => <strong>{c}</strong> })
                                : t('emptyListReadOnly')}
                        </p>
                    </div>
                ) : (
                    <div data-testid="access-reviews-table">
                        <DataTable
                            fillBody
                            data={visibleReviews}
                            onReachEnd={hasMoreReviews ? loadMoreReviews : undefined}
                            columns={columns}
                            getRowId={(r) => r.id}
                            // #4464 — the footer and empty fallback read this
                            // noun, so it is translated like every other label.
                            resourceName={(plural) =>
                                plural ? t('resourcePlural') : t('resourceSingular')
                            }
                            // Nothing on this page acts on ticked rows, and the
                            // select column is on by default (a row click ticked it).
                            selectionEnabled={false}
                        />
                        {/* Per-row testid markers for downstream tests
                         *  that don't reach into DataTable internals.
                         *  Mirrors `visibleReviews`, not `reviews` — these
                         *  stand in for rendered rows, so keying them on the
                         *  full set would report rows the table never
                         *  mounted. */}
                        <div hidden>
                            {visibleReviews.map((r) => (
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

/** One synced identity-provider account, narrowed to what the gate reads. */
interface IdentityAccount {
    provider: string;
    status: string;
}

/**
 * What `GET /admin/integrations/identity-accounts` puts on the wire.
 *
 * The route returns `jsonResponse({ accounts })` — an OBJECT, not a bare
 * array. The bare-array arm is kept because the `useTenantSWR<T>` generic is
 * an unchecked assertion (nothing validates the response at runtime), so the
 * type alone is not evidence of the shape; the union makes both arms visible
 * to the reader instead of hiding one behind a cast.
 */
type IdentityAccountsResponse =
    | { accounts: IdentityAccount[] }
    | IdentityAccount[];

/**
 * Read the account roster out of the response, or `null` if it is not known.
 *
 * THREE states, deliberately — `null` (in flight, errored, or a body whose
 * shape this reader does not recognise) is not the same as `[]` (the roster
 * loaded and nothing is synced). Collapsing them is what broke this gate:
 * the previous reader asked `Array.isArray(data)` of a response that is an
 * object, so it was permanently false, `directoryStatusKnown` below was
 * permanently false, and the gate never applied. It failed OPEN — every
 * directory stayed selectable — which is why nothing looked wrong from the
 * outside.
 *
 * Note this is NOT `unwrapCappedList` from `@/lib/list-backfill-cap`: that
 * helper folds an unrecognised body into `[]` on purpose, which is right for
 * a picker that just needs options and exactly wrong here, where `[]` is a
 * load-bearing answer that disables every option.
 *
 * An unrecognised shape returns `null` so the gate stands down rather than
 * disabling directories on a body it does not understand — but that also
 * means CHANGING THE ROUTE'S RESPONSE SHAPE SILENTLY RE-BREAKS THIS GATE,
 * in this same quiet way. A cap or an envelope added there adds its arm
 * here, in the same diff.
 */
function readIdentityAccounts(data: unknown): IdentityAccount[] | null {
    if (Array.isArray(data)) return data as IdentityAccount[];
    if (data && typeof data === 'object') {
        const { accounts } = data as { accounts?: unknown };
        if (Array.isArray(accounts)) return accounts as IdentityAccount[];
    }
    return null;
}

/** Every scope the create modal offers, each posted to its own route. */
type CreatableScope = 'ALL_USERS' | 'ADMIN_ONLY' | 'CONNECTED_APP' | 'LEGACY_APP' | 'AGENT';

/**
 * The legacy-application connector's provider id. Spelled here rather than
 * imported, because its module is server code; `LegacyAccessMappingCard` does
 * the same.
 */
const LEGACY_PROVIDER = 'legacy-mcp';

/** One integration connection, narrowed to what the legacy picker reads. */
interface IntegrationConnectionRow {
    id: string;
    provider: string;
    name: string;
}

/** `GET /admin/integrations` answers `{ connections }`; anything else is unknown (`null`). */
function readLegacyConnections(data: unknown): IntegrationConnectionRow[] | null {
    if (!data || typeof data !== 'object') return null;
    const { connections } = data as { connections?: unknown };
    if (!Array.isArray(connections)) return null;
    return (connections as IntegrationConnectionRow[]).filter((c) => c?.provider === LEGACY_PROVIDER);
}

/**
 * The sentence a refused create shows, never a generic one.
 *
 * Every refusal the create routes give carries its own message (the legacy
 * snapshot refusals, `REVIEWER_NOT_A_MEMBER`, `NO_SUBJECTS`, …) and is shown
 * as sent. A validation error's message is only "Invalid request payload";
 * what was wrong is in `details`, one issue per field, so those are shown
 * instead, each with the field it names.
 */
function createRefusalMessage(
    body: unknown,
    fallback: string,
    invalidFields: (details: string) => string,
): string {
    const error = (body as { error?: { code?: unknown; details?: unknown } } | null)?.error;
    if (error && error.code === 'VALIDATION_ERROR' && Array.isArray(error.details) && error.details.length > 0) {
        const details = (error.details as Array<{ path?: unknown; message?: unknown }>)
            .map((d) => {
                const message = typeof d.message === 'string' ? d.message : '';
                const path = Array.isArray(d.path) && d.path.length > 0 ? d.path.join('.') : '';
                return path ? `${path}: ${message}` : message;
            })
            .filter((line) => line.trim() !== '');
        if (details.length > 0) return invalidFields(details.join('; '));
    }
    return apiErrorMessage(body, fallback);
}

function CreateCampaignButton({
    tenantSlug,
    onCreated,
}: CreateCampaignButtonProps) {
    const t = useTranslations('accessReviews');
    const [open, setOpen] = useState(false);
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [scope, setScope] = useState<CreatableScope>('ALL_USERS');
    // Directory scope for a CONNECTED_APP review — 'all' reviews every synced
    // provider; a specific id (e.g. 'entra-id', 'active-directory') scopes the
    // campaign to one directory. Matches the ScheduledCheckProvider ids the
    // access-review-connected usecase accepts.
    const [directory, setDirectory] = useState<string>('all');
    // The legacy application a LEGACY_APP campaign recertifies: one
    // `legacy-mcp` connection, whose latest complete, reconciled pull becomes
    // the campaign's population. The server checks the pull; the form only
    // names the application.
    const [legacyConnectionId, setLegacyConnectionId] = useState('');
    const legacyQuery = useTenantSWR<unknown>(scope === 'LEGACY_APP' ? '/admin/integrations' : null);
    const legacyConnections = useMemo(() => readLegacyConnections(legacyQuery.data), [legacyQuery.data]);
    const legacyOptions: ComboboxOption[] = useMemo(
        () => (legacyConnections ?? []).map((c) => ({ value: c.id, label: c.name })),
        [legacyConnections],
    );
    const [reviewerUserId, setReviewerUserId] = useState('');
    // #3674 — an AGENT review names the registered agent that prepares every
    // reviewer pack but its own, and optionally a second that prepares that one
    // (an agent never prepares the pack it is reviewed by). Left empty, a person
    // prepares the preparer's own pack. Offered from the ACTIVE agents; the
    // server re-checks every term (scored, not killed, granted the read).
    const [preparerAgentId, setPreparerAgentId] = useState('');
    const [crossPreparerAgentId, setCrossPreparerAgentId] = useState('');
    const agentsQuery = useTenantSWR<{ agents?: Array<{ id: string; name: string }> }>(
        scope === 'AGENT' ? '/admin/agents?status=ACTIVE' : null,
    );
    const agentOptions: ComboboxOption[] = useMemo(
        () => (agentsQuery.data?.agents ?? []).map((a) => ({ value: a.id, label: a.name })),
        [agentsQuery.data],
    );

    // Which directories actually have ACTIVE synced accounts.
    //
    // The option list used to be a static four-provider array with no idea
    // what was connected, so picking an unsynced directory was allowed and
    // only failed on submit — the server correctly refuses a campaign that
    // would have zero subjects, but by then the operator has filled in the
    // whole form. Fetch the accounts and let the picker say so up front.
    //
    // The path is TENANT-RELATIVE: useTenantSWR prepends `/api/t/{slug}`
    // itself. An absolute `/api/t/${tenantSlug}/...` double-prefixes into
    // `/api/t/{slug}/api/t/{slug}/...` — which 404s SILENTLY here: `data`
    // stays undefined, `directoryStatusKnown` stays false, and the whole
    // directory-availability gate below never applies.
    const accountsQuery = useTenantSWR<IdentityAccountsResponse>(
        '/admin/integrations/identity-accounts',
    );
    const accounts = useMemo(
        () => readIdentityAccounts(accountsQuery.data),
        [accountsQuery.data],
    );
    const syncedProviders = useMemo(
        () =>
            new Set(
                (accounts ?? [])
                    .filter((a) => a?.status === 'ACTIVE')
                    .map((a) => a.provider),
            ),
        [accounts],
    );
    // Only gate once we know the sync status of EVERY directory. There are two
    // ways not to know it, and both have to fail open, because the gate
    // disables the option it decides against:
    //
    //   • `null` — in flight, errored, or an unrecognised body. Disabling on
    //     an unresolved fetch would block a directory that is perfectly
    //     usable. (An empty array is a different answer: the roster loaded
    //     and there is genuinely nothing synced. Those two must not collapse
    //     into each other — collapsing them is the bug this gate had.)
    //   • a roster that came back AT the cap — see IDENTITY_ROSTER_PAGE_SIZE.
    //     The route sends no `truncated` flag, so a provider missing from a
    //     full page might simply have been cut off after the ones that sort
    //     ahead of it. Absence in a capped list is not evidence of absence.
    //     The roster is unfiltered by status too, so a full page of
    //     DEPROVISIONED rows says nothing about ACTIVE accounts beyond it.
    const directoryStatusKnown =
        accounts !== null && accounts.length < IDENTITY_ROSTER_PAGE_SIZE;

    const directoryOptions: ComboboxOption[] = useMemo(() => {
        const gate = (value: string, label: string): ComboboxOption =>
            directoryStatusKnown && !syncedProviders.has(value)
                ? { value, label, disabledTooltip: t('directoryNotSynced') }
                : { value, label };
        return [
            // 'all' spans every synced provider, so it is unavailable only
            // when nothing at all is synced.
            directoryStatusKnown && syncedProviders.size === 0
                ? { value: 'all', label: t('directoryAll'), disabledTooltip: t('directoryNoneSynced') }
                : { value: 'all', label: t('directoryAll') },
            gate('okta', t('directoryOkta')),
            gate('google-workspace', t('directoryGoogle')),
            gate('entra-id', t('directoryEntra')),
            gate('active-directory', t('directoryAd')),
        ];
    }, [directoryStatusKnown, syncedProviders, t]);
    const [dueAt, setDueAt] = useState<Date | null>(null);
    // The audit period the campaign covers (#4130). Every create schema takes
    // `periodStartAt` / `periodEndAt` and the evidence PDF prints them, but the
    // form never sent one, so the register's Period column always read "—".
    const [period, setPeriod] = useState<DateRangeValue>({ from: null, to: null });
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
            //
            // An AGENT review (#3674) runs over the registered agents through
            // its own endpoint, which freezes the population; its reviewer
            // packs are then prepared by a second call. A failed preparation
            // does not undo the campaign — the detail page offers it again.
            //
            // A LEGACY_APP review (#4377) recertifies one legacy application
            // from its latest reconciled pull. Its route parses the body
            // strictly, so it is sent exactly the fields that route takes.
            const isConnected = scope === 'CONNECTED_APP';
            const isAgent = scope === 'AGENT';
            const isLegacy = scope === 'LEGACY_APP';
            // A period is sent only when both ends are set: the picker
            // commits a range as a pair, and half a period is not one.
            const periodFields =
                period.from && period.to
                    ? { periodStartAt: period.from.toISOString(), periodEndAt: period.to.toISOString() }
                    : {};
            const body = isLegacy
                ? {
                      name,
                      description: description || undefined,
                      connectionId: legacyConnectionId,
                      reviewerUserId,
                      dueAt: dueAt ? dueAt.toISOString() : undefined,
                      ...periodFields,
                  }
                : isConnected || isAgent
                ? {
                      name,
                      description: description || undefined,
                      provider: isConnected && directory !== 'all' ? directory : undefined,
                      ...(isAgent
                          ? { preparerAgentId, crossPreparerAgentId: crossPreparerAgentId || undefined }
                          : {}),
                      reviewerUserId,
                      dueAt: dueAt ? dueAt.toISOString() : undefined,
                      ...periodFields,
                  }
                : {
                      name,
                      description: description || undefined,
                      scope,
                      reviewerUserId,
                      dueAt: dueAt ? dueAt.toISOString() : undefined,
                      ...periodFields,
                  };
            const endpoint = isConnected
                ? `${apiUrl}/connected`
                : isAgent
                  ? `${apiUrl}/agents`
                  : isLegacy
                    ? `${apiUrl}/legacy`
                    : apiUrl;
            const res = await fetch(endpoint, {
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
                throw new Error(
                    createRefusalMessage(body, t('createFailed'), (details) => t('createInvalidFields', { details })),
                );
            }
            const data = (await res.json()) as { accessReviewId: string };
            if (isAgent) {
                await fetch(`${apiUrl}/${data.accessReviewId}/agent-packs`, { method: 'POST' }).catch(() => undefined);
            }
            setOpen(false);
            setName('');
            setDescription('');
            setReviewerUserId('');
            setDirectory('all');
            setLegacyConnectionId('');
            setPreparerAgentId('');
            setCrossPreparerAgentId('');
            setScope('ALL_USERS');
            setDueAt(null);
            setPeriod({ from: null, to: null });
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
        if (scope === 'LEGACY_APP' && !legacyConnectionId) {
            setError(t('legacyConnectionRequired'));
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
                                <Input
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder={t('namePlaceholder')}
                                    data-testid="access-review-new-name"
                                />
                            </FormField>
                            <FormField label={t('fieldDescription')}>
                                <Textarea
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
                                        setScope(v as CreatableScope)
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
                                            // Recertifies one legacy application's accounts
                                            // from its latest reconciled pull; picked below.
                                            ['LEGACY_APP', t('scopeLegacyApp')],
                                            // Recertifies the registered agents (#3674): one subject
                                            // per agent, a reviewer pack each, created at its own
                                            // endpoint.
                                            ['AGENT', t('scopeAgent')],
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
                                        {directoryStatusKnown && syncedProviders.size === 0 && (
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
                            {scope === 'LEGACY_APP' ? (
                                <FormField
                                    label={t('fieldLegacyConnection')}
                                    hint={t('legacyConnectionHint')}
                                    required
                                >
                                    <div data-testid="access-review-new-legacy-connection">
                                        <Combobox
                                            id="access-review-legacy-connection-select"
                                            placeholder={t('legacyConnectionPlaceholder')}
                                            selected={legacyOptions.find((o) => o.value === legacyConnectionId) ?? null}
                                            setSelected={(opt) => setLegacyConnectionId(opt?.value ?? '')}
                                            options={legacyOptions}
                                            matchTriggerWidth
                                        />
                                        {/* Three states, not two: a list that
                                            could not be read is not a tenant
                                            with no legacy application, and only
                                            the second is fixed by connecting
                                            one. */}
                                        {legacyQuery.error ? (
                                            <p
                                                className="mt-tight text-xs text-content-warning"
                                                data-testid="access-review-legacy-connections-unavailable"
                                            >
                                                {t('legacyConnectionsUnavailable')}
                                            </p>
                                        ) : legacyConnections !== null && legacyConnections.length === 0 ? (
                                            <p
                                                className="mt-tight text-xs text-content-warning"
                                                data-testid="access-review-no-legacy-connections"
                                            >
                                                {t('legacyConnectionsNone')}{' '}
                                                <Link
                                                    href={`/t/${tenantSlug}/admin/integrations`}
                                                    className="text-content-info hover:underline"
                                                    id="access-review-connect-legacy-link"
                                                >
                                                    {t('legacyConnectLink')}
                                                </Link>
                                            </p>
                                        ) : null}
                                    </div>
                                </FormField>
                            ) : null}
                            {scope === 'AGENT' ? (
                                <>
                                    <FormField label={t('fieldPreparer')} hint={t('preparerHint')} required>
                                        <div data-testid="access-review-new-preparer">
                                            <Combobox
                                                id="access-review-preparer-select"
                                                selected={agentOptions.find((o) => o.value === preparerAgentId) ?? null}
                                                setSelected={(opt) => setPreparerAgentId(opt?.value ?? '')}
                                                options={agentOptions}
                                                matchTriggerWidth
                                            />
                                        </div>
                                    </FormField>
                                    <FormField label={t('fieldCrossPreparer')} description={t('crossPreparerHint')}>
                                        <div data-testid="access-review-new-cross-preparer">
                                            <Combobox
                                                id="access-review-cross-preparer-select"
                                                selected={agentOptions.find((o) => o.value === crossPreparerAgentId) ?? null}
                                                setSelected={(opt) => setCrossPreparerAgentId(opt?.value ?? '')}
                                                options={agentOptions.filter((o) => o.value !== preparerAgentId)}
                                                matchTriggerWidth
                                            />
                                        </div>
                                    </FormField>
                                </>
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
                            <FormField label={t('fieldPeriod')} hint={t('periodHint')}>
                                <div data-testid="access-review-new-period">
                                    <DateRangePicker
                                        id="access-review-period-range"
                                        className="w-full"
                                        align="start"
                                        placeholder={t('periodPlaceholder')}
                                        value={period}
                                        onChange={setPeriod}
                                        showYearNavigation
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
