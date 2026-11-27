'use client';

import { useState, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import {
    FilterX, Link2, FileText, AlertTriangle,
    CheckCircle2, XCircle, HelpCircle,
    Plus, MessageSquare, Printer, Download,
} from 'lucide-react';
import type { SoAReportDTO, SoAEntryDTO } from '@/lib/dto/soa';
import { Modal } from '@/components/ui/modal';
import { Tooltip } from '@/components/ui/tooltip';
import { Textarea } from '@/components/ui/textarea';
import { buttonLikeKeys } from '@/components/ui/button-like-keys';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@inflect/ui/components/ui/hooks/use-toast';
import { textLinkVariants } from '@/components/ui/typography';
import { StatusBadge as StatusBadgePrimitive, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { cardVariants } from '@/components/ui/card';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { cn } from '@inflect/ui/lib/cn';
import { CONTROL_STATUS_VARIANT } from '@/app-layer/domain/entity-status-mapping';
import { formatDate } from '@inflect/ui/lib/format-date';
import { PageHeader } from '@/components/layout/PageHeader';
import { RequirePermission } from '@/components/require-permission';
import { UpgradeGate } from '@/components/UpgradeGate';
import { apiErrorMessage } from '@/lib/api-error';
import { useIsBelowMd } from '@/components/ui/hooks';
import { KpiStrip } from '@/components/ui/kpi-strip';
import { useSoASectionLabel } from '@/app/t/[tenantSlug]/(app)/reports/soa/section-label';
import { useContentText } from '@/lib/content-i18n/use-content-text';

// ─── Types ───

interface ControlOption {
    id: string;
    code: string | null;
    name: string;
    status: string;
}

interface SoAClientProps {
    report: SoAReportDTO;
    controls: ControlOption[];
    tenantSlug: string;
    canEdit: boolean;
}

// ─── Badge helpers ───

function ApplicabilityBadge({ value }: { value: boolean | null }) {
    const t = useTranslations('reports');
    if (value === true)  return <StatusBadgePrimitive variant="success">{t('soaView.applicable')}</StatusBadgePrimitive>;
    if (value === false) return <StatusBadgePrimitive variant="neutral">{t('soaView.notApplicable')}</StatusBadgePrimitive>;
    return <StatusBadgePrimitive variant="error">{t('soaView.unmapped')}</StatusBadgePrimitive>;
}

/** The `ControlStatus` enum, worded from `soaView.controlStatus.*` (#4740). */
type ControlStatusValue = 'NOT_STARTED' | 'PLANNED' | 'IN_PROGRESS' | 'IMPLEMENTING' | 'IMPLEMENTED' | 'NEEDS_REVIEW' | 'NOT_APPLICABLE';

function StatusBadge({ value }: { value: string | null }) {
    const t = useTranslations('reports');
    if (!value) return <span className="text-content-subtle text-xs">—</span>;
    return (
        <StatusBadgePrimitive variant={CONTROL_STATUS_VARIANT[value] || 'neutral'}>
            {t(`soaView.controlStatus.${value as ControlStatusValue}`)}
        </StatusBadgePrimitive>
    );
}

// R2-P5 — the EXCEPTED verdict: risk-accepted via an in-force exception,
// visually distinct from Covered and Gap, always time-boxed. Never reads as
// implemented.
function ExceptedBadge({ until, t }: { until: string | null; t: (k: string, v?: Record<string, string>) => string }) {
    return (
        <StatusBadgePrimitive variant="warning" data-testid="soa-excepted-badge">
            {until
                ? t('soaView.exceptedUntil', { date: formatDate(until) })
                : t('soaView.excepted')}
        </StatusBadgePrimitive>
    );
}

function GapBadges({ entry }: { entry: SoAEntryDTO }) {
    // Roadmap-2 PR-7 — gap badges flow through the canonical
    // `<StatusBadgePrimitive>` so the pill shape, size, and tone-
    // mapping match every other status across the product.
    const t = useTranslations('reports');
    const gaps: React.JSX.Element[] = [];
    if (entry.applicable === null) {
        gaps.push(
            <StatusBadgePrimitive key="unmapped" variant="error">
                <AlertTriangle className="w-3.5 h-3.5" /> {t('soaView.unmapped')}
            </StatusBadgePrimitive>
        );
    }
    if (entry.applicable === false) {
        const hasMissing = entry.mappedControls.some(c => c.applicability === 'NOT_APPLICABLE' && !c.justification);
        if (hasMissing) {
            gaps.push(
                <StatusBadgePrimitive key="justification" variant="warning">
                    <MessageSquare className="w-3.5 h-3.5" /> {t('soaView.justificationMissing')}
                </StatusBadgePrimitive>
            );
        }
    }
    return gaps.length > 0 ? <div className="flex flex-wrap gap-1">{gaps}</div> : null;
}

// ─── Main Component ───

export function SoAClient({ report, controls, tenantSlug, canEdit }: SoAClientProps) {
    const t = useTranslations('reports');
    const tc = useContentText();
    const router = useRouter();
    // R14-PR7 — standalone main-page search retired. The "Show gaps
    // only" toggle remains as the primary in-page filter; users
    // looking for a specific requirement use the global command
    // palette (⌘K) or the Annex A code list. The MODAL search (for
    // picking a control to map) stays — it's a picker affordance,
    // not a page-level search.
    const [gapsOnly, setGapsOnly] = useState(false);
    const [expandedRow, setExpandedRow] = useState<string | null>(null);

    // Modal state
    const [mapModal, setMapModal] = useState<{ requirementId: string; requirementCode: string } | null>(null);
    const [justModal, setJustModal] = useState<{ controlId: string; controlCode: string; requirementCode: string } | null>(null);
    // Searchbar-kill sweep — the modal's `<input>` was retired
    // alongside every other in-app search bar. The modal now lists
    // controls unfiltered; users find a specific control via the
    // ⌘K palette (which navigates) or scroll the list.
    const [justText, setJustText] = useState('');
    const [saving, setSaving] = useState(false);
    // R2-P3 — restored searchable picker for the map-control modal.
    const [mapSearch, setMapSearch] = useState('');
    const toast = useToast();
    // A phone (below `md`) reads the SoA as one card per requirement and the
    // summary as a scrolling strip; the 7-column table and the 7-tile grid
    // stay for larger screens. `false` on the server and the first render,
    // so the desktop layout is the default everywhere but a narrow viewport
    // (the DataTable card fallback works the same way).
    const belowMd = useIsBelowMd();

    const apiUrl = useCallback((path: string) => `/api/t/${tenantSlug}${path}`, [tenantSlug]);

    /**
     * What a refused map or justification says (#4740): a role that cannot
     * change controls is told so; another refusal shows the server's reason;
     * only a failure to reach it reads "please try again".
     */
    const refusalText = async (res: Response, fallback: string) => {
        if (res.status === 403) return t('soaView.writeRestricted');
        if (res.status >= 500) return fallback;
        const body: unknown = await res.json().catch(() => null);
        return apiErrorMessage(body, fallback);
    };

    // ─── Filtering ───

    const filteredEntries = useMemo(() => {
        let entries = report.entries;

        if (gapsOnly) {
            entries = entries.filter(e => {
                if (e.applicable === null) return true; // unmapped
                if (e.applicable === false) {
                    return e.mappedControls.some(c => c.applicability === 'NOT_APPLICABLE' && !c.justification);
                }
                return false;
            });
        }

        return entries;
    }, [report.entries, gapsOnly]);

    // ─── Actions ───

    const handleMapControl = async (controlId: string) => {
        if (!mapModal) return;
        setSaving(true);
        try {
            const res = await fetch(apiUrl('/reports/soa/map'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ requirementId: mapModal.requirementId, controlId }),
            });
            if (!res.ok) {
                toast.error(await refusalText(res, t('soaView.mapFailed')));
                return;
            }
            setMapModal(null);
            setMapSearch('');
            router.refresh();
        } catch {
            // Surface the failure instead of silently leaving the modal open.
            toast.error(t('soaView.mapFailed'));
        } finally {
            setSaving(false);
        }
    };

    const handleSaveJustification = async () => {
        if (!justModal) return;
        setSaving(true);
        try {
            // Applicability has its own endpoint. The control PATCH is
            // `.strict()` and declares neither field, so it refused every
            // save from here with a 400 (#5218).
            const res = await fetch(apiUrl(`/controls/${justModal.controlId}/applicability`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    applicability: 'NOT_APPLICABLE',
                    justification: justText.trim(),
                }),
            });
            if (!res.ok) {
                toast.error(await refusalText(res, t('soaView.justificationFailed')));
                return;
            }
            setJustModal(null);
            setJustText('');
            router.refresh();
        } catch {
            toast.error(t('soaView.justificationFailed'));
        } finally {
            setSaving(false);
        }
    };

    // R2-P3 — restored searchable picker, pre-filtered to controls NOT already
    // mapped to this requirement (an unfiltered 90+ control list was unusable).
    const mapFilteredControls = useMemo(() => {
        if (!mapModal) return controls;
        const alreadyMapped = new Set(
            (report.entries.find((e) => e.requirementId === mapModal.requirementId)?.mappedControls ?? [])
                .map((c) => c.controlId),
        );
        const q = mapSearch.trim().toLowerCase();
        return controls.filter((c) => {
            if (alreadyMapped.has(c.id)) return false;
            if (!q) return true;
            return (
                (c.code ?? '').toLowerCase().includes(q) ||
                c.name.toLowerCase().includes(q) ||
                tc(c.name).toLowerCase().includes(q)
            );
        });
    }, [controls, mapModal, report.entries, mapSearch, tc]);

    const { summary } = report;

    const summaryTiles = [
        <SummaryCard key="total" label={t('soaView.total')} value={summary.total} icon={<FileText className="w-4 h-4 text-content-muted" />} />,
        <SummaryCard key="applicable" label={t('soaView.applicable')} value={summary.applicable} icon={<CheckCircle2 className="w-4 h-4 text-content-success" />} />,
        <SummaryCard key="notApplicable" label={t('soaView.notApplicable')} value={summary.notApplicable} icon={<XCircle className="w-4 h-4 text-content-muted" />} />,
        <SummaryCard key="unmapped" label={t('soaView.unmapped')} value={summary.unmapped} icon={<HelpCircle className="w-4 h-4 text-content-error" />} accent={summary.unmapped > 0 ? 'danger' : undefined} />,
        <SummaryCard key="implemented" label={t('soaView.implemented')} value={summary.implemented} icon={<CheckCircle2 className="w-4 h-4 text-content-success" />} />,
        <SummaryCard key="excepted" label={t('soaView.excepted')} value={summary.excepted} icon={<AlertTriangle className="w-4 h-4 text-content-warning" />} accent={summary.excepted > 0 ? 'warning' : undefined} />,
        <SummaryCard key="missingJustification" label={t('soaView.missingJustification')} value={summary.missingJustification} icon={<AlertTriangle className="w-4 h-4 text-content-warning" />} accent={summary.missingJustification > 0 ? 'warning' : undefined} />,
    ];

    return (
        // Roadmap-2 PR-12 — SoAClient is embedded inside the
        // Reports page now; the parent owns the H1 + breadcrumbs.
        // The duplicate H1 + subtitle + export-button cluster
        // that used to live here are gone (the export buttons
        // moved up to the Reports header so they sit in the
        // same place as the Risk Register's exports). The body
        // gets `space-y-section` so summary / banner / filters /
        // table breathe at the canonical 32px rhythm.
        <div className="space-y-section animate-fadeIn">
            {/* #4740 — this is the page's only parent (`/reports/soa`), so it
                carries the page's title and breadcrumbs: the Reports page it
                was once embedded in does not render it. */}
            <PageHeader
                breadcrumbs={[
                    { label: t('crumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                    { label: t('title'), href: `/t/${tenantSlug}/reports` },
                    { label: t('soa') },
                ]}
                title={t('soa')}
                titleId="soa-heading"
                description={`${tc(report.frameworkName)} — ${t('soaView.requirementsCount', { count: summary.total })}`}
            />

            {/* R2-P3 — the Statement of Applicability is an ISO-27001-Annex-A
                artifact. For a non-ISO framework, say so and point at that
                framework's coverage/readiness rather than passing this off as
                a native SoA. */}
            {/* The non-ISO notice that used to live here was UNREACHABLE:
                both soa/page.tsx and soa/print/page.tsx redirect when
                `!report.hasStatementOfApplicability`, so this component only ever renders for an
                ISO-family framework. It and its two i18n strings are gone rather
                than kept "just in case" — dead UI that looks live is how a
                reviewer concludes a case is handled when it is not. If non-ISO
                SoA is ever supported, the redirect is what has to change first,
                and this branch should be written against the behaviour that
                replaces it. */}

            {/* Summary cards. On a phone, seven tiles in a two-column grid
                filled the whole first screen before any requirement; there
                they are one scrolling strip that says it scrolls — the shared
                KPI strip, a grid again from md up. */}
            <KpiStrip
                data-testid="soa-kpi-strip"
                aria-label={t('soaMobile.summaryAria')}
                columns="md:grid-cols-3 lg:grid-cols-7"
                gridGap="md:gap-compact"
            >
                {summaryTiles}
            </KpiStrip>

            {/* Readiness banner */}
            {(summary.unmapped > 0 || summary.missingJustification > 0) && (
                <div className="rounded-lg border border-border-error bg-bg-error px-4 py-3 flex flex-wrap items-center justify-between gap-tight" id="soa-readiness-banner">
                    <div className="flex items-center gap-tight">
                        <AlertTriangle className="w-4 h-4 text-content-error flex-shrink-0" />
                        <div className="text-xs text-content-error">
                            <span className="font-semibold">{t('soaView.notReady')}</span>
                            {summary.unmapped > 0 && <span className="ml-1">{t('soaView.unmappedReqs', { count: summary.unmapped })}</span>}
                            {summary.unmapped > 0 && summary.missingJustification > 0 && <span>, </span>}
                            {summary.missingJustification > 0 && <span>{t('soaView.missingJust', { count: summary.missingJustification })}</span>}
                        </div>
                    </div>
                    <Button
                        variant="destructive"
                        size="xs"
                        onClick={() => setGapsOnly(true)}
                    >
                        {t('soaView.fixNow')}
                    </Button>
                </div>
            )}

            {/* Filters — R14-PR7 dropped the main-page search input.
                The "Show gaps only" toggle remains; cross-page
                navigation goes through ⌘K. */}
            <div className="flex flex-wrap items-center gap-tight">
                {/* `primary` for the active state, not `destructive`.
                    Destructive tone means "this button destroys something";
                    using it to say "this filter is on" inverts the convention
                    and teaches the palette wrong — the danger colour stops
                    meaning danger. Nothing here deletes: it narrows a list. */}
                <Button
                    variant={gapsOnly ? 'primary' : 'ghost'}
                    onClick={() => setGapsOnly(!gapsOnly)}
                    aria-pressed={gapsOnly}
                    id="soa-gaps-only"
                >
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {gapsOnly ? t('soaView.showingGaps') : t('soaView.showGaps')}
                </Button>

                {gapsOnly && (
                    <Button
                        variant="ghost"
                        onClick={() => setGapsOnly(false)}
                    >
                        <FilterX className="w-3.5 h-3.5" /> {t('soaView.clear')}
                    </Button>
                )}

                {/* Print / Save as PDF — opens the chrome-less print view.
                    Forwards the framework so the printed SoA matches the one
                    on screen (the print page applies the same ISO-only guard).
                    Offered on the print page's own two gates, `reports.export`
                    and the PDF exports plan feature (#4927): it used to show
                    to every role, and the page then sent anyone without them
                    to the Reports hub in a new tab, with no word why. */}
                <RequirePermission resource="reports" action="export">
                    <UpgradeGate feature="PDF_EXPORTS">
                        <a
                            href={`/t/${tenantSlug}/reports/soa/print?framework=${encodeURIComponent(report.framework)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={buttonVariants({ variant: 'ghost' })}
                            id="soa-print-link"
                        >
                            <Printer className="w-3.5 h-3.5" /> {t('soaView.print')}
                        </a>
                    </UpgradeGate>
                </RequirePermission>

                {/* #4740 — the CSV an auditor asks for, here as well as on the
                    Reports card, behind the same `reports.export` key the
                    export route asks. */}
                <RequirePermission resource="reports" action="export">
                    <a
                        href={`/api/t/${tenantSlug}/reports/soa/export.csv?framework=${encodeURIComponent(report.framework)}`}
                        className={buttonVariants({ variant: 'ghost' })}
                        id="soa-export-csv"
                        download
                    >
                        <Download className="w-3.5 h-3.5" /> {t('exportCsv')}
                    </a>
                </RequirePermission>

                <span className="text-xs text-content-subtle ml-auto">
                    {t('soaView.filteredCount', { filtered: filteredEntries.length, total: report.entries.length })}
                </span>
            </div>

            {/* Table.
                PR-A — match the Controls / Risks / Assets list-page
                card density. Pre-PR-A this used `density: 'none'`
                which read as a borderless overflow scroller; consumers
                navigating between Reports + Controls felt the
                presentation jump. Default density gives the same
                inset padding ratio the DataTable card uses on the
                other list pages. */}
            {belowMd ? (
                <ul className="space-y-tight" data-testid="soa-cards" aria-label={t('soa')}>
                    {filteredEntries.map(entry => (
                        <SoACard
                            key={entry.requirementId}
                            entry={entry}
                            expanded={expandedRow === entry.requirementId}
                            onToggle={() => setExpandedRow(expandedRow === entry.requirementId ? null : entry.requirementId)}
                            canEdit={canEdit}
                            onMap={() => setMapModal({ requirementId: entry.requirementId, requirementCode: entry.requirementCode })}
                            onJustify={(controlId, controlCode, current) => {
                                setJustModal({ controlId, controlCode, requirementCode: entry.requirementCode });
                                setJustText(current ?? '');
                            }}
                            tenantSlug={tenantSlug}
                        />
                    ))}
                    {filteredEntries.length === 0 && (
                        <li className={cn(cardVariants({ density: 'compact' }), 'text-center text-sm text-content-subtle')}>
                            {gapsOnly ? t('soaView.noGaps') : t('soaView.noMatching')}
                        </li>
                    )}
                </ul>
            ) : (
            <div
                className={cn(cardVariants(), 'overflow-auto')}
                data-testid="soa-table-card"
            >
                <table className="data-table" id="soa-table">
                    <thead>
                        <tr>
                            <th className="w-24">{t('soaView.colCode')}</th>
                            <th>{t('soaView.colRequirement')}</th>
                            <th>{t('soaView.colApplicability')}</th>
                            <th>{t('soaView.colStatus')}</th>
                            <th>{t('soaView.colControls')}</th>
                            <th>{t('soaView.colGaps')}</th>
                            {canEdit && <th className="w-20">{t('soaView.colActions')}</th>}
                        </tr>
                    </thead>
                    <tbody>
                        {filteredEntries.map(entry => (
                            <SoARow
                                key={entry.requirementId}
                                entry={entry}
                                expanded={expandedRow === entry.requirementId}
                                onToggle={() => setExpandedRow(expandedRow === entry.requirementId ? null : entry.requirementId)}
                                canEdit={canEdit}
                                onMap={() => setMapModal({ requirementId: entry.requirementId, requirementCode: entry.requirementCode })}
                                onJustify={(controlId, controlCode, current) => {
                                    setJustModal({ controlId, controlCode, requirementCode: entry.requirementCode });
                                    // An existing reason opens for editing, not blank.
                                    setJustText(current ?? '');
                                }}
                                tenantSlug={tenantSlug}
                            />
                        ))}
                        {filteredEntries.length === 0 && (
                            <tr>
                                <td colSpan={canEdit ? 7 : 6} className="text-center text-content-subtle py-8">
                                    {gapsOnly ? t('soaView.noGaps') : t('soaView.noMatching')}
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
            )}

            {/* Map Control Modal — shared <Modal> (Epic 54) */}
            <Modal
                showModal={!!mapModal}
                setShowModal={(v) => {
                    const next = typeof v === 'function' ? v(!!mapModal) : v;
                    if (!next && !saving) setMapModal(null);
                }}
                size="md"
                title={t('soaView.mapControl')}
                description={
                    mapModal
                        ? t('soaView.mapModalDesc', { code: mapModal.requirementCode })
                        : undefined
                }
                preventDefaultClose={saving}
            >
                <Modal.Header
                    title={
                        mapModal
                            ? t('soaView.mapModalTitle', { code: mapModal.requirementCode })
                            : t('soaView.mapControl')
                    }
                    description={t('soaView.mapModalHeaderDesc')}
                />
                <Modal.Body>
                    <Input
                        id="soa-map-search"
                        value={mapSearch}
                        onChange={(e) => setMapSearch(e.target.value)}
                        placeholder={t('soaView.mapSearchPlaceholder')}
                        className="mb-2"
                    />
                    <div className="max-h-60 space-y-1 overflow-y-auto">
                        {mapFilteredControls.map((c) => (
                            <button
                                key={c.id}
                                type="button"
                                className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors hover:bg-bg-muted"
                                onClick={() => handleMapControl(c.id)}
                                disabled={saving}
                            >
                                <div>
                                    <span className="font-mono text-brand-emphasis">
                                        {c.code || '—'}
                                    </span>
                                    <span className="ml-2 text-content-emphasis">
                                        {tc(c.name)}
                                    </span>
                                </div>
                                {/* The map picker used to inline its own rule
                                    — `IMPLEMENTED ? success : neutral` over a
                                    RAW enum value. Same `c.status` field the
                                    list below renders through <StatusBadge>,
                                    so one control appeared grey and
                                    `NEEDS_REVIEW` here, amber and
                                    `NEEDS REVIEW` there. On the picker the
                                    grey was the misleading direction: a
                                    control needing review looked as settled as
                                    one merely planned, in the moment a user is
                                    choosing which control to attest with. */}
                                <StatusBadge value={c.status} />
                            </button>
                        ))}
                        {mapFilteredControls.length === 0 && (
                            <InlineEmptyState title={t('soaView.noControlsMatch')} />
                        )}
                    </div>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setMapModal(null)}
                        disabled={saving}
                    >
                        {t('soaView.cancel')}
                    </Button>
                </Modal.Actions>
            </Modal>

            {/* Justification Modal — shared <Modal> (Epic 54) */}
            <Modal
                showModal={!!justModal}
                setShowModal={(v) => {
                    const next = typeof v === 'function' ? v(!!justModal) : v;
                    if (!next && !saving) setJustModal(null);
                }}
                size="sm"
                title={t('soaView.addJustification')}
                description={
                    justModal
                        ? t('soaView.justModalDesc', { controlCode: justModal.controlCode, requirementCode: justModal.requirementCode })
                        : undefined
                }
                preventDefaultClose={saving}
            >
                <Modal.Header
                    title={t('soaView.addJustification')}
                    description={
                        justModal
                            ? t.rich('soaView.justHeaderRich', {
                                  controlCode: justModal.controlCode,
                                  requirementCode: justModal.requirementCode,
                                  code: (chunks) => (
                                      <span className="font-mono text-brand-emphasis">{chunks}</span>
                                  ),
                              })
                            : null
                    }
                />
                <Modal.Body>
                    {/* The <Textarea> primitive rather than a raw element
                        wearing `className="input"`: the primitive owns the
                        focus ring, disabled treatment and dark-mode tokens, and
                        a hand-styled copy drifts from them silently. */}
                    <Textarea
                        className="min-h-[100px] w-full"
                        placeholder={t('soaView.justPlaceholder')}
                        value={justText}
                        onChange={(e) => setJustText(e.target.value)}
                        autoFocus
                        disabled={saving}
                    />
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setJustModal(null)}
                        disabled={saving}
                    >
                        {t('soaView.cancel')}
                    </Button>
                    <Button
                        variant="primary"
                        size="sm"
                        onClick={handleSaveJustification}
                        disabled={saving || !justText.trim()}
                    >
                        {saving ? t('soaView.saving') : t('soaView.saveJustification')}
                    </Button>
                </Modal.Actions>
            </Modal>
        </div>
    );
}

// ─── Row Component ───

function SoARow({
    entry, expanded, onToggle, canEdit, onMap, onJustify, tenantSlug,
}: {
    entry: SoAEntryDTO;
    expanded: boolean;
    onToggle: () => void;
    canEdit: boolean;
    onMap: () => void;
    onJustify: (controlId: string, controlCode: string, current?: string) => void;
    tenantSlug: string;
}) {
    const t = useTranslations('reports');
    const tc = useContentText();
    const sectionLabel = useSoASectionLabel();
    const hasGap = entryHasGap(entry);

    return (
        <>
            {/* A bare `onClick` on a <tr> is invisible to the keyboard and to
                assistive tech: no role, no tab stop, no Enter/Space handling and
                nothing announcing that the row expands or whether it is open.
                The rows carry the per-requirement control detail, so that was
                the SoA's substance behind a mouse-only affordance. */}
            <tr
                className={`${hasGap ? 'bg-bg-error' : ''} cursor-pointer hover:bg-bg-muted/50`}
                {...buttonLikeKeys(onToggle, { expanded })}
            >
                <td className="text-xs font-mono text-[var(--brand-default)]">{entry.requirementCode}</td>
                <td className="text-sm text-content-emphasis">
                    <div>{tc(entry.requirementTitle)}</div>
                    {entry.section && <div className="text-xs text-content-subtle">{sectionLabel(entry.section)}</div>}
                </td>
                <td><ApplicabilityBadge value={entry.applicable} /></td>
                <td>
                    {entry.verdict === 'excepted'
                        ? <ExceptedBadge until={entry.exceptedUntil} t={t} />
                        : <StatusBadge value={entry.implementationStatus} />}
                </td>
                <td className="text-xs text-content-muted">
                    {entry.mappedControls.length > 0 ? (
                        <span className="inline-flex items-center gap-1">
                            <Link2 className="w-3.5 h-3.5" /> {entry.mappedControls.length}
                        </span>
                    ) : '—'}
                </td>
                <td><GapBadges entry={entry} /></td>
                {canEdit && (
                    <td>
                        <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                            {entry.applicable === null && (
                                <Tooltip content={t('soaView.mapControl')}>
                                    {/* A row action, so secondary: a row's button is not
                                        the page's primary action (R7-PR1). */}
                                    <Button
                                        variant="secondary"
                                        size="xs"
                                        onClick={onMap}
                                        aria-label={t('soaView.mapControl')}
                                    >
                                        <Plus className="w-3.5 h-3.5" />
                                    </Button>
                                </Tooltip>
                            )}
                        </div>
                    </td>
                )}
            </tr>
            {expanded && entry.mappedControls.length > 0 && (
                <tr className="bg-bg-default/40">
                    <td colSpan={canEdit ? 7 : 6} className="p-0">
                        <MappedControlsDetail
                            entry={entry}
                            canEdit={canEdit}
                            onJustify={onJustify}
                            tenantSlug={tenantSlug}
                            className="px-6 py-3"
                        />
                    </td>
                </tr>
            )}
        </>
    );
}

// ─── Shared pieces of a row and a card ───

/** Unmapped, or not applicable with a control that gives no reason. */
function entryHasGap(entry: SoAEntryDTO): boolean {
    return entry.applicable === null || (
        entry.applicable === false &&
        entry.mappedControls.some(c => c.applicability === 'NOT_APPLICABLE' && !c.justification)
    );
}

/**
 * A requirement's mapped controls with their applicability, status and
 * reason — the table row's expansion, and a phone card's. `stacked` lays each
 * control out in lines instead of one row with the actions at its far end,
 * which ran past a phone's edge.
 */
function MappedControlsDetail({
    entry, canEdit, onJustify, tenantSlug, className, stacked = false,
}: {
    entry: SoAEntryDTO;
    canEdit: boolean;
    onJustify: (controlId: string, controlCode: string, current?: string) => void;
    tenantSlug: string;
    className?: string;
    stacked?: boolean;
}) {
    const t = useTranslations('reports');
    const tc = useContentText();
    return (
        <div className={cn('space-y-tight', className)} data-testid={`soa-mapped-controls-${entry.requirementId}`}>
            <div className="text-xs uppercase tracking-wider text-content-subtle font-semibold">{t('soaView.mappedControls')}</div>
            {entry.mappedControls.map(c => (
                <div
                    key={c.controlId}
                    className={cn(
                        'text-xs bg-bg-page/40 rounded-lg px-3 py-2',
                        stacked ? 'flex flex-col items-start gap-tight' : 'flex items-center justify-between',
                    )}
                >
                    <div className={cn('flex items-center gap-compact', stacked && 'flex-wrap min-w-0')}>
                        <a
                            href={`/t/${tenantSlug}/controls/${c.controlId}`}
                            className={`${textLinkVariants({ tone: 'link' })} font-mono`}
                            onClick={e => e.stopPropagation()}
                        >
                            {c.code || c.controlId.slice(0, 8)}
                        </a>
                        <span className={cn('text-content-emphasis', stacked && 'break-words')}>{tc(c.title)}</span>
                        <StatusBadgePrimitive variant={c.applicability === 'APPLICABLE' ? 'success' : 'neutral'}>
                            {c.applicability === 'APPLICABLE' ? t('soaView.applicable') : t('soaView.notApplicable')}
                        </StatusBadgePrimitive>
                        <StatusBadge value={c.status} />
                    </div>
                    <div className={cn('flex items-center gap-tight', stacked && 'flex-wrap min-w-0 max-w-full')}>
                        {c.justification && (stacked ? (
                            // A phone has no hover to read a truncated reason, so it wraps.
                            <span className="text-content-muted break-words">{c.justification}</span>
                        ) : (
                            <Tooltip content={c.justification}>
                                <span className="text-content-muted max-w-trunc-default truncate">
                                    {c.justification}
                                </span>
                            </Tooltip>
                        ))}
                        {c.applicability === 'NOT_APPLICABLE' && !c.justification && canEdit && (
                            <Button
                                variant="destructive"
                                size="xs"
                                onClick={(e) => { e.stopPropagation(); onJustify(c.controlId, c.code || c.controlId.slice(0, 8)); }}
                            >
                                <MessageSquare className="w-3.5 h-3.5" /> {t('soaView.justify')}
                            </Button>
                        )}
                        {/* #4740 — a reason already given can be corrected
                            here, not only on the control's page. */}
                        {c.applicability === 'NOT_APPLICABLE' && c.justification && canEdit && (
                            <Button
                                variant="ghost"
                                size="xs"
                                onClick={(e) => { e.stopPropagation(); onJustify(c.controlId, c.code || c.controlId.slice(0, 8), c.justification ?? ''); }}
                                id={`soa-edit-justification-${c.controlId}`}
                            >
                                <MessageSquare className="w-3.5 h-3.5" /> {t('soaView.editJustification')}
                            </Button>
                        )}
                    </div>
                </div>
            ))}
            {entry.evidenceCount > 0 && (
                <div className="text-xs text-content-subtle">{t('soaView.evidenceItems', { count: entry.evidenceCount })}</div>
            )}
            {entry.openTaskCount > 0 && (
                <div className="text-xs text-content-warning">{t('soaView.openTasks', { count: entry.openTaskCount })}</div>
            )}
            {entry.lastTestResult && (
                <div className="text-xs text-content-subtle">
                    {t('soaView.lastTest')} <span className={entry.lastTestResult === 'PASS' ? 'text-content-success' : 'text-content-error'}>{entry.lastTestResult}</span>
                </div>
            )}
        </div>
    );
}

// ─── Card Component (a phone) ───

/**
 * One requirement on a phone: code, title and group, then applicability,
 * status, the requirement's reason and its gaps, each on its own line, and its
 * mapped controls behind a button rather than a tap on the whole row.
 */
function SoACard({
    entry, expanded, onToggle, canEdit, onMap, onJustify, tenantSlug,
}: {
    entry: SoAEntryDTO;
    expanded: boolean;
    onToggle: () => void;
    canEdit: boolean;
    onMap: () => void;
    onJustify: (controlId: string, controlCode: string, current?: string) => void;
    tenantSlug: string;
}) {
    const t = useTranslations('reports');
    const tc = useContentText();
    const sectionLabel = useSoASectionLabel();
    const hasGap = entryHasGap(entry);
    const detailId = `soa-card-detail-${entry.requirementId}`;

    return (
        <li
            className={cn(cardVariants({ density: 'compact' }), 'min-w-0', hasGap && 'border-border-error')}
            data-testid={`soa-card-${entry.requirementId}`}
        >
            <div className="flex items-start justify-between gap-tight">
                <div className="min-w-0">
                    <div className="text-xs font-mono text-[var(--brand-default)]">{entry.requirementCode}</div>
                    <div className="text-sm font-medium text-content-emphasis break-words">{tc(entry.requirementTitle)}</div>
                    {entry.section && (
                        <div className="text-xs text-content-subtle" data-testid="soa-card-section">{sectionLabel(entry.section)}</div>
                    )}
                </div>
                {canEdit && entry.applicable === null && (
                    <Button
                        variant="secondary"
                        size="xs"
                        onClick={onMap}
                        aria-label={t('soaView.mapControl')}
                        className="shrink-0"
                    >
                        <Plus className="w-3.5 h-3.5" />
                    </Button>
                )}
            </div>

            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-compact gap-y-tight text-xs">
                <dt className="text-content-muted">{t('soaView.colApplicability')}</dt>
                <dd><ApplicabilityBadge value={entry.applicable} /></dd>
                <dt className="text-content-muted">{t('soaView.colStatus')}</dt>
                <dd>
                    {entry.verdict === 'excepted'
                        ? <ExceptedBadge until={entry.exceptedUntil} t={t} />
                        : <StatusBadge value={entry.implementationStatus} />}
                </dd>
                {entry.justification && (
                    <>
                        <dt className="text-content-muted">{t('soaMobile.justification')}</dt>
                        <dd className="break-words text-content-default">{entry.justification}</dd>
                    </>
                )}
            </dl>

            {hasGap && <div className="mt-2"><GapBadges entry={entry} /></div>}

            {entry.mappedControls.length > 0 && (
                <div className="mt-2">
                    <Button
                        variant="ghost"
                        size="xs"
                        onClick={onToggle}
                        aria-expanded={expanded}
                        aria-controls={detailId}
                        data-testid={`soa-card-toggle-${entry.requirementId}`}
                        icon={<Link2 className="w-3.5 h-3.5" />}
                    >
                        {t('soaMobile.mappedControls', { count: entry.mappedControls.length })}
                    </Button>
                    {expanded && (
                        <div id={detailId} className="mt-2">
                            <MappedControlsDetail
                                entry={entry}
                                canEdit={canEdit}
                                onJustify={onJustify}
                                tenantSlug={tenantSlug}
                                stacked
                            />
                        </div>
                    )}
                </div>
            )}
        </li>
    );
}

// ─── Summary Card ───

function SummaryCard({ label, value, icon, accent }: { label: string; value: number; icon: React.ReactNode; accent?: 'danger' | 'warning' }) {
    const border = accent === 'danger' ? 'border-border-error' : accent === 'warning' ? 'border-border-warning' : 'border-border-default/50';
    return (
        // In the phone strip (`KpiStrip`) the tile is compact and keeps its
        // width, so the strip scrolls rather than squeezing seven tiles.
        <div className={cn(cardVariants({ density: 'none' }), 'border px-4 py-3', border)}>
            <div className="flex items-center justify-between">
                {icon}
                <span className="font-bold text-content-emphasis text-xl max-md:text-lg">{value}</span>
            </div>
            <div className="text-xs text-content-muted mt-1">{label}</div>
        </div>
    );
}
