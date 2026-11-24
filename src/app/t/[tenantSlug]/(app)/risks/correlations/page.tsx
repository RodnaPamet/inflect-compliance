'use client';

/* RQ-8 — Risk correlation matrix editor + PSD validation + auto-suggest. */
import { useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { Tooltip, InfoTooltip } from '@/components/ui/tooltip';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { useTenantApiUrl, useTenantHref, useTenantContext } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTranslations } from 'next-intl';
import { AnalyticsState } from '../_shared/AnalyticsState';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import { apiErrorMessage } from '@/lib/api-error';
import { SettingRow } from '@/components/layout/SettingRow';
import { InlineNotice } from '@/components/ui/inline-notice';
import { useIsBelowMd } from '@/components/ui/hooks';
import { correlationPairs, type CorrelationPair as Pair } from './correlation-pairs';

interface Matrix { riskIds: string[]; riskTitles: string[]; matrix: number[][]; isPositiveSemiDefinite: boolean; isPositiveDefinite: boolean; minEigenvalue: number }
interface Suggestion { riskAId: string; riskBId: string; suggestedCoefficient: number; reason: string }

// Discrete heat bands → semantic background tokens (no raw colours).
function cellClass(v: number): string {
    if (v >= 0.999) return 'bg-bg-muted/40';
    if (v >= 0.6) return 'bg-bg-error/30';
    if (v >= 0.3) return 'bg-bg-warning/30';
    if (v > 0) return 'bg-bg-warning/10';
    if (v < 0) return 'bg-bg-info/20';
    return '';
}

