/**
 * RQ2-5 — `<RiskMatrix>` ALE heat overlay rendered tests.
 *
 * Locks the overlay's contract:
 *   - ZERO cost when nothing is quantified: no toggle, no data
 *     attribute change, the matrix is byte-identical to pre-RQ2-5.
 *   - The toggle appears only with monetary data, and flips the
 *     `data-ale-overlay` attribute + per-cell paint intensity.
 *   - Cells show the compact € value; intensity tracks the cell's
 *     ALE share (heaviest cell saturated, ALE-less cells faded).
 *   - Counts, click-through, and existing a11y labels survive the
 *     overlay; the aria-label gains the ALE sentence.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { RiskMatrix } from '@/components/risks/RiskMatrix';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DEFAULT_RISK_MATRIX_CONFIG } from '@/lib/risk-matrix/defaults';

function withTooltip(node: React.ReactNode) {
    return <TooltipProvider delayDuration={0}>{node}</TooltipProvider>;
}

const QUANT_CELLS = [
    { likelihood: 5, impact: 5, count: 2, totalAle: 2_000_000 },
    { likelihood: 2, impact: 3, count: 3, totalAle: 500_000 },
    { likelihood: 1, impact: 1, count: 1, totalAle: 0 },
];

describe('RiskMatrix — ALE overlay zero-cost guarantee', () => {
    it('no toggle and no overlay attribute when no cell carries ALE', () => {
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    cells={[{ likelihood: 3, impact: 3, count: 4 }]}
                />,
            ),
        );
        expect(screen.queryByTestId('risk-matrix-ale-toggle')).toBeNull();
        expect(screen.getByTestId('risk-matrix')).toHaveAttribute(
            'data-ale-overlay',
            'false',
        );
    });

    it('overlay stays off by default even with ALE data (count mode is canonical)', () => {
        render(
            withTooltip(
                <RiskMatrix config={DEFAULT_RISK_MATRIX_CONFIG} cells={QUANT_CELLS} />,
            ),
        );
        expect(screen.getByTestId('risk-matrix')).toHaveAttribute(
            'data-ale-overlay',
            'false',
        );
        expect(screen.queryByTestId('risk-matrix-cell-ale')).toBeNull();
    });
});

describe('RiskMatrix — ALE overlay on', () => {
    function renderAndToggle(onCellClick?: (c: { likelihood: number; impact: number }) => void) {
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    cells={QUANT_CELLS}
                    onCellClick={onCellClick}
                />,
            ),
        );
        fireEvent.click(screen.getByTestId('risk-matrix-ale-toggle'));
    }

    it('toggle flips the data attribute and renders compact € values', () => {
        renderAndToggle();
        expect(screen.getByTestId('risk-matrix')).toHaveAttribute(
            'data-ale-overlay',
            'true',
        );
        expect(screen.getByText('€2.0M')).toBeInTheDocument();
        expect(screen.getByText('€500K')).toBeInTheDocument();
    });

    it('paint intensity tracks ALE share — heaviest cell saturated, ALE-less faded', () => {
        renderAndToggle();
        const heavy = screen.getByTestId('risk-matrix-cell-5-5');
        const light = screen.getByTestId('risk-matrix-cell-2-3');
        const none = screen.getByTestId('risk-matrix-cell-1-1');
        const opacity = (el: HTMLElement) => parseFloat(el.style.opacity);
        expect(opacity(heavy)).toBeCloseTo(0.92, 2);
        expect(opacity(light)).toBeLessThan(opacity(heavy));
        expect(opacity(none)).toBeCloseTo(0.2, 2);
    });

    it('counts and click-through survive; aria-label gains the ALE sentence', () => {
        const onCellClick = jest.fn();
        renderAndToggle(onCellClick);
        const heavy = screen.getByTestId('risk-matrix-cell-5-5');
        expect(heavy).toHaveAttribute('data-count', '2');
        expect(heavy.getAttribute('aria-label')).toMatch(/annualised loss expectancy €2\.0M/);
        fireEvent.click(heavy);
        expect(onCellClick).toHaveBeenCalledWith(
            expect.objectContaining({ likelihood: 5, impact: 5 }),
        );
    });

    it('toggling back off restores the classic flat paint', () => {
        renderAndToggle();
        fireEvent.click(screen.getByTestId('risk-matrix-ale-toggle'));
        expect(screen.getByTestId('risk-matrix')).toHaveAttribute(
            'data-ale-overlay',
            'false',
        );
        expect(screen.queryByTestId('risk-matrix-cell-ale')).toBeNull();
        const light = screen.getByTestId('risk-matrix-cell-2-3');
        expect(parseFloat(light.style.opacity)).toBeCloseTo(0.92, 2);
    });
});
