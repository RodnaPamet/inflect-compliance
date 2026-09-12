'use client';

import { useTranslations } from 'next-intl';

import { InfoTooltip } from '@/components/ui/tooltip';

/**
 * ONE FIGURE, WITH ITS DEFINITION, AND WITHOUT A FALSE ZERO (#2463).
 *
 * The reporting module states the two contracts this component exists to keep,
 * and both are easy to break by rendering a number the obvious way.
 *
 * ── A. EVERY NUMBER CARRIES ITS DEFINITION ──────────────────────────
 *
 * "'12 agents' is not a fact until somebody has said which twelve — over what
 * population, at what moment, counting retired ones or not." So the SHORT
 * definition is on screen beside the figure, as text. The long form — what is
 * deliberately counted IN and OUT — goes in the tooltip, because `excludes` is
 * the arguable half and an assessor reading a number wants to know what was left
 * out before they accept it, not instead of seeing the number.
 *
 * A metric whose definition the backend could not resolve renders the GAP rather
 * than the figure alone: `definitionsFor` drops unknown ids on purpose so a
 * missing definition "degrades to a visible coverage gap in the payload instead
 * of taking the whole report down" — and a UI that quietly printed the bare
 * number would undo exactly that.
 *
 * ── B. EMPTY, UNKNOWN AND ZERO ARE THREE DIFFERENT ANSWERS ──────────
 *
 * A `Measure` is either MEASURED with a value, or one of NO_POPULATION /
 * NOT_ASSESSED / NOT_OBSERVABLE with a `basis` code and a NULL value. The
 * module's own example is the one to keep in mind: summing an empty drill list
 * gives 0, "which reads as the strongest claim the product can make — 'nothing
 * got through the kill switch' — from a tenant that has never run a drill."
 *
 * So this component never coerces. `value ?? 0` and `{value || '—'}` are both
 * the bug, and neither appears here: a non-MEASURED state renders its basis in
 * words, and the basis vocabulary is closed precisely so it can be translated.
 */

/** Mirrors `Measure` from `@/lib/agentic/report-measures` across the wire. */
export interface MeasureView {
    state: 'MEASURED' | 'NO_POPULATION' | 'NOT_ASSESSED' | 'NOT_OBSERVABLE';
    value: number | null;
    basis: string | null;
}

/** Mirrors `MetricDefinition` from `@/lib/agentic/report-definitions`. */
export interface DefinitionView {
    id: string;
    label: string;
    population: string;
    moment: 'AS_OF_GENERATION' | 'OVER_WINDOW';
    includes: readonly string[];
    excludes: readonly string[];
}

export function Metric({
    id,
    measure,
    definition,
}: {
    id: string;
    measure: MeasureView;
    /** `undefined` when the backend resolved no definition — rendered, not hidden. */
    definition: DefinitionView | undefined;
}) {
    const t = useTranslations('agents');

    return (
        <div className="space-y-tight" data-testid={`metric-${id}`} data-metric-id={id}>
            <p className="text-xs uppercase tracking-wide text-content-subtle">
                {definition?.label ?? id}
            </p>

            {measure.state === 'MEASURED' ? (
                <p className="text-lg tabular-nums text-content-emphasis" data-testid={`metric-value-${id}`}>
                    {measure.value}
                </p>
            ) : (
                // NOT a dash and NOT a zero. The state and its basis, in words.
                <p className="text-sm text-content-warning" data-testid={`metric-absent-${id}`}>
                    {t(`reports.basis.${measure.basis ?? 'UNKNOWN'}`)}
                </p>
            )}

            {definition ? (
                <p className="text-xs text-content-muted" data-testid={`metric-definition-${id}`}>
                    {definition.population}
                    {' '}
                    <InfoTooltip
                        aria-label={t('reports.definitionAria', { label: definition.label })}
                        iconClassName="h-3 w-3"
                        content={
                            `${t('reports.moment')}: ${t(`reports.momentValue.${definition.moment}`)}. ` +
                            `${t('reports.includes')}: ${definition.includes.join('; ')}. ` +
                            `${t('reports.excludes')}: ${definition.excludes.join('; ')}.`
                        }
                    />
                </p>
            ) : (
                // The backend's deliberate degradation, surfaced. Silence here
                // would hand an assessor a number nobody can defend, which is
                // the single failure the definitions block exists to prevent.
                <p className="text-xs text-content-error" data-testid={`metric-undefined-${id}`}>
                    {t('reports.definitionMissing')}
                </p>
            )}
        </div>
    );
}
