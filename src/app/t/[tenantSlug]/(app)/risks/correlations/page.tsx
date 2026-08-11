'use client';

/* RQ-8 — Risk correlation matrix editor + PSD validation + auto-suggest. */
import { useState } from 'react';
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
    const { permissions } = useTenantContext();
    const canWrite = permissions.canWrite;
    const matrixQuery = useTenantSWR<{ matrix: Matrix }>('/risks/correlations');
    const m = matrixQuery.data?.matrix ?? null;
    const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
    const [suggestError, setSuggestError] = useState(false);
    const [sel, setSel] = useState<{ i: number; j: number } | null>(null);
    const [coef, setCoef] = useState('');

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
            });
            if (!res.ok) throw new Error(t('correlations.saveError'));
            return res.json().catch(() => ({}));
        },
    });

    const save = async () => {
        if (!m || !sel) return;
        try {
            await saveMutation.trigger({
                riskAId: m.riskIds[sel.i],
                riskBId: m.riskIds[sel.j],
                coefficient: Number(coef),
            });
            // Only clear the editor once the write actually landed.
            setSel(null);
            setCoef('');
        } catch {
            // Surfaced via saveMutation.error below; keep the draft on screen.
        }
    };

    const autoSuggest = async () => {
        setSuggestError(false);
        try {
            const r = await fetch(apiUrl('/risks/correlations/suggest'));
            if (r.ok) setSuggestions((await r.json()).suggestions);
            else setSuggestError(true);
        } catch {
            setSuggestError(true);
        }
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
        } catch {
            // Surfaced via saveMutation.error below.
        }
    };

    return (
        <div className="space-y-section">
            <BackAffordance />
            <PageBreadcrumbs items={[{ label: t('breadcrumbRoot'), href: tenantHref('/risks') }, { label: t('correlations.breadcrumb') }]} />
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-tight">
                    <Heading level={1}>{t('correlations.title')}</Heading>
                    <InfoTooltip title={t('correlations.conceptTitle')} content={t('correlations.conceptHelp')} side="right" />
                </div>
                <div className="flex items-center gap-tight">
                    {suggestError && <span className="text-xs text-content-error" role="alert">{t('correlations.suggestError')}</span>}
                    {saveMutation.error && (
                        <span className="text-xs text-content-error" role="alert" data-testid="correlation-save-error">
                            {t('correlations.saveError')}
                        </span>
                    )}
                    <Button variant="secondary" size="sm" onClick={autoSuggest}>{t('correlations.autoSuggest')}</Button>
                </div>
            </div>

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
                        {canWrite && <span className="text-xs text-content-subtle">{t('correlations.clickHint')}</span>}
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
                    <div className="overflow-auto">
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
                                                className={`border border-border-subtle p-1 text-center tabular-nums ${cellClass(v)} ${canWrite && j > i ? 'cursor-pointer' : ''}`}
                                                onClick={canWrite && j > i ? () => { setSel({ i, j }); setCoef(String(v)); } : undefined}
                                            >
                                                {v.toFixed(1)}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {sel && (
                        <div className="flex flex-wrap items-end gap-default rounded-md border border-border-emphasis p-default">
                            <span className="text-sm text-content-emphasis">{m.riskTitles[sel.i]} ↔ {m.riskTitles[sel.j]}</span>
                            <label className="block w-24 sm:w-32"><span className="text-xs text-content-muted">{t('correlations.coefficient')}</span>
                                <Input type="text" inputMode="decimal" value={coef} onChange={(e) => setCoef(e.target.value)} />
                            </label>
                            <Button variant="primary" size="sm" onClick={save}>{t('edit.save')}</Button>
                            <Button variant="ghost" size="sm" onClick={() => setSel(null)}>{t('edit.cancel')}</Button>
                        </div>
                    )}
                    </>
                    )}
                </AnalyticsState>
            </Card>

            {suggestions.length > 0 && (
                <Card className="space-y-default p-6">
                    <Heading level={2}>{t('correlations.suggested')}</Heading>
                    <ul className="divide-y divide-border-subtle">
                        {suggestions.map((s) => (
                            <li key={`${s.riskAId}-${s.riskBId}`} className="flex items-center gap-default py-default text-sm">
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
