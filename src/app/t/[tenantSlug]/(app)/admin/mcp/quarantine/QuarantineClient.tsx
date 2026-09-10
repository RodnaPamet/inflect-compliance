'use client';

/**
 * QUARANTINE TRIAGE — what the agentic output guard refused, and what it was
 * asked to write.
 *
 * `createAgentProposal` writes a quarantined row instead of throwing because
 * "the row is the only durable evidence that the attempt happened, and an
 * operator triaging an injection needs to see what was tried". This page is the
 * only place that evidence is legible: the `AGENT_PROPOSAL_QUARANTINED` audit
 * entry proves an attempt occurred and deliberately carries rule ids and a
 * digest rather than content, so the audit log can answer WHEN and WHICH RULE
 * and can never answer WHAT.
 *
 * ## There is no approve control here, and its absence is the feature
 *
 * Quarantine is terminal by product decision — `approveAgentProposal` refuses
 * every row this page lists, and `listAgentProposals` excludes them from the
 * reviewer's queue unconditionally, including when a caller asks for them by
 * name through `?status=QUARANTINED`. A "review anyway" affordance here would
 * be the one path back into the queue that the whole design exists to close, so
 * the page reads and never writes. The banner says so on the page rather than
 * only in this comment, because an operator who cannot find the button will
 * otherwise assume they lack the permission.
 *
 * ## There is no "guard verdict" column, because here it is a constant
 *
 * `guardAgentProposal` sets `quarantined: verdict === 'QUARANTINED'` and
 * `createAgentProposal` writes `status: guard.quarantined ? 'QUARANTINED' :
 * 'PENDING'`. This listing selects `status = 'QUARANTINED'`, so every row it can
 * contain carries the same verdict. A column of one repeated badge costs width
 * on a triage table and carries no signal; the signal that VARIES is
 * `guardRuleIds`, which has its own column. The route does not put the field on
 * the wire either.
 *
 * That is conditional on the population, not on the field: a FLAGGED proposal
 * (a rule fired, nothing was malicious) is written `PENDING` and is NOT listed
 * here — see the implementation note for why that stayed a separate question.
 * If this page ever lists both, the verdict becomes the column that tells them
 * apart and it comes back.
 *
 * ## The search runs in the browser, and the copy has to say so
 *
 * `payloadJson` and `rationale` are in `ENCRYPTED_FIELDS` — AES-GCM at rest,
 * decrypted by the Epic B read extension on the way out. A server-side
 * `contains` over them would be matching ciphertext, so the two fields that
 * make the search worth having cannot be filtered in SQL at all. The search is
 * therefore client-side over the page the route returned, which is fine until
 * the page is TRUNCATED — and a tenant under sustained injection, the exact
 * case this surface exists for, is the one that truncates. So every message the
 * page can show while truncated names the number of rows it actually searched
 * and says the older ones were not. Do not restore copy that promises the whole
 * population.
 *
 * ## The payload is rendered inert, and only in the sheet
 *
 * The attempted content is attacker-supplied. It was sanitised at the write
 * seam and React escapes it here — it is placed in a `<pre>`, never through
 * `dangerouslySetInnerHTML`, and never into a link `href`. It lives in the
 * detail sheet rather than a table cell so that scanning the list does not put
 * a wall of injected prose in front of somebody who only wanted the counts.
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { EntityListPage } from '@/components/layout/EntityListPage';
import { FilterProvider, useFilterContext, useFilters } from '@/components/ui/filter';
import { createColumns } from '@/components/ui/table';
import { Heading } from '@/components/ui/typography';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Sheet } from '@/components/ui/sheet';
import { CopyText } from '@/components/ui/copy-text';
import { ShieldSlash } from '@/components/ui/icons/nucleo';
import { formatDateTime } from '@/lib/format-date';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';

/**
 * One quarantined proposal, exactly as
 * `GET /api/t/:slug/admin/mcp/quarantine` projects it. Declared here rather
 * than imported from the route module so a client bundle never pulls a file
 * that imports the permission middleware.
 */
export interface QuarantineRow {
    id: string;
    kind: string;
    operation: string;
    agentId: string | null;
    targetEntityId: string | null;
    guardRuleIds: string[];
    guardInputDigest: string | null;
    guardProvenance: string;
    payloadJson: string;
    rationale: string | null;
    proposedViaKeyId: string | null;
    createdAt: string;
}

