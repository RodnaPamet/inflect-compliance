'use client';

/**
 * Shared Evidence sub-table.
 *
 * Originally extracted from the control detail `page.tsx` (R10-PR3) as
 * part of the raw-`<table>` → `<DataTable>` migration. Now SHARED — the
 * control Evidence tab AND the task Evidence tab both render through it.
 * It stays under `controls/[controlId]/_tabs/` (rather than moving to
 * `@/components/`) so the existing guard exemptions + unit test keyed on
 * this path keep working; the task detail page imports it via the
 * `@/app/...` alias. Behaviour is identical across consumers; the task
 * tab opts into direct-evidence removal via `onUnlinkEvidence`.
 *
 * The evidence tab interleaves two source arrays:
 *   • `links` — EvidenceLinkDTO rows: PLAIN links (`ControlEvidenceLink`)
 *     that never reached the evidence library, so they carry no review
 *     status. The control tab no longer writes them (#4126); older ones
 *     still show, labelled as plain links.
 *   • `directEvidence` — Evidence entities (library records) attached
 *     straight to the parent.
 *
 * Every enum reaching the DOM goes through the library's own label helpers
 * (`@/components/evidence/evidence-labels`), so a row reads "Draft" / "File"
 * here exactly as it does in the library, in both locales.
 *
 * Pre-migration both were rendered into one raw `<table>` with two
 * `.map()` passes. The unified row shape below preserves the rendering
 * 1:1 (StatusBadge variants, "Title/URL" cell handling for both link
 * + evidence rows, Actions column gated by canWrite) while the
 * DataTable primitive supplies hover surface, circular row-select,
 * skeleton/empty-state chrome, and the future column-visibility gear.
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { DataTable, createColumns } from '@/components/ui/table';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { textLinkVariants } from '@/components/ui/typography';
import { normaliseHref } from '@/lib/security/safe-url';
import { formatDate } from '@inflect/ui/lib/format-date';
import type { EvidenceLinkDTO } from '@/lib/dto';
import {
    evidenceStatusLabel,
    evidenceStatusVariant,
    evidenceTypeLabel,
} from '@/components/evidence/evidence-labels';

// Evidence rows on the control/risk/asset evidence tabs — the `Evidence`
// model fields the table renders (Dates serialize to ISO strings on the wire).
export interface EvidenceTabRow {
    id: string;
    type: 'FILE' | 'LINK' | 'TEXT';
    title: string;
    content: string | null;
    status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'NEEDS_REVIEW';
    fileRecordId: string | null;
    createdAt: string;
    /**
     * Who attached this record to the parent. Only the control tab supplies
     * it (from the `EvidenceControlLink` join's creator); absent elsewhere,
     * where "Added by" stays a dash.
     */
    addedBy?: { id?: string; name: string | null } | null;
}

export interface EvidenceTabData {
    links: EvidenceLinkDTO[];
    evidence: EvidenceTabRow[];
}

interface EvidenceTableRow {
    rowKey: string;
    /**
     * The raw enum and which vocabulary labels it: a plain link's
     * `EvidenceLinkKind` or a library record's `EvidenceType`. Labels are
     * resolved in the cell, not here, so `rows` depends on `data` alone.
     */
    kind: { source: 'link' | 'evidence'; value: string; variant: StatusBadgeVariant };
    /** Library record title — links to the record in the library. */
    titleText?: string;
    /** External address: a plain link's `url`, a LINK record's `content`. */
    href?: string;
    /** A plain link's note. Shown with or without an address (#4126). */
    note?: string;
    createdByName?: string;
    /** Library records only (`EvidenceStatus`). A plain link reads "No review status". */
    status?: string;
    createdAt?: string | Date | null;
    linkId?: string;           // present on link rows we can unlink
    evidenceId?: string;       // present on direct-evidence rows we can unlink
}

/** `EvidenceLinkKind` members that `sharedPanels.evidenceTab.linkKinds` labels. */
const PLAIN_LINK_KINDS: ReadonlySet<string> = new Set(['FILE', 'LINK', 'INTEGRATION_RESULT', 'BIA']);

