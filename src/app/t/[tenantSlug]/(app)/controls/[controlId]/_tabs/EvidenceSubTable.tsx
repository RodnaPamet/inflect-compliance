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
 *   • `links` — EvidenceLinkDTO rows (user-attached URLs / file refs)
 *   • `directEvidence` — Evidence entities attached straight to the
 *     control, deduped against the `links` set by `fileRecordId`.
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
import { formatDate } from '@/lib/format-date';
import type { EvidenceLinkDTO } from '@/lib/dto';

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
}

export interface EvidenceTabData {
    links: EvidenceLinkDTO[];
    evidence: EvidenceTabRow[];
}

interface EvidenceTableRow {
    rowKey: string;
    kindBadge: { label: string; variant: StatusBadgeVariant };
    titleCell: 'link-href' | 'evidence-title';
    titleHref?: string;
    titleNote?: string;
    titleText?: string;
    statusCell: 'createdBy' | 'badge';
    createdByName?: string;
    statusBadge?: { label: string; variant: StatusBadgeVariant };
    createdAt?: string | Date | null;
    linkId?: string;           // present on link rows we can unlink
    evidenceId?: string;       // present on direct-evidence rows we can unlink
}

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
    const t = useTranslations('controls');
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
                kindBadge: {
                    label: el.kind,
                    variant: el.kind === 'FILE' ? 'success' : 'info',
                },
                titleCell: 'link-href',
                titleHref: el.url ?? undefined,
                titleNote: el.note ?? undefined,
                statusCell: 'createdBy',
                createdByName: el.createdBy?.name ?? undefined,
                createdAt: el.createdAt,
                linkId: el.id,
            });
        }
        for (const ev of directEvidence) {
            // LINK-type evidence carries its URL in `content`; render it
            // as an external href so a task URL-evidence row reads the
            // same as a control link row. FILE / TEXT evidence keep the
            // title-link-to-library treatment.
            const isUrlEvidence = ev.type === 'LINK' && !!ev.content;
            out.push({
                rowKey: `ev-${ev.id}`,
                kindBadge: {
                    label: ev.type,
                    variant:
                        ev.type === 'FILE'
                            ? 'success'
                            : ev.type === 'TEXT'
                              ? 'neutral'
                              : 'info',
                },
                titleCell: isUrlEvidence ? 'link-href' : 'evidence-title',
                titleHref: isUrlEvidence ? (ev.content ?? undefined) : undefined,
                titleNote: isUrlEvidence ? ev.title : undefined,
                titleText: ev.title,
                evidenceId: ev.id,
                statusCell: 'badge',
                statusBadge: {
                    label: ev.status,
                    variant:
                        ev.status === 'APPROVED'
                            ? 'success'
                            : ev.status === 'REJECTED'
                              ? 'error'
                              : ev.status === 'SUBMITTED'
                                ? 'info'
                                : 'neutral',
                },
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
                    cell: ({ row }) => (
                        <StatusBadge variant={row.original.kindBadge.variant}>
                            {row.original.kindBadge.label}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'title',
                    header: t('evidenceTab.colTitle'),
                    cell: ({ row }) => {
                        const r = row.original;
                        if (r.titleCell === 'link-href') {
                            return (
                                <span className="text-sm">
                                    {r.titleHref ? (
                                        <a
                                            href={r.titleHref}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className={textLinkVariants({ tone: 'link' })}
                                        >
                                            {r.titleHref}
                                        </a>
                                    ) : (
                                        r.titleNote || '—'
                                    )}
                                </span>
                            );
                        }
                        return (
                            <span className="text-sm">
                                <Link
                                    // Deep-link to the specific evidence record
                                    // (opens its detail sheet) instead of the
                                    // whole library.
                                    href={tenantHref(r.evidenceId ? `/evidence?ev=${r.evidenceId}` : `/evidence`)}
                                    className={textLinkVariants({ tone: 'link' })}
                                >
                                    {r.titleText}
                                </Link>
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
                        // Approval status only — never the creator name.
                        const r = row.original;
                        return r.statusBadge ? (
                            <StatusBadge variant={r.statusBadge.variant}>
                                {r.statusBadge.label}
                            </StatusBadge>
                        ) : (
                            <span className="text-content-subtle">—</span>
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
        [canWrite, onUnlink, onUnlinkEvidence, tenantHref, t],
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