export interface QuarantinePage {
    rows: QuarantineRow[];
    truncated: boolean;
}

/** The tenant-relative endpoint. One data path — the page has no SSR twin. */
export const QUARANTINE_ENDPOINT = '/admin/mcp/quarantine';

/**
 * Every field a free-text search may match, joined.
 *
 * The payload and rationale ARE searchable, and that is the point of the box:
 * the triage question is usually "did this phrase appear anywhere else", and a
 * search that covered only the metadata could not answer it.
 *
 * Its REACH is the loaded page and no further — see the header comment for why
 * it cannot be a SQL filter. The caller is responsible for saying so when the
 * page was truncated.
 */
function searchableText(row: QuarantineRow): string {
    return [
        row.id,
        row.kind,
        row.operation,
        row.agentId ?? '',
        row.targetEntityId ?? '',
        row.guardRuleIds.join(' '),
        row.guardInputDigest ?? '',
        row.guardProvenance,
        row.rationale ?? '',
        row.payloadJson,
    ]
        .join(' ')
        .toLowerCase();
}

/**
 * Pretty-print the stored payload when it parses, and fall back to the raw
 * string when it does not.
 *
 * The fallback is not defensive padding. `payloadJson` is written as
 * `JSON.stringify(sanitized)` and so should always parse — but this surface
 * exists precisely for rows that are not normal, and a triage page that renders
 * nothing when the evidence is malformed withholds the evidence at the one
 * moment it matters. Showing the raw string is strictly more informative than
 * showing an error.
 */
export function formatPayload(payloadJson: string): string {
    try {
        return JSON.stringify(JSON.parse(payloadJson), null, 2);
    } catch {
        return payloadJson;
    }
}

export interface QuarantineClientProps {
    /** Used only to build absolute breadcrumb hrefs. */
    tenantSlug: string;
}

export function QuarantineClient(props: QuarantineClientProps) {
    // No filter definitions, deliberately. The one axis worth narrowing on a
    // quarantine list is free text over the attempted content, and that is the
    // search box below; a `kind` dropdown over a list whose whole population is
    // one refusal class would be furniture.
    const filterCtx = useFilterContext([], []);
    return (
        <FilterProvider value={filterCtx}>
            <QuarantineInner {...props} />
        </FilterProvider>
    );
}

