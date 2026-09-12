/**
 * EVERY RENDERED FIGURE CARRIES ITS DEFINITION, AND NO ABSENCE BECOMES A ZERO.
 *
 * The two contracts `agent-governance-reports.ts` states, asserted at the render
 * boundary where they are actually breakable.
 *
 * ── DRIVEN FROM THE REGISTRY, NOT A LIST I TYPED ────────────────────
 *
 * The metric ids come from `METRIC_DEFINITIONS` itself. A hand-written list
 * would pass forever while a newly added metric shipped undefined — which is the
 * exact failure the backend's own coverage assertion exists to catch, reproduced
 * one layer up. Adding a metric to the registry without a definition, or
 * rendering one the registry does not know, fails here.
 *
 * ── AND THE FALSE ZERO ──────────────────────────────────────────────
 *
 * A `Measure` is MEASURED with a value, or one of three absences with a NULL
 * value and a `basis`. The module's example is the one worth restating: summing
 * an empty drill list gives 0, "which reads as the strongest claim the product
 * can make — 'nothing got through the kill switch' — from a tenant that has
 * never run a drill." So every absence is asserted to render as WORDS, and
 * asserted NOT to render as a zero or a dash.
 */
import { render, screen } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const make = (ns: string) => (key: string, params?: Record<string, unknown>) => {
        let v = lookup(ns, key);
        if (typeof v !== 'string') return key;
        if (params) for (const [p, val] of Object.entries(params)) {
            v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
        }
        return v;
    };
    return { useTranslations: (ns: string) => make(ns) };
});

jest.mock('@/components/ui/tooltip', () => ({
    __esModule: true,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    InfoTooltip: ({ content }: { content: string }) => <span data-testid="info-tooltip">{content}</span>,
}));

import { Metric, type DefinitionView } from '@/app/t/[tenantSlug]/(app)/agents/reports/Metric';
import { METRIC_DEFINITIONS, METRIC_IDS } from '@/lib/agentic/report-definitions';
import { MEASURE_BASES } from '@/lib/agentic/report-measures';

const asView = (id: string): DefinitionView =>
    METRIC_DEFINITIONS[id as keyof typeof METRIC_DEFINITIONS] as unknown as DefinitionView;

describe('the registry itself is non-empty — these assertions are not vacuous', () => {
    it('has metric ids and basis codes to iterate', () => {
        expect(METRIC_IDS.length).toBeGreaterThan(10);
        expect(MEASURE_BASES.length).toBeGreaterThan(5);
    });
});

describe('every metric in the registry renders its definition', () => {
    it.each(METRIC_IDS.map((id) => [id] as const))('%s shows its population on screen', (id) => {
        const def = asView(id);
        render(
            <Metric id={id} measure={{ state: 'MEASURED', value: 7, basis: null }} definition={def} />,
        );
        // The SHORT definition is text, not a hover. An assessor reading a
        // screenshot has no pointer.
        expect(screen.getByTestId(`metric-definition-${id}`).textContent).toContain(def.population);
        expect(screen.getByTestId(`metric-value-${id}`).textContent).toBe('7');
    });

    it.each(METRIC_IDS.map((id) => [id] as const))('%s carries its excludes in the long form', (id) => {
        const def = asView(id);
        render(
            <Metric id={id} measure={{ state: 'MEASURED', value: 1, basis: null }} definition={def} />,
        );
        // `excludes` is the arguable half — what was deliberately left out is
        // what an assessor challenges.
        const tip = screen.getByTestId('info-tooltip').textContent ?? '';
        for (const excluded of def.excludes) expect(tip).toContain(excluded);
    });
});

describe('a metric with no published definition says so', () => {
    it('renders the gap rather than a bare number', () => {
        // `definitionsFor` drops unknown ids on purpose, so a metric can arrive
        // without one. A UI that printed the number alone would undo that
        // deliberate degradation and hand over an indefensible figure.
        render(
            <Metric id="made.up" measure={{ state: 'MEASURED', value: 3, basis: null }} definition={undefined} />,
        );
        expect(screen.getByTestId('metric-undefined-made.up').textContent).toMatch(/cannot be defended/i);
        expect(screen.queryByTestId('metric-definition-made.up')).not.toBeInTheDocument();
    });
});

describe('an absence is words, never a zero and never a dash', () => {
    it.each(MEASURE_BASES.map((b) => [b] as const))('%s renders as a sentence', (basis) => {
        const id = METRIC_IDS[0];
        render(
            <Metric
                id={id}
                measure={{ state: 'NO_POPULATION', value: null, basis }}
                definition={asView(id)}
            />,
        );
        const absent = screen.getByTestId(`metric-absent-${id}`);
        // Translated, not the raw code — the vocabulary is closed so it CAN be.
        expect(absent.textContent).not.toBe(basis);
        expect((absent.textContent ?? '').length).toBeGreaterThan(20);
        // And the two coercions that would destroy the distinction.
        expect(absent.textContent).not.toMatch(/^0$/);
        expect(absent.textContent).not.toMatch(/^—$/);
        expect(screen.queryByTestId(`metric-value-${id}`)).not.toBeInTheDocument();
    });

    it('the never-drilled case does not read as a proven stop control', () => {
        // The module's own worked example, pinned.
        const id = METRIC_IDS[0];
        render(
            <Metric
                id={id}
                measure={{ state: 'NOT_ASSESSED', value: null, basis: 'NO_DRILLS_RUN' }}
                definition={asView(id)}
            />,
        );
        expect(screen.getByTestId(`metric-absent-${id}`).textContent).toMatch(/never been drilled/i);
    });
});
