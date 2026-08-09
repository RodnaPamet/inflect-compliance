/**
 * RQ2-9 — `<RiskMatrix>` movement overlay rendered tests.
 *
 * Locks: zero-cost default (no movements → no toggle, no overlay),
 * arrow dedupe with counts, same-cell pairs skipped, axis-swap
 * coordinate correctness, and the count/click contract surviving.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { RiskMatrix, type RiskMovement } from '@/components/risks/RiskMatrix';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DEFAULT_RISK_MATRIX_CONFIG } from '@/lib/risk-matrix/defaults';

function withTooltip(node: React.ReactNode) {
    return <TooltipProvider delayDuration={0}>{node}</TooltipProvider>;
}

const MOVES: RiskMovement[] = [
    { riskId: 'r1', title: 'A', from: { likelihood: 4, impact: 5 }, to: { likelihood: 2, impact: 4 } },
    { riskId: 'r2', title: 'B', from: { likelihood: 4, impact: 5 }, to: { likelihood: 2, impact: 4 } },
    { riskId: 'r3', title: 'C', from: { likelihood: 3, impact: 3 }, to: { likelihood: 1, impact: 3 } },
    // No movement — must not draw.
    { riskId: 'r4', title: 'D', from: { likelihood: 2, impact: 2 }, to: { likelihood: 2, impact: 2 } },
];

describe('RiskMatrix — movement overlay zero-cost guarantee', () => {
    it('no toggle without movement data', () => {
        render(
            withTooltip(
                <RiskMatrix config={DEFAULT_RISK_MATRIX_CONFIG} cells={[]} />,
            ),
        );
        expect(screen.queryByTestId('risk-matrix-movement-toggle')).toBeNull();
        expect(screen.getByTestId('risk-matrix')).toHaveAttribute('data-movement', 'false');
    });

    it('overlay stays off by default even with movement data', () => {
        render(
            withTooltip(
                <RiskMatrix config={DEFAULT_RISK_MATRIX_CONFIG} cells={[]} movements={MOVES} />,
            ),
        );
        expect(screen.queryByTestId('risk-matrix-movement-overlay')).toBeNull();
    });
});

describe('RiskMatrix — movement overlay on', () => {
    function renderAndToggle() {
        render(
            withTooltip(
                <RiskMatrix config={DEFAULT_RISK_MATRIX_CONFIG} cells={[]} movements={MOVES} />,
            ),
        );
        fireEvent.click(screen.getByTestId('risk-matrix-movement-toggle'));
    }

    it('deduplicates identical paths into one arrow with a count; same-cell pairs skipped', () => {
        renderAndToggle();
        const arrows = screen.getAllByTestId('risk-matrix-movement-arrow');
        // r1+r2 share a path (one arrow, count 2); r3 is its own; r4 skipped.
        expect(arrows).toHaveLength(2);
        const counts = arrows.map((a) => a.getAttribute('data-count')).sort();
        expect(counts).toEqual(['1', '2']);
        expect(screen.getByText('×2')).toBeInTheDocument();
    });

    it('the overlay announces the moved-risk total', () => {
        renderAndToggle();
        expect(screen.getByTestId('risk-matrix-movement-overlay')).toHaveAttribute(
            'aria-label',
            '3 risks moved from inherent to residual position',
        );
    });

    it('arrow geometry: likelihood drop renders as downward y (residual below inherent)', () => {
        renderAndToggle();
        const arrow = screen
            .getAllByTestId('risk-matrix-movement-arrow')
            .find((a) => a.getAttribute('data-count') === '2')!;
        const line = arrow.querySelector('line')!;
        // 5×5: from L4 → y=(5-4+0.5)/5*100=30; to L2 → y=70. Impact
        // 5→4 moves left: x 90 → 70.
        expect(parseFloat(line.getAttribute('y1')!)).toBeCloseTo(30);
        expect(parseFloat(line.getAttribute('y2')!)).toBeCloseTo(70);
        expect(parseFloat(line.getAttribute('x1')!)).toBeCloseTo(90);
        expect(parseFloat(line.getAttribute('x2')!)).toBeCloseTo(70);
    });

    it('toggling off removes the overlay and resets the data attribute', () => {
        renderAndToggle();
        fireEvent.click(screen.getByTestId('risk-matrix-movement-toggle'));
        expect(screen.queryByTestId('risk-matrix-movement-overlay')).toBeNull();
        expect(screen.getByTestId('risk-matrix')).toHaveAttribute('data-movement', 'false');
    });

    // RQ3-OB-D — the arrow names its risks (not just a count).
    it('each arrow carries an SVG <title> naming the risks on its path', () => {
        renderAndToggle();
        const arrows = screen.getAllByTestId('risk-matrix-movement-arrow');
        const titles = arrows.map((a) => a.querySelector('title')?.textContent).sort();
        // r1+r2 → "A, B"; r3 → "C".
        expect(titles).toEqual(['A, B', 'C']);
    });

    it('a hovered arrow opts back into pointer events so the native title fires', () => {
        renderAndToggle();
        const arrow = screen.getAllByTestId('risk-matrix-movement-arrow')[0];
        // The overlay is pointer-events-none; the arrow group overrides
        // it so the browser tooltip can surface on hover.
        expect(arrow).toHaveStyle({ pointerEvents: 'auto' });
    });
});