function QuarantineInner({ tenantSlug }: QuarantineClientProps) {
    const t = useTranslations('agents');
    const { search } = useFilters();
    const [openId, setOpenId] = useState<string | null>(null);

    const query = useTenantSWR<QuarantinePage>(QUARANTINE_ENDPOINT);
    const allRows = useMemo(() => query.data?.rows ?? [], [query.data]);

    const needle = search.trim().toLowerCase();
    const rows = useMemo(
        () => (needle ? allRows.filter((r) => searchableText(r).includes(needle)) : allRows),
        [allRows, needle],
    );

    // The server cut the page short: rows exist that this page never loaded and
    // that the browser-side search above therefore never looked at.
    const truncated = query.data?.truncated ?? false;
    // A search only NARROWED anything if there was something to narrow. With
    // zero rows loaded, "nothing matched your search" is the wrong sentence —
    // nothing is here at all, search or no search.
    const searchNarrowed = needle.length > 0 && allRows.length > 0;

    const selected = useMemo(
        () => allRows.find((r) => r.id === openId) ?? null,
        [allRows, openId],
    );

    const columns = useMemo(
        () =>
            createColumns<QuarantineRow>([
                {
                    id: 'createdAt',
                    header: t('quarantine.colWhen'),
                    accessorFn: (r) => r.createdAt,
                    cell: ({ row }) => (
                        <span
                            className="whitespace-nowrap text-content-muted"
                            data-testid={`quarantine-row-${row.original.id}`}
                        >
                            {formatDateTime(row.original.createdAt)}
                        </span>
                    ),
                },
                {
                    id: 'agentId',
                    header: t('quarantine.colAgent'),
                    accessorFn: (r) => r.agentId ?? '',
                    cell: ({ row }) =>
                        row.original.agentId ? (
                            <span className="truncate font-medium text-content-default">
                                {row.original.agentId}
                            </span>
                        ) : (
                            // Not a dash. A NULL here means the credential named
                            // no registered agent, which is a finding in its own
                            // right — it is the state a tenant with the
                            // registration gate switched off can still produce.
                            <span className="text-content-subtle">
                                {t('quarantine.unattributed')}
                            </span>
                        ),
                },
                {
                    id: 'kind',
                    header: t('quarantine.colKind'),
                    accessorFn: (r) => r.kind,
                    cell: ({ row }) => (
                        <span className="text-content-muted">
                            {t('quarantine.kindOperation', {
                                kind: row.original.kind,
                                operation: row.original.operation,
                            })}
                        </span>
                    ),
                },
                {
                    id: 'guardRuleIds',
                    header: t('quarantine.colRules'),
                    accessorFn: (r) => r.guardRuleIds.join(' '),
                    cell: ({ row }) =>
                        row.original.guardRuleIds.length > 0 ? (
                            <span className="font-mono text-content-muted">
                                {row.original.guardRuleIds.join(', ')}
                            </span>
                        ) : (
                            // A quarantined row with no rule ids would mean the
                            // verdict came from somewhere the rule table cannot
                            // explain. Saying so is more useful than an empty
                            // cell that reads as "nothing to see".
                            <span className="text-content-subtle">
                                {t('guard.noRules')}
                            </span>
                        ),
                },
                {
                    id: 'guardInputDigest',
                    header: t('quarantine.colDigest'),
                    accessorFn: (r) => r.guardInputDigest ?? '',
                    cell: ({ row }) => (
                        <span className="font-mono text-content-subtle">
                            {shortDigest(row.original.guardInputDigest)}
                        </span>
                    ),
                },
            ]),
        [t],
    );

    // Stable identities — a fresh one rebuilds the table model mid-click.
    const getRowId = useCallback((r: QuarantineRow) => r.id, []);
    const onRowClick = useCallback(
        (row: { original: QuarantineRow }) => setOpenId(row.original.id),
        [],
    );

    const loadError = query.error
        ? query.error instanceof Error
            ? query.error.message
            : t('quarantine.loadFailed')
        : undefined;

    return (
        <>
            <EntityListPage<QuarantineRow>
                header={{
                    back: { smart: true },
                    breadcrumbs: [
                        { label: t('crumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                        { label: t('crumbAdmin'), href: `/t/${tenantSlug}/admin` },
                        { label: t('crumbMcp'), href: `/t/${tenantSlug}/admin/mcp` },
                        { label: t('quarantine.crumb') },
                    ],
                    title: (
                        <>
                            <ShieldSlash className="mr-2 inline-block h-5 w-5 align-text-bottom" />
                            {t('quarantine.title')}
                        </>
                    ),
                    // "100 quarantined" is a claim about the population, and
                    // it is false as soon as the server cut the page short.
                    count: truncated
                        ? t('quarantine.countTruncated', { total: allRows.length })
                        : t('quarantine.count', { total: allRows.length }),
                }}
                filters={{
                    defs: [],
                    searchId: 'quarantine-search',
                    searchPlaceholder: t('quarantine.searchPlaceholder'),
                }}
                banner={
                    <div className="space-y-default">
                        <InlineNotice variant="info">
                            {t('quarantine.terminalNotice')}
                        </InlineNotice>
                        {truncated && (
                            // Rendered above the table, so it stays on screen in
                            // the empty-search case too — that is precisely when
                            // a reader is trying to conclude something from an
                            // absence.
                            <InlineNotice variant="warning">
                                {t('quarantine.truncated', { shown: allRows.length })}
                            </InlineNotice>
                        )}
                    </div>
                }
                table={{
                    'data-testid': 'quarantine-table',
                    data: rows,
                    columns,
                    getRowId,
                    onRowClick,
                    // The select column is DEFAULT-ON across the product, and
                    // it is wrong here on both counts. Nothing on this page
                    // acts on a selection — quarantine is terminal, so there is
                    // no bulk verb to offer — so the checkboxes would be a
                    // control that does nothing. And with selection on, a
                    // single click toggles it and the row action moves to
                    // DOUBLE click, which would put the payload (the only
                    // reason to open a row at all) behind an undiscoverable
                    // gesture.
                    selectionEnabled: false,
                    loading: query.isLoading,
                    error: loadError,
                    resourceName: (plural) =>
                        plural
                            ? t('quarantine.resourcePlural')
                            : t('quarantine.resourceSingular'),
                    emptyState: (
                        <EmptyState
                            icon={ShieldSlash}
                            title={
                                searchNarrowed
                                    ? t('quarantine.emptyMatchingTitle')
                                    : t('quarantine.emptyTitle')
                            }
                            description={
                                searchNarrowed
                                    ? truncated
                                        ? // The search covered the loaded page
                                          // only. Saying "clear it to see every
                                          // quarantined proposal" here would be
                                          // false in the one case that matters.
                                          t('quarantine.emptyMatchingDescTruncated', {
                                              shown: allRows.length,
                                          })
                                        : t('quarantine.emptyMatchingDesc', {
                                              shown: allRows.length,
                                          })
                                    : t('quarantine.emptyDesc')
                            }
                        />
                    ),
                }}
            />
            <Sheet
                open={selected !== null}
                onOpenChange={(next) => {
                    if (!next) setOpenId(null);
                }}
                size="lg"
                title={t('quarantine.sheetTitle')}
            >
                {selected && (
                    <>
                        <Sheet.Header title={t('quarantine.sheetTitle')} />
                        <Sheet.Body>
                            <div className="space-y-default" data-testid="quarantine-detail">
                                <dl className="space-y-tight">
                                    <Field label={t('quarantine.sheetWhen')}>
                                        {formatDateTime(selected.createdAt)}
                                    </Field>
                                    <Field label={t('quarantine.sheetAgent')}>
                                        {selected.agentId ?? t('quarantine.unattributed')}
                                    </Field>
                                    <Field label={t('quarantine.sheetKind')}>
                                        {t('quarantine.kindOperation', {
                                            kind: selected.kind,
                                            operation: selected.operation,
                                        })}
                                    </Field>
                                    <Field label={t('quarantine.sheetTarget')}>
                                        {selected.targetEntityId ?? t('quarantine.none')}
                                    </Field>
                                    <Field label={t('quarantine.sheetProvenance')}>
                                        {selected.guardProvenance}
                                    </Field>
                                    <Field label={t('quarantine.sheetCredential')}>
                                        {selected.proposedViaKeyId ?? t('quarantine.none')}
                                    </Field>
                                    <Field label={t('quarantine.sheetRules')}>
                                        {selected.guardRuleIds.length > 0
                                            ? selected.guardRuleIds.join(', ')
                                            : t('guard.noRules')}
                                    </Field>
                                    <Field label={t('quarantine.sheetDigest')}>
                                        {selected.guardInputDigest ? (
                                            <CopyText
                                                value={selected.guardInputDigest}
                                                label={t('quarantine.sheetDigest')}
                                                truncate
                                            />
                                        ) : (
                                            t('quarantine.none')
                                        )}
                                    </Field>
                                </dl>

                                <section className="space-y-tight">
                                    <Heading level={3} as="h3">
                                        {t('quarantine.sheetRationale')}
                                    </Heading>
                                    <pre
                                        className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border-subtle bg-bg-subtle p-3 font-mono text-xs text-content-muted"
                                        data-testid="quarantine-rationale"
                                    >
                                        {selected.rationale ?? t('quarantine.none')}
                                    </pre>
                                </section>

                                <section className="space-y-tight">
                                    <Heading level={3} as="h3">
                                        {t('quarantine.sheetPayload')}
                                    </Heading>
                                    <InlineNotice variant="warning">
                                        {t('quarantine.sheetPayloadWarning')}
                                    </InlineNotice>
                                    <pre
                                        className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border-subtle bg-bg-subtle p-3 font-mono text-xs text-content-muted"
                                        data-testid="quarantine-payload"
                                    >
                                        {formatPayload(selected.payloadJson)}
                                    </pre>
                                </section>
                            </div>
                        </Sheet.Body>
                    </>
                )}
            </Sheet>
        </>
    );
}

/**
 * The first 16 hex characters after the `sha256:` prefix.
 *
 * Enough to recognise a repeat attempt at a glance in a list; the sheet carries
 * the whole digest behind a copy control, because the value's real use is
 * pasting it into the audit log or the AI decision log to join the same content
 * across records.
 */
export function shortDigest(digest: string | null): string {
    if (!digest) return '—';
    const hex = digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : digest;
    return hex.length > 16 ? `${hex.slice(0, 16)}…` : hex;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-tight sm:flex-row sm:items-baseline sm:gap-compact">
            <dt className="min-w-[10rem] text-xs uppercase tracking-wide text-content-subtle">
                {label}
            </dt>
            <dd className="min-w-0 break-words text-sm text-content-default">{children}</dd>
        </div>
    );
}