export default function CorrelationMatrixPage() {
    const t = useTranslations('risks');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    /**
     * `setCorrelation` asserts canWrite; `suggestCorrelations` only asserts
     * canRead. So Auto-suggest stays available to every member — it is a
     * read that produces advice — while the cells stop being clickable and
     * Apply disappears for anyone who cannot persist the result.
     */
    const { permissions, appPermissions } = useTenantContext();
    // #4771 — `PUT /risks/correlations` takes `risks.edit` on top of the write
    // tier; gating on the tier alone offered a custom role edits it refused.
    const canWrite = permissions.canWrite && (appPermissions?.risks?.edit ?? false);
    const matrixQuery = useTenantSWR<{ matrix: Matrix }>('/risks/correlations');
    const m = matrixQuery.data?.matrix ?? null;
    const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
    const [suggestError, setSuggestError] = useState(false);
    // #4771 — whether Auto-suggest has run, and is running: an empty result
    // used to look exactly like not having asked.
    const [suggested, setSuggested] = useState(false);
    const [suggesting, setSuggesting] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [sel, setSel] = useState<{ i: number; j: number } | null>(null);
    const [coef, setCoef] = useState('');
    // Below `md` the grid gives way to a list of pairs (owner decision,
    // 2026-11-23: a notice plus a readable list). The switch itself is CSS;
    // this only decides where the editor opens, so it opens beside the pair
    // that was tapped rather than below a list it may be screens away from.
    // `false` on the server and the first render; nothing is selected then.
    const belowMd = useIsBelowMd();

    /**
     * B2-1 — both correlation writes go through `useTenantMutation` on the
     * matrix key.
     *
     * This is a BUG FIX, not just a refactor. Both handlers previously did
     * a bare `await fetch(...)` and never looked at `res.ok`, then closed
     * the editor and revalidated. A rejected save (a coefficient the server
     * refuses, a 403, a 500) therefore looked EXACTLY like a successful one:
     * the editor closed and the matrix redrew with the OLD value. The user
     * was told nothing and had no reason to believe the edit had not stuck.
     *
     * `mutationFn` throws on a non-ok response, so the failure now surfaces
     * on `saveMutation.error` and the editor stays open with the value in
     * it — the operator can retry or correct rather than losing the edit.
     */
    const saveMutation = useTenantMutation<unknown, Record<string, unknown>, unknown>({
        key: '/risks/correlations',
        mutationFn: async (body) => {
            const res = await fetch(apiUrl('/risks/correlations'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }).catch(() => null);
            if (!res || !res.ok) {
                // #4771 — the server's reason for a refusal, not a fixed line.
                const errBody: unknown = res ? await res.json().catch(() => null) : null;
                throw new Error(!res || res.status >= 500 ? t('correlations.saveError') : apiErrorMessage(errBody, t('correlations.saveError')));
            }
            return res.json().catch(() => ({}));
        },
    });

    const save = async () => {
        if (!m || !sel) return;
        // #4771 — a coefficient that is not a number from −1 to 1 was sent
        // anyway and came back as a bare failure.
        const value = Number(coef.trim().replace(',', '.'));
        if (!coef.trim() || !Number.isFinite(value) || value < -1 || value > 1) {
            setSaveError(t('correlations.coefficientRange'));
            return;
        }
        setSaveError(null);
        try {
            await saveMutation.trigger({
                riskAId: m.riskIds[sel.i],
                riskBId: m.riskIds[sel.j],
                coefficient: value,
            });
            // Only clear the editor once the write actually landed.
            setSel(null);
            setCoef('');
        } catch (e) {
            // Keep the draft on screen, with the reason.
            setSaveError(e instanceof Error ? e.message : t('correlations.saveError'));
        }
    };

    const autoSuggest = async () => {
        setSuggestError(false);
        setSuggesting(true);
        try {
            const r = await fetch(apiUrl('/risks/correlations/suggest'));
            if (r.ok) {
                setSuggestions((await r.json()).suggestions ?? []);
                setSuggested(true);
            } else setSuggestError(true);
        } catch {
            setSuggestError(true);
        } finally {
            setSuggesting(false);
        }
    };
    /** A risk's title by id, from the matrix the page already holds. */
    const titleOf = (id: string) => {
        const idx = m?.riskIds.indexOf(id) ?? -1;
        return idx >= 0 && m ? m.riskTitles[idx] : id;
    };
    const applySuggestion = async (s: Suggestion) => {
        try {
            await saveMutation.trigger({
                riskAId: s.riskAId,
                riskBId: s.riskBId,
                coefficient: s.suggestedCoefficient,
                rationale: s.reason,
            });
            // Drop the suggestion only after it persisted — otherwise a
            // failed apply silently removes it from the list and the
            // operator cannot retry it.
            setSuggestions((prev) =>
                prev.filter((x) => !(x.riskAId === s.riskAId && x.riskBId === s.riskBId)),
            );
        } catch (e) {
            setSaveError(e instanceof Error ? e.message : t('correlations.saveError'));
        }
    };

    const editor = m && sel && (
        <div className="flex flex-wrap items-end gap-default rounded-md border border-border-emphasis p-default">
            <span className="text-sm text-content-emphasis">{m.riskTitles[sel.i]} ↔ {m.riskTitles[sel.j]}</span>
            <label className="block w-24 sm:w-32"><span className="text-xs text-content-muted">{t('correlations.coefficient')}</span>
                <Input type="text" inputMode="decimal" value={coef} onChange={(e) => setCoef(e.target.value)} id="corr-coefficient" autoFocus />
            </label>
            <Button variant="primary" size="sm" onClick={save} id="corr-save">{t('edit.save')}</Button>
            <Button variant="ghost" size="sm" onClick={() => { setSel(null); setSaveError(null); }}>{t('edit.cancel')}</Button>
            {saveError && (
                <p className="w-full text-xs text-content-error" role="alert" data-testid="corr-edit-error">{saveError}</p>
            )}
        </div>
    );

    const pairs = m ? correlationPairs(m.matrix) : { correlated: [], uncorrelated: [] };
    /** One pair on a phone: both risks as links, the figure, and Edit for a writer. */
    const renderPair = (p: Pair) => {
        if (!m) return null;
        const a = m.riskTitles[p.i];
        const b = m.riskTitles[p.j];
        const value = p.v.toFixed(2);
        const riskLink = (idx: number) => (
            <Link
                href={tenantHref(`/risks/${m.riskIds[idx]}`)}
                className="flex min-h-11 items-center break-words text-sm font-medium text-content-emphasis hover:underline"
            >
                {m.riskTitles[idx]}
            </Link>
        );
        return (
            <li key={`${p.i}-${p.j}`} className="space-y-tight py-tight" data-testid={`corr-pair-${p.i}-${p.j}`}>
                {/* The two risks a line each, then the figure and Edit:
                    side by side, the names had a third of a phone's width. */}
                <div className="min-w-0">
                    {riskLink(p.i)}
                    <div className="flex items-center gap-tight">
                        <span aria-hidden className="text-content-subtle">↔</span>
                        <div className="min-w-0 flex-1">{riskLink(p.j)}</div>
                    </div>
                </div>
                <div className="flex items-center justify-between gap-default">
                    <span className={`rounded-md border border-border-subtle px-2 py-1 text-sm tabular-nums ${cellClass(p.v)}`}>
                        {value}
                    </span>
                    {canWrite && (
                        <Button
                            variant="secondary"
                            size="sm"
                            className="shrink-0 min-h-11"
                            aria-label={t('correlations.phone.editAria', { a, b, value })}
                            onClick={() => { setSel({ i: p.i, j: p.j }); setCoef(String(p.v)); setSaveError(null); }}
                        >
                            {t('correlations.phone.edit')}
                        </Button>
                    )}
                </div>
                {belowMd && sel?.i === p.i && sel?.j === p.j && editor}
            </li>
        );
    };

    return (
        <div className="space-y-section">
            <BackAffordance />
            <PageBreadcrumbs items={[{ label: t('breadcrumbRoot'), href: tenantHref('/risks') }, { label: t('correlations.breadcrumb') }]} />
            {/* Below `sm` the suggest button and its errors go under the title
                instead of squeezing it (#5874). */}
            <SettingRow
                align="center"
                title={<Heading level={1}>{t('correlations.title')}</Heading>}
                titleAdornment={
                    <InfoTooltip title={t('correlations.conceptTitle')} content={t('correlations.conceptHelp')} side="right" />
                }
                control={<>
                    {suggestError && <span className="text-xs text-content-error" role="alert">{t('correlations.suggestError')}</span>}
                    {saveError && !sel && (
                        <span className="text-xs text-content-error" role="alert" data-testid="correlation-save-error">
                            {saveError}
                        </span>
                    )}
                    <Button variant="secondary" size="sm" onClick={autoSuggest} disabled={suggesting} id="correlations-suggest-btn">
                        {suggesting ? t('correlations.suggesting') : t('correlations.autoSuggest')}
                    </Button>
                </>}
            />

            <Card className="space-y-default p-6">
                <AnalyticsState
                    isLoading={matrixQuery.isLoading}
                    error={matrixQuery.error}
                    isEmpty={!!m && m.riskIds.length === 0}
                    emptyText={t('correlations.emptyMatrix')}
                    errorText={t('correlations.loadError')}
                >
                    {m && (
                    <>
                    {/* Three-way gate. Green ONLY when strictly positive-
                        definite (Cholesky-safe). A merely-PSD matrix (min
                        eigenvalue ≈ 0) earns a warning, not a green tick,
                        because the sim will drop it (see below). */}
                    <div className="flex items-center gap-default">
                        <StatusBadge
                            variant={
                                m.isPositiveDefinite
                                    ? 'success'
                                    : m.isPositiveSemiDefinite
                                        ? 'warning'
                                        : 'error'
                            }
                        >
                            {m.isPositiveDefinite
                                ? t('correlations.isPsd')
                                : m.isPositiveSemiDefinite
                                    ? t('correlations.borderlinePd')
                                    : t('correlations.notPsd')}
                        </StatusBadge>
                        <InfoTooltip title={t('correlations.psdTitle')} content={t('correlations.psdHelp')} />
                        {/* The hint tells you to click a cell. Don't say that
                            to someone whose cells are inert. */}
                        {canWrite && <span className="text-xs text-content-subtle max-md:hidden">{t('correlations.clickHint')}</span>}
                    </div>
                    {/* PR-L — a non-PSD matrix is silently dropped from the
                        Monte Carlo (Cholesky fails → independent sampling).
                        Spell out that consequence so the operator knows their
                        configured correlations won't apply until they fix it. */}
                    {!m.isPositiveSemiDefinite && (
                        <div
                            className="rounded-md border border-border-error bg-bg-error/15 p-3 text-sm text-content-error"
                            role="alert"
                            data-testid="correlations-non-psd-warning"
                        >
                            {t('correlations.nonPsdWarning')}
                        </div>
                    )}
                    {/* PSD-but-not-PD: the matrix passes the semi-definite
                        tolerance yet Cholesky needs STRICT positive-
                        definiteness, so the sim drops it just the same.
                        Warn BEFORE the operator relies on the correlations. */}
                    {m.isPositiveSemiDefinite && !m.isPositiveDefinite && (
                        <div
                            className="rounded-md border border-border-warning bg-bg-warning/15 p-3 text-sm text-content-warning"
                            role="alert"
                            data-testid="correlations-non-pd-warning"
                        >
                            {t('correlations.notPdWarning')}
                        </div>
                    )}
                    {/* Below `md`: a notice and the pairs as a list, strongest
                        first; the grid stays for larger screens. */}
                    <div className="space-y-default md:hidden" data-testid="corr-phone-list">
                        <InlineNotice variant="info" id="corr-larger-screen">{t('correlations.phone.notice')}</InlineNotice>
                        {pairs.correlated.length === 0 ? (
                            <p className="text-sm text-content-muted" data-testid="corr-phone-none">{t('correlations.phone.none')}</p>
                        ) : (
                            <ul className="divide-y divide-border-subtle" aria-label={t('correlations.phone.listAria')}>
                                {pairs.correlated.map(renderPair)}
                            </ul>
                        )}
                        {pairs.uncorrelated.length > 0 && (
                            <details className="group" data-testid="corr-phone-uncorrelated">
                                <summary className="flex min-h-11 cursor-pointer items-center text-sm text-content-muted">
                                    {t('correlations.phone.uncorrelated', { count: pairs.uncorrelated.length })}
                                </summary>
                                <ul className="divide-y divide-border-subtle">
                                    {pairs.uncorrelated.map(renderPair)}
                                </ul>
                            </details>
                        )}
                    </div>
                    <div className="overflow-auto max-md:hidden">
                        <table className="border-collapse text-xs">
                            <thead>
                                <tr>
                                    <th className="p-1" />
                                    {m.riskTitles.map((title, j) => (
                                        <th key={j} className="p-1 text-content-subtle">
                                            <Tooltip content={title}><span className="block max-w-24 truncate">{title}</span></Tooltip>
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {m.matrix.map((row, i) => (
                                    <tr key={i}>
                                        <td className="p-1 text-content-subtle">
                                            <Tooltip content={m.riskTitles[i]}><span className="block max-w-24 truncate">{m.riskTitles[i]}</span></Tooltip>
                                        </td>
                                        {row.map((v, j) => (
                                            <td
                                                key={j}
                                                className={`border border-border-subtle p-0 text-center tabular-nums ${cellClass(v)}`}
                                            >
                                                {/* #4771 — an editable pair is a real button, so it
                                                    can be reached and used from the keyboard; it was a
                                                    click handler on the cell. Two decimals, so the grid
                                                    agrees with the value the editor opens with. */}
                                                {canWrite && j > i ? (
                                                    <button
                                                        type="button"
                                                        className="block w-full cursor-pointer p-1 hover:bg-bg-muted/50 focus-visible:outline focus-visible:outline-2"
                                                        aria-label={t('correlations.editPairAria', { a: m.riskTitles[i], b: m.riskTitles[j], value: v.toFixed(2) })}
                                                        onClick={() => { setSel({ i, j }); setCoef(String(v)); setSaveError(null); }}
                                                        data-testid={`corr-cell-${i}-${j}`}
                                                    >
                                                        {v.toFixed(2)}
                                                    </button>
                                                ) : (
                                                    <span className="block p-1">{v.toFixed(2)}</span>
                                                )}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {!belowMd && editor}
                    </>
                    )}
                </AnalyticsState>
            </Card>

            {suggested && suggestions.length === 0 && (
                <Card className="p-6" data-testid="corr-no-suggestions">
                    <p className="text-sm font-medium text-content-emphasis">{t('correlations.noSuggestions')}</p>
                    <p className="text-sm text-content-muted">{t('correlations.noSuggestionsHint')}</p>
                </Card>
            )}
            {suggestions.length > 0 && (
                <Card className="space-y-default p-6">
                    <Heading level={2}>{t('correlations.suggested')}</Heading>
                    <ul className="divide-y divide-border-subtle">
                        {suggestions.map((s) => (
                            <li key={`${s.riskAId}-${s.riskBId}`} className="flex flex-wrap items-center gap-default py-default text-sm" data-testid={`corr-suggestion-${s.riskAId}-${s.riskBId}`}>
                                {/* #4771 — which two risks; the reason alone did not say. */}
                                <span className="font-medium text-content-emphasis">{titleOf(s.riskAId)} ↔ {titleOf(s.riskBId)}</span>
                                <span className="text-content-muted">{s.reason}</span>
                                <span className="tabular-nums text-content-emphasis">{s.suggestedCoefficient.toFixed(2)}</span>
                                {canWrite && (
                                    <Button size="sm" variant="secondary" className="ml-auto" onClick={() => applySuggestion(s)}>{t('correlations.apply')}</Button>
                                )}
                            </li>
                        ))}
                    </ul>
                </Card>
            )}
        </div>
    );
}
