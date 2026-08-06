/**
 * Rendered cover for the per-risk ALE chip (RQ3-4, "one formatter, two
 * registers").
 *
 * REPLACES the source-regex assertions in
 * `tests/guards/rq3-4-tail-language.test.ts`, which matched the formatter's
 * UI copy verbatim — including an EM-DASH:
 *
 *     expect(lib).toMatch(/\(mean — run a simulation for tails\)/)
 *     expect(lib).toMatch(/bad year \$\{money\(aleP90\)\} \(P90\)/)
 *
 * Copy-editing a string, or typing a hyphen where an em-dash was, turned CI
 * red. Meanwhile nothing checked what a reader actually sees. These tests
 * assert the rendered output, so the wording is free to change and the
 * BEHAVIOUR is pinned:
 *
 *   - a risk with tail data shows both registers;
 *   - a risk without shows the mean alone — never a fabricated bad year;
 *   - P90 at or below the mean is not tail data and must not add a register
 *     (the subtle one: a simulation that produced a P90 equal to the mean
 *     would otherwise render "€100K · bad yr €100K", which reads as a
 *     measured tail rather than the absence of one);
 *   - an unquantified risk renders NOTHING, not a zero or a dash.
 */
import { render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RiskAleChip } from '@/app/t/[tenantSlug]/(app)/risks/_shared/RiskAleChip';

/** Terse, deterministic money formatter — the chip takes it as a prop. */
const money = (v: number | null | undefined) => {
    const n = v ?? 0;
    return n >= 1_000_000 ? `€${(n / 1_000_000).toFixed(1)}M` : `€${Math.round(n / 1000)}K`;
};

function renderChip(props: Partial<React.ComponentProps<typeof RiskAleChip>> = {}) {
    return render(
        <TooltipProvider delayDuration={0}>
            <RiskAleChip
                riskId="r1"
                ale={120_000}
                aleP90={null}
                money={money}
                tooltip="Annualised loss expectancy"
                {...props}
            />
        </TooltipProvider>,
    );
}

describe('RiskAleChip', () => {
    it('shows both registers when the simulation produced a fatter tail', () => {
        renderChip({ ale: 120_000, aleP90: 1_400_000 });
        const chip = screen.getByTestId('risk-ale-r1');
        expect(chip).toHaveTextContent('€120K');
        expect(chip).toHaveTextContent('€1.4M');
    });

    it('shows the mean alone when there is no tail data', () => {
        renderChip({ ale: 120_000, aleP90: null });
        const chip = screen.getByTestId('risk-ale-r1');
        expect(chip).toHaveTextContent('€120K');
        // No second number invented from thin air.
        expect((chip.textContent!.match(/€/g) ?? []).length).toBe(1);
    });

    it('does not add a second register when P90 is not above the mean', () => {
        renderChip({ ale: 100_000, aleP90: 100_000 });
        const chip = screen.getByTestId('risk-ale-r1');
        // One number, not two identical ones dressed up as a tail.
        expect((chip.textContent!.match(/€/g) ?? []).length).toBe(1);
    });

    it('does not add a second register when P90 is BELOW the mean', () => {
        renderChip({ ale: 100_000, aleP90: 40_000 });
        const chip = screen.getByTestId('risk-ale-r1');
        expect((chip.textContent!.match(/€/g) ?? []).length).toBe(1);
        expect(chip).toHaveTextContent('€100K');
    });

    it('renders nothing at all for an unquantified risk', () => {
        // The honest-null contract. A zero here would read as "we measured
        // this and it is nil"; the truth is "nobody has quantified it".
        const { container } = renderChip({ ale: null, aleP90: null });
        expect(screen.queryByTestId('risk-ale-r1')).toBeNull();
        expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when only a P90 exists without a mean', () => {
        const { container } = renderChip({ ale: null, aleP90: 900_000 });
        expect(container).toBeEmptyDOMElement();
    });

    it('keys the test id by risk id so a table row can be targeted', () => {
        renderChip({ riskId: 'risk-abc' });
        expect(screen.getByTestId('risk-ale-risk-abc')).toBeInTheDocument();
    });
});
