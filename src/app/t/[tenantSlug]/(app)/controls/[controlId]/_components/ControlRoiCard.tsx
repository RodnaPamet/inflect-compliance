/**
 * RQ3-8 — Control ROI summary card (control detail overview).
 *
 * Reads `/controls/:id/roi` and renders one of:
 *
 *   - ok verdict → "this control buys €X reduction for €Y/yr
 *     (ROI Z×)", with the per-risk count callout;
 *   - gap verdict → a typed, plain-English nudge ("Set an annual
 *     cost…" / "Quantify the linked risks…") — never a fabricated
 *     zero.
 *
 * The card mounts independently of the page-data SWR cache so the
 * verdict reflects link-add / unlink updates without forcing a
 * full page re-render.
 */
'use client';

import { useTranslations } from 'next-intl';

import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useMoneyFormatter } from '@/lib/tenant-context-provider';
import { describeRoiGap, type ControlRoiVerdict } from '@/lib/control-roi';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { SkeletonCard } from '@/components/ui/skeleton';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';

/** Where the effectiveness driving ROI came from — measured test history
 *  wins, else the declared scalar, else nothing. Mirrors the server
 *  `EffectivenessSource` (kept inline so the client bundle never imports
 *  the usecase). */
type EffectivenessSource = 'MEASURED' | 'DECLARED' | null;

interface RoiPayload {
    controlId: string;
    code: string | null;
    name: string;
    annualCost: number | null;
    effectiveness: number | null;
    effectivenessSource: EffectivenessSource;
    verdict: ControlRoiVerdict;
}

export function ControlRoiCard({ controlId }: { controlId: string }) {
    const tx = useTranslations('controls');
    // B1-4 — one formatter per product; the ?? '€' fallback lives in the
    // provider, not forked here.
    const money = useMoneyFormatter();
    const { data, error, isLoading, mutate } = useTenantSWR<RoiPayload>(`/controls/${controlId}/roi`);

    // R2-P4 — surface a load failure with a retry instead of returning null
    // (a silent disappearance the user can't recover from).
    if (error && !data) {
        return (
            <InlineNotice variant="error" data-testid="control-roi-card-error">
                {tx('roi.loadError')}{' '}
                <button type="button" className="underline hover:no-underline" onClick={() => void mutate()}>
                    {tx('roi.retry')}
                </button>
            </InlineNotice>
        );
    }

    if (isLoading || !data) {
        return (
            <div className={cn(cardVariants(), 'space-y-default')} data-testid="control-roi-card-loading">
                <SkeletonCard lines={2} />
            </div>
        );
    }

    const { verdict, annualCost, effectiveness, effectivenessSource } = data;

    return (
        <div
            className={cn(cardVariants(), 'space-y-default')}
            data-testid="control-roi-card"
        >
            <div className="flex items-center gap-1.5">
                <span className="text-xs text-content-subtle uppercase">{tx('roi.eyebrow')}</span>
                {/* Where the effectiveness driving ROI came from — MEASURED
                    pass rate beats a DECLARED analyst estimate. Shown next to
                    the value so the number's provenance is never ambiguous. */}
                {effectivenessSource && (
                    <StatusBadge
                        size="sm"
                        variant={effectivenessSource === 'MEASURED' ? 'success' : 'neutral'}
                        className="ml-auto"
                        id="control-roi-effectiveness-source"
                    >
                        {tx(`roi.source.${effectivenessSource}` as Parameters<typeof tx>[0])}
                    </StatusBadge>
                )}
            </div>
            {verdict.ok ? (
                <div className="space-y-default">
                    <p className="text-sm text-content-default" data-testid="control-roi-headline">
                        {tx.rich('roi.headline', {
                            ale: `${money(verdict.value.aleProtected)}/yr`,
                            cost: `${money(annualCost)}/yr`,
                            roi: verdict.value.roiMultiple.toFixed(1),
                            b: (chunks) => <strong>{chunks}</strong>,
                            m: (chunks) => (
                                <strong data-testid="control-roi-multiple">{chunks}</strong>
                            ),
                        })}
                    </p>
                    <p className="text-xs text-content-subtle">
                        {tx(
                            verdict.value.linkedRiskCount === 1
                                ? 'roi.sublineOne'
                                : 'roi.sublineOther',
                            {
                                quantified: verdict.value.quantifiedRiskCount,
                                linked: verdict.value.linkedRiskCount,
                                effectiveness: effectiveness ?? '',
                            },
                        )}
                    </p>
                </div>
            ) : (
                <div className="space-y-default">
                    <p className="text-sm text-content-warning" data-testid="control-roi-gap">
                        {describeRoiGap(verdict)}
                    </p>
                    <p className="text-xs text-content-subtle">
                        {tx('roi.gapSubline')}
                    </p>
                </div>
            )}
        </div>
    );
}