export function EvidenceSubTable({
    data,
    loading,
    canWrite,
    onUnlink,
    onUnlinkEvidence,
    tenantHref,
}: {
    data: EvidenceTabData | undefined;
    loading: boolean;
    canWrite: boolean;
    /**
     * Detach a ControlEvidenceLink join row. Optional, mirroring
     * `onUnlinkEvidence`: only the control tab has a link join table.
     * The task tab's payload always carries `links: []` (tasks own
     * evidence directly via `Evidence.taskId`), so it has no link to
     * detach and passes nothing rather than a no-op handler.
     */
    onUnlink?: (linkId: string) => void;
    /**
     * Opt-in removal for direct-evidence rows (Evidence entities, not
     * link rows). The control evidence tab omits it — its direct
     * Evidence stays read-only there. The task evidence tab passes it
     * so task-attached evidence (which IS direct, via Evidence.taskId)
     * is removable. Absent ⇒ no remove button on direct-evidence rows.
     */
    onUnlinkEvidence?: (evidenceId: string) => void;
    tenantHref: (path: string) => string;
}) {
    const t = useTranslations('sharedPanels');
    const te = useTranslations('evidence');
    const rows = useMemo<EvidenceTableRow[]>(() => {
        const links = data?.links ?? [];
        // EP-3 — Evidence entities reach the control through the
        // EvidenceControlLink join; ControlEvidenceLink (`links`) now only
        // carries genuinely non-Evidence artifacts (url / integration / bia),
        // so the old fileRecordId dedup that compensated for the dual
        // representation is gone.
        const directEvidence = data?.evidence ?? [];

        const out: EvidenceTableRow[] = [];
        for (const el of links) {
            out.push({
                rowKey: `link-${el.id}`,
                kind: {
                    source: 'link',
                    value: el.kind,
                    variant: el.kind === 'FILE' ? 'success' : 'info',
                },
                href: el.url ?? undefined,
                note: el.note ?? undefined,
                createdByName: el.createdBy?.name ?? undefined,
                createdAt: el.createdAt,
                linkId: el.id,
            });
        }
        for (const ev of directEvidence) {
            // LINK-type evidence carries its URL in `content`; it renders
            // under the title as an external href. The title itself always
            // opens the record in the library, where it is reviewed.
            const isUrlEvidence = ev.type === 'LINK' && !!ev.content;
            out.push({
                rowKey: `ev-${ev.id}`,
                kind: {
                    source: 'evidence',
                    value: ev.type,
                    variant:
                        ev.type === 'FILE'
                            ? 'success'
                            : ev.type === 'TEXT'
                              ? 'neutral'
                              : 'info',
                },
                titleText: ev.title,
                href: isUrlEvidence ? (ev.content ?? undefined) : undefined,
                evidenceId: ev.id,
                createdByName: ev.addedBy?.name ?? undefined,
                status: ev.status,
                createdAt: ev.createdAt,
            });
        }
        return out;
    }, [data]);

    const columns = useMemo(
        () =>
            createColumns<EvidenceTableRow>([
                {
                    id: 'type',
                    header: t('evidenceTab.colType'),
                    cell: ({ row }) => {
                        const { kind } = row.original;
                        // A plain link's LINK reads "Plain link" so it cannot be
                        // mistaken for a library LINK record, which has a review
                        // status. A local set, not a `t.has` probe: most
                        // hand-rolled next-intl test mocks implement only `t`
                        // (see `entity-prev-next-nav.tsx`).
                        const label =
                            kind.source === 'evidence'
                                ? evidenceTypeLabel(kind.value, te)
                                : PLAIN_LINK_KINDS.has(kind.value)
                                  ? t(`evidenceTab.linkKinds.${kind.value}`)
                                  : kind.value;
                        return <StatusBadge variant={kind.variant}>{label}</StatusBadge>;
                    },
                },
                {
                    id: 'title',
                    header: t('evidenceTab.colTitle'),
                    cell: ({ row }) => {
                        const r = row.original;
                        // Followable only when safe (`normaliseHref`); an unsafe
                        // address is still shown, as text.
                        const safeHref = normaliseHref(r.href);
                        const external = r.href ? (
                            safeHref ? (
                                <a
                                    href={safeHref}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={textLinkVariants({ tone: 'link' })}
                                >
                                    {r.href}
                                </a>
                            ) : (
                                <span className="break-all text-content-default">{r.href}</span>
                            )
                        ) : null;
                        if (!r.evidenceId) {
                            // A plain link: its address, then its note. The
                            // note used to render only when there was NO
                            // address, so a web link's note never showed.
                            return (
                                <span className="flex flex-col text-sm">
                                    {external}
                                    {r.note ? (
                                        <span className="text-xs text-content-muted">
                                            {r.note}
                                        </span>
                                    ) : null}
                                    {!external && !r.note ? '—' : null}
                                </span>
                            );
                        }
                        return (
                            <span className="flex flex-col text-sm">
                                <Link
                                    // Deep-link to the specific evidence record
                                    // (opens its detail sheet) instead of the
                                    // whole library.
                                    href={tenantHref(`/evidence?ev=${r.evidenceId}`)}
                                    className={textLinkVariants({ tone: 'link' })}
                                >
                                    {r.titleText}
                                </Link>
                                {external ? (
                                    <span className="text-xs">{external}</span>
                                ) : null}
                            </span>
                        );
                    },
                },
                {
                    // R2-P2 — "Added by" (provenance) split out of the
                    // overloaded Status column so creator ≠ approval-status.
                    id: 'addedBy',
                    header: t('evidenceTab.colAddedBy'),
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted">
                            {row.original.createdByName || '—'}
                        </span>
                    ),
                },
                {
                    id: 'status',
                    header: t('evidenceTab.colStatus'),
                    cell: ({ row }) => {
                        // Approval status only — never the creator name. A
                        // plain link never reached the library, so it has no
                        // review status, and says so rather than a bare dash.
                        const r = row.original;
                        return r.status ? (
                            <StatusBadge variant={evidenceStatusVariant(r.status)}>
                                {evidenceStatusLabel(r.status, te)}
                            </StatusBadge>
                        ) : (
                            <span className="text-xs text-content-subtle">
                                {t('evidenceTab.noReviewStatus')}
                            </span>
                        );
                    },
                },
                {
                    id: 'date',
                    header: t('evidenceTab.colDate'),
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted">
                            {row.original.createdAt
                                ? formatDate(row.original.createdAt)
                                : '—'}
                        </span>
                    ),
                },
                ...(canWrite
                    ? [
                          {
                              id: 'actions',
                              header: t('evidenceTab.colActions'),
                              cell: ({ row }: { row: { original: EvidenceTableRow } }) => {
                                  const r = row.original;
                                  if (r.linkId && onUnlink) {
                                      return (
                                          <button
                                              className="text-content-error text-xs hover:text-content-error"
                                              onClick={() => onUnlink(r.linkId!)}
                                              id={`unlink-${r.linkId}`}
                                          >
                                              {t('evidenceTab.remove')}
                                          </button>
                                      );
                                  }
                                  if (r.evidenceId && onUnlinkEvidence) {
                                      return (
                                          <button
                                              className="text-content-error text-xs hover:text-content-error"
                                              onClick={() => onUnlinkEvidence(r.evidenceId!)}
                                              id={`unlink-evidence-${r.evidenceId}`}
                                          >
                                              {t('evidenceTab.remove')}
                                          </button>
                                      );
                                  }
                                  return null;
                              },
                          },
                      ]
                    : []),
            ]),
        [canWrite, onUnlink, onUnlinkEvidence, tenantHref, t, te],
    );

    // E2E semantics — preserve the pre-migration contract:
    //
    //   • `#evidence-table` is present ONLY when rows are rendering.
    //     `toBeVisible({...})` in the E2E specs is therefore a
    //     wait-for-data signal (the helper `linkUrlEvidence` relies
    //     on this — it clicks Submit and then asserts visibility, and
    //     the next assertion immediately reads `tbody tr` row count).
    //   • The empty-state branch retains `#no-evidence` (its own
    //     distinct selector).
    //   • DataTable mounts a real `<table>` inside the wrapper, so
    //     `#evidence-table tbody tr` descent still works for
    //     row-count / row-click assertions.
    // `selectionEnabled={false}` is load-bearing — DataTable defaults
    // selection to ON, which adds a leading checkbox `<button>` to
    // every row. That would make `#evidence-table tbody tr button`
    // (used by `control-evidence.spec.ts` to find the unlink button)
    // match the checkbox first instead of the unlink. Selection
    // would be useless on a detail sub-table anyway — no batch ops.
    if (rows.length === 0) {
        return (
            <DataTable
                data={rows}
                columns={columns}
                getRowId={(r) => r.rowKey}
                loading={loading}
                selectionEnabled={false}
                emptyState={
                    <div id="no-evidence">
                        <InlineEmptyState
                            title={t('evidenceTab.emptyTitle')}
                            description={t('evidenceTab.emptyDesc')}
                        />
                    </div>
                }
            />
        );
    }
    return (
        <div id="evidence-table">
            <DataTable
                data={rows}
                columns={columns}
                getRowId={(r) => r.rowKey}
                loading={loading}
                selectionEnabled={false}
            />
        </div>
    );
}
