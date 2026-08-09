'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * Risk-matrix admin editor — Epic 44.5
 *
 * Lets a tenant admin edit:
 *   - dimensions (likelihood × impact, each 2..10)
 *   - axis titles (free text, max 64)
 *   - per-level labels (one input per row/column)
 *   - severity bands (name + min..max + colour)
 *
 * Live preview on the right uses the new `<RiskMatrix>` engine with
 * a synthetic 1-risk-per-cell payload so colour bands + axis labels
 * are immediately visible. Save POSTs the FULL effective config
 * (not a patch) so the merge result the user sees in preview is
 * exactly what lands in the DB.
 *
 * Validation runs in two passes:
 *   - client-side `validateBandsCoverage` + `validateLevelLabelsLength`
 *     (fast inline feedback)
 *   - server-side same Zod + cross-field via `updateRiskMatrixConfig`
 *     (defence-in-depth — same rules either way)
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useToast } from '@/components/ui/hooks/use-toast';

import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons/nucleo';
import { NumberStepper } from '@/components/ui/number-stepper';
import { RiskMatrix } from '@/components/risks/RiskMatrix';
import { DEFAULT_RISK_MATRIX_CONFIG } from '@/lib/risk-matrix/defaults';
import {
    validateBandsCoverage,
    validateLevelLabelsLength,
} from '@/lib/risk-matrix/schema';
import type {
    RiskMatrixBand,
    RiskMatrixConfigShape,
} from '@/lib/risk-matrix/types';
import { Heading } from '@/components/ui/typography';
import { Card } from '@/components/ui/card';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';

interface RiskMatrixAdminClientProps {
    tenantSlug: string;
    initialConfig: RiskMatrixConfigShape;
}

// ─── Helpers ────────────────────────────────────────────────────────

function cloneConfig(c: RiskMatrixConfigShape): RiskMatrixConfigShape {
    return {
        likelihoodLevels: c.likelihoodLevels,
        impactLevels: c.impactLevels,
        axisLikelihoodLabel: c.axisLikelihoodLabel,
        axisImpactLabel: c.axisImpactLabel,
        levelLabels: {
            likelihood: [...c.levelLabels.likelihood],
            impact: [...c.levelLabels.impact],
        },
        bands: c.bands.map((b) => ({ ...b })),
    };
}

/**
 * Resize a label array to the new dimension. Preserves existing
 * labels at low indices, fills new tail entries with the numeric
 * fallback ("6", "7", …) and drops trailing entries when shrinking.
 */
function resizeLabels(prev: string[], next: number): string[] {
    if (prev.length === next) return prev;
    if (prev.length > next) return prev.slice(0, next);
    const out = [...prev];
    for (let i = prev.length; i < next; i += 1) {
        out.push(String(i + 1));
    }
    return out;
}

// ─── Component ──────────────────────────────────────────────────────

export function RiskMatrixAdminClient({
    tenantSlug,
    initialConfig,
}: RiskMatrixAdminClientProps) {
    const [config, setConfig] = useState<RiskMatrixConfigShape>(() =>
        cloneConfig(initialConfig),
    );
    const [saving, setSaving] = useState(false);
    const [serverError, setServerError] = useState<string | null>(null);
    const t = useTranslations('admin');
    const toast = useToast();

    // Synthetic preview cells — every (L, I) carries one risk so the
    // band colours light up across the whole matrix without needing
    // real data.
    const previewCells = useMemo(() => {
        const cells: { likelihood: number; impact: number; count: number }[] = [];
        for (let l = 1; l <= config.likelihoodLevels; l += 1) {
            for (let i = 1; i <= config.impactLevels; i += 1) {
                cells.push({ likelihood: l, impact: i, count: 1 });
            }
        }
        return cells;
    }, [config.likelihoodLevels, config.impactLevels]);

    // ── Live validation ────────────────────────────────────────────
    const validationIssues = useMemo(() => {
        const issues: string[] = [];
        issues.push(
            ...validateLevelLabelsLength({
                levelLabels: config.levelLabels,
                likelihoodLevels: config.likelihoodLevels,
                impactLevels: config.impactLevels,
            }),
        );
        issues.push(
            ...validateBandsCoverage(
                config.bands,
                config.likelihoodLevels * config.impactLevels,
            ),
        );
        return issues;
    }, [config]);

    // ── Handlers ───────────────────────────────────────────────────
    const setLikelihoodLevels = (n: number) => {
        setConfig((p) => ({
            ...p,
            likelihoodLevels: n,
            levelLabels: {
                ...p.levelLabels,
                likelihood: resizeLabels(p.levelLabels.likelihood, n),
            },
        }));
    };
    const setImpactLevels = (n: number) => {
        setConfig((p) => ({
            ...p,
            impactLevels: n,
            levelLabels: {
                ...p.levelLabels,
                impact: resizeLabels(p.levelLabels.impact, n),
            },
        }));
    };

    const setLikelihoodLabel = (idx: number, value: string) =>
        setConfig((p) => ({
            ...p,
            levelLabels: {
                ...p.levelLabels,
                likelihood: p.levelLabels.likelihood.map((v, i) =>
                    i === idx ? value : v,
                ),
            },
        }));
    const setImpactLabel = (idx: number, value: string) =>
        setConfig((p) => ({
            ...p,
            levelLabels: {
                ...p.levelLabels,
                impact: p.levelLabels.impact.map((v, i) =>
                    i === idx ? value : v,
                ),
            },
        }));

    const updateBand = (idx: number, patch: Partial<RiskMatrixBand>) =>
        setConfig((p) => ({
            ...p,
            bands: p.bands.map((b, i) => (i === idx ? { ...b, ...patch } : b)),
        }));
    const addBand = () => {
        setConfig((p) => {
            const last = p.bands[p.bands.length - 1];
            const max = p.likelihoodLevels * p.impactLevels;
            const start = (last?.maxScore ?? 0) + 1;
            if (start > max) {
                toast.error(t('riskMatrix.toastNoRange'));
                return p;
            }
            return {
                ...p,
                bands: [
                    ...p.bands,
                    {
                        name: t('riskMatrix.bandNameDefault', { n: p.bands.length + 1 }),
                        minScore: start,
                        maxScore: max,
                        color: '#6b7280',
                    },
                ],
            };
        });
    };
    const removeBand = (idx: number) =>
        setConfig((p) => ({
            ...p,
            bands: p.bands.filter((_, i) => i !== idx),
        }));

    const restoreDefaults = () => {
        setConfig(cloneConfig(DEFAULT_RISK_MATRIX_CONFIG));
        setServerError(null);
    };

    const save = useCallback(async () => {
        if (validationIssues.length > 0) {
            toast.error(t('riskMatrix.toastFixValidation'));
            return;
        }
        setSaving(true);
        setServerError(null);
        try {
            const res = await fetch(
                `/api/t/${tenantSlug}/admin/risk-matrix-config`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        likelihoodLevels: config.likelihoodLevels,
                        impactLevels: config.impactLevels,
                        axisLikelihoodLabel: config.axisLikelihoodLabel,
                        axisImpactLabel: config.axisImpactLabel,
                        levelLabels: config.levelLabels,
                        bands: config.bands,
                    }),
                },
            );
            if (!res.ok) {
                const body = (await res
                    .json()
                    .catch(() => ({}))) as { error?: string };
                throw new Error(body.error || t('riskMatrix.saveFailedStatus', { status: res.status }));
            }
            const next = (await res.json()) as RiskMatrixConfigShape;
            setConfig(cloneConfig(next));
            toast.success(t('riskMatrix.toastSaved'));
        } catch (err) {
            const msg = err instanceof Error ? err.message : t('riskMatrix.saveFailedGeneric');
            setServerError(msg);
            toast.error(msg);
        } finally {
            setSaving(false);
        }
    }, [tenantSlug, config, validationIssues.length, t, toast]);

    // Re-sync if the prop ever changes (server-driven refresh).
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setConfig(cloneConfig(initialConfig));
    }, [initialConfig]);

    const totalCells = config.likelihoodLevels * config.impactLevels;

    return (
        <div
            id="risk-matrix-admin"
            data-testid="risk-matrix-admin"
            className="animate-fadeIn space-y-section p-6"
        >
            <BackAffordance />
            <header className="flex flex-wrap items-end justify-between gap-compact">
                <div>
                    <PageBreadcrumbs
                        items={[
                            { label: t('crumb.dashboard'), href: `/t/${tenantSlug}/dashboard` },
                            { label: t('crumb.admin'), href: `/t/${tenantSlug}/admin` },
                            { label: t('riskMatrix.crumb') },
                        ]}
                        className="mb-1"
                    />
                    <Heading level={1}>
                        {t('riskMatrix.title')}
                    </Heading>
                    <p className="mt-1 text-sm text-content-muted">
                        {t('riskMatrix.description')}
                    </p>
                </div>
                <div className="flex gap-tight">
                    <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        id="risk-matrix-restore-defaults"
                        onClick={restoreDefaults}
                        disabled={saving}
                    >
                        {t('riskMatrix.restoreDefaults')}
                    </Button>
                    <Button
                        variant="primary"
                        size="sm"
                        type="button"
                        id="risk-matrix-save-btn"
                        onClick={save}
                        disabled={saving || validationIssues.length > 0}
                        loading={saving}
                    >
                        {saving ? t('riskMatrix.saving') : t('riskMatrix.saveChanges')}
                    </Button>
                </div>
            </header>

            {(validationIssues.length > 0 || serverError) && (
                <div
                    role="alert"
                    className="rounded-lg border border-border-error bg-bg-error p-3 text-sm text-content-error"
                    data-testid="risk-matrix-admin-error"
                >
                    {serverError && (
                        <p className="font-medium">{serverError}</p>
                    )}
                    {validationIssues.length > 0 && (
                        <ul className="list-inside list-disc">
                            {validationIssues.map((issue, i) => (
                                <li key={i}>{issue}</li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            <div className="grid grid-cols-1 gap-section lg:grid-cols-2">
                {/* ── Editor ─────────────────────────────────────── */}
                <section className="space-y-section animate-fadeIn">
                    {/* Dimensions */}
                    <Card className="space-y-default">
                        <Heading level={3}>
                            {t('riskMatrix.dimensions')}
                        </Heading>
                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <label className="block">
                                <span className="mb-1 block text-xs text-content-muted">
                                    {t('riskMatrix.likelihoodLevels')}
                                </span>
                                <NumberStepper
                                    id="rm-likelihood-levels"
                                    ariaLabel={t('riskMatrix.likelihoodLevels')}
                                    value={config.likelihoodLevels}
                                    min={2}
                                    max={10}
                                    onChange={setLikelihoodLevels}
                                />
                            </label>
                            <label className="block">
                                <span className="mb-1 block text-xs text-content-muted">
                                    {t('riskMatrix.impactLevels')}
                                </span>
                                <NumberStepper
                                    id="rm-impact-levels"
                                    ariaLabel={t('riskMatrix.impactLevels')}
                                    value={config.impactLevels}
                                    min={2}
                                    max={10}
                                    onChange={setImpactLevels}
                                />
                            </label>
                        </div>
                        <p className="text-xs text-content-subtle">
                            {t('riskMatrix.totalCells', { count: totalCells })}
                        </p>
                    </Card>

                    {/* Axis titles */}
                    <Card className="space-y-default">
                        <Heading level={3}>
                            {t('riskMatrix.axisTitles')}
                        </Heading>
                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <label className="block">
                                <span className="mb-1 block text-xs text-content-muted">
                                    {t('riskMatrix.likelihoodAxisTitle')}
                                </span>
                                <input
                                    id="rm-axis-likelihood"
                                    type="text"
                                    className="input w-full"
                                    maxLength={64}
                                    value={config.axisLikelihoodLabel}
                                    onChange={(e) =>
                                        setConfig((p) => ({
                                            ...p,
                                            axisLikelihoodLabel: e.target.value,
                                        }))
                                    }
                                />
                            </label>
                            <label className="block">
                                <span className="mb-1 block text-xs text-content-muted">
                                    {t('riskMatrix.impactAxisTitle')}
                                </span>
                                <input
                                    id="rm-axis-impact"
                                    type="text"
                                    className="input w-full"
                                    maxLength={64}
                                    value={config.axisImpactLabel}
                                    onChange={(e) =>
                                        setConfig((p) => ({
                                            ...p,
                                            axisImpactLabel: e.target.value,
                                        }))
                                    }
                                />
                            </label>
                        </div>
                    </Card>

                    {/* Per-level labels */}
                    <Card className="space-y-default">
                        <Heading level={3}>
                            {t('riskMatrix.perLevelLabels')}
                        </Heading>
                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <div>
                                <p className="mb-2 text-xs text-content-muted">
                                    {t('riskMatrix.likelihood')}
                                </p>
                                <div className="space-y-tight">
                                    {config.levelLabels.likelihood.map(
                                        (label, idx) => (
                                            <input
                                                key={`l-${idx}`}
                                                type="text"
                                                className="input w-full text-sm"
                                                maxLength={64}
                                                value={label}
                                                onChange={(e) =>
                                                    setLikelihoodLabel(
                                                        idx,
                                                        e.target.value,
                                                    )
                                                }
                                                data-testid={`rm-label-likelihood-${idx}`}
                                            />
                                        ),
                                    )}
                                </div>
                            </div>
                            <div>
                                <p className="mb-2 text-xs text-content-muted">
                                    {t('riskMatrix.impact')}
                                </p>
                                <div className="space-y-tight">
                                    {config.levelLabels.impact.map(
                                        (label, idx) => (
                                            <input
                                                key={`i-${idx}`}
                                                type="text"
                                                className="input w-full text-sm"
                                                maxLength={64}
                                                value={label}
                                                onChange={(e) =>
                                                    setImpactLabel(
                                                        idx,
                                                        e.target.value,
                                                    )
                                                }
                                                data-testid={`rm-label-impact-${idx}`}
                                            />
                                        ),
                                    )}
                                </div>
                            </div>
                        </div>
                    </Card>

                    {/* Bands */}
                    <Card className="space-y-compact">
                        <div className="flex items-center justify-between">
                            <Heading level={3}>
                                {t('riskMatrix.severityBands')}
                            </Heading>
                            <Button
                                variant="primary"
                                icon={<Plus className="-ml-0.5 -mr-2.5" />}
                                type="button"
                                id="rm-add-band-btn"
                                onClick={addBand}
                            >
                                {t('riskMatrix.band')}
                            </Button>
                        </div>
                        <p className="text-xs text-content-subtle">
                            {t('riskMatrix.bandsCoverHint', { count: totalCells })}
                        </p>
                        <ul className="space-y-tight">
                            {config.bands.map((band, idx) => (
                                <li
                                    key={`band-${idx}`}
                                    className="grid grid-cols-12 items-center gap-tight rounded-md border border-border-default bg-bg-subtle p-2"
                                    data-testid={`rm-band-row-${idx}`}
                                >
                                    <input
                                        type="text"
                                        className="input col-span-4 text-sm"
                                        value={band.name}
                                        onChange={(e) =>
                                            updateBand(idx, {
                                                name: e.target.value,
                                            })
                                        }
                                        aria-label={t('riskMatrix.bandNameAria', { n: idx + 1 })}
                                        data-testid={`rm-band-name-${idx}`}
                                    />
                                    <input
                                        type="number"
                                        className="input col-span-2 text-sm tabular-nums"
                                        value={band.minScore}
                                        min={1}
                                        max={totalCells}
                                        onChange={(e) =>
                                            updateBand(idx, {
                                                minScore: Number(e.target.value),
                                            })
                                        }
                                        aria-label={t('riskMatrix.bandMinAria', { n: idx + 1 })}
                                        data-testid={`rm-band-min-${idx}`}
                                    />
                                    <input
                                        type="number"
                                        className="input col-span-2 text-sm tabular-nums"
                                        value={band.maxScore}
                                        min={1}
                                        max={totalCells}
                                        onChange={(e) =>
                                            updateBand(idx, {
                                                maxScore: Number(e.target.value),
                                            })
                                        }
                                        aria-label={t('riskMatrix.bandMaxAria', { n: idx + 1 })}
                                        data-testid={`rm-band-max-${idx}`}
                                    />
                                    <input
                                        type="color"
                                        className="col-span-2 h-9 w-full cursor-pointer rounded border border-border-default bg-transparent"
                                        value={
                                            // <input type="color"> only
                                            // accepts 6-digit hex.
                                            band.color.length === 7
                                                ? band.color
                                                : '#888888'
                                        }
                                        onChange={(e) =>
                                            updateBand(idx, {
                                                color: e.target.value,
                                            })
                                        }
                                        aria-label={t('riskMatrix.bandColorAria', { n: idx + 1 })}
                                        data-testid={`rm-band-color-${idx}`}
                                    />
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        type="button"
                                        className="col-span-2"
                                        onClick={() => removeBand(idx)}
                                        aria-label={t('riskMatrix.removeBandAria', { n: idx + 1 })}
                                        data-testid={`rm-band-remove-${idx}`}
                                        disabled={config.bands.length <= 1}
                                    >
                                        {t('riskMatrix.remove')}
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    </Card>
                </section>

                {/* ── Live preview ───────────────────────────────── */}
                <aside className="space-y-tight">
                    <Heading level={3}>
                        {t('riskMatrix.preview')}
                    </Heading>
                    <p className="text-xs text-content-muted">
                        {t('riskMatrix.previewHint')}
                    </p>
                    <RiskMatrix
                        config={config}
                        cells={previewCells}
                        title={t('riskMatrix.preview')}
                        showSwapToggle={false}
                        data-testid="risk-matrix-admin-preview"
                    />
                </aside>
            </div>
        </div>
    );
}
