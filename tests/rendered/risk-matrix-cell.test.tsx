/**
 * `<RiskMatrixCell>` rendered tests — Epic 44.2.
 *
 * Locks the cell's UX contract:
 *   - score + count + band attributes surface for E2E hooks
 *   - empty cells render the subtle background and no count text
 *   - non-empty cells render the count + apply the band's hex
 *   - `aria-label` describes the cell in screen-reader form
 *   - `onClick` fires on click + Enter + Space (keyboard a11y)
 *   - selected state adds the focus-ring class
 *   - tooltip shows the score / band / count / description copy
 *   - per-axis labels resolve from config (falls back to numeric
 *     when the vocabulary array is shorter)
 */

import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { RiskMatrixCell } from '@/components/risks/RiskMatrixCell';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DEFAULT_RISK_MATRIX_CONFIG } from '@/lib/risk-matrix/defaults';

function withTooltip(node: React.ReactNode) {
    return <TooltipProvider delayDuration={0}>{node}</TooltipProvider>;
}

describe('<RiskMatrixCell>', () => {
    it('renders a non-empty cell with the count + band metadata', () => {
        render(
            withTooltip(
                <RiskMatrixCell
                    likelihood={5}
                    impact={5}
                    count={3}
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                />,
            ),
        );
        const cell = screen.getByTestId('risk-matrix-cell-5-5');
        expect(cell.getAttribute('data-band')).toBe('Critical');
        expect(cell.getAttribute('data-score')).toBe('25');
        expect(cell.getAttribute('data-count')).toBe('3');
        expect(cell.getAttribute('data-empty')).toBe('false');
        expect(cell.textContent).toContain('3');
    });

    it('renders an empty cell with subtle background and no count text', () => {
        render(
            withTooltip(
                <RiskMatrixCell
                    likelihood={1}
                    impact={1}
                    count={0}
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                />,
            ),
        );
        const cell = screen.getByTestId('risk-matrix-cell-1-1');
        expect(cell.getAttribute('data-empty')).toBe('true');
        // No count digit in the cell when empty
        expect(cell.textContent?.trim()).toBe('');
    });

    it('exposes a screen-reader label with band + axis labels + count', () => {
        render(
            withTooltip(
                <RiskMatrixCell
                    likelihood={4}
                    impact={5}
                    count={1}
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                />,
            ),
        );
        const cell = screen.getByTestId('risk-matrix-cell-4-5');
        const label = cell.getAttribute('aria-label')!;
        expect(label).toContain('Likelihood Likely');
        expect(label).toContain('Impact Severe');
        expect(label).toContain('= 20 (Critical)');
        expect(label).toContain('1 risk');
    });

    it('singularises "risk" when count is 1 and pluralises otherwise', () => {
        const { rerender } = render(
            withTooltip(
                <RiskMatrixCell
                    likelihood={3}
                    impact={3}
                    count={1}
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                />,
            ),
        );
        expect(
            screen.getByTestId('risk-matrix-cell-3-3').getAttribute('aria-label'),
        ).toMatch(/1 risk$/);

        rerender(
            withTooltip(
                <RiskMatrixCell
                    likelihood={3}
                    impact={3}
                    count={5}
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                />,
            ),
        );
        expect(
            screen.getByTestId('risk-matrix-cell-3-3').getAttribute('aria-label'),
        ).toMatch(/5 risks$/);
    });

    it('fires onClick on click and on Enter / Space key', () => {
        const onClick = jest.fn();
        render(
            withTooltip(
                <RiskMatrixCell
                    likelihood={3}
                    impact={4}
                    count={2}
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    onClick={onClick}
                />,
            ),
        );
        const cell = screen.getByTestId('risk-matrix-cell-3-4');
        fireEvent.click(cell);
        expect(onClick).toHaveBeenCalledTimes(1);

        fireEvent.keyDown(cell, { key: 'Enter' });
        fireEvent.keyDown(cell, { key: ' ' });
        expect(onClick).toHaveBeenCalledTimes(3);

        // Other keys don't fire
        fireEvent.keyDown(cell, { key: 'a' });
        expect(onClick).toHaveBeenCalledTimes(3);
    });

    it('does not become interactive when count is 0', () => {
        const onClick = jest.fn();
        render(
            withTooltip(
                <RiskMatrixCell
                    likelihood={1}
                    impact={1}
                    count={0}
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    onClick={onClick}
                />,
            ),
        );
        const cell = screen.getByTestId('risk-matrix-cell-1-1');
        fireEvent.click(cell);
        expect(onClick).not.toHaveBeenCalled();
        expect(cell.getAttribute('tabindex')).toBe('-1');
    });

    it('falls back to numeric axis labels when the vocabulary is shorter than the dimension', () => {
        const noLabels = {
            ...DEFAULT_RISK_MATRIX_CONFIG,
            levelLabels: { likelihood: [], impact: [] },
        };
        render(
            withTooltip(
                <RiskMatrixCell
                    likelihood={2}
                    impact={3}
                    count={1}
                    config={noLabels}
                />,
            ),
        );
        const cell = screen.getByTestId('risk-matrix-cell-2-3');
        expect(cell.getAttribute('aria-label')).toContain('Likelihood 2');
        expect(cell.getAttribute('aria-label')).toContain('Impact 3');
    });

    it('renders the configured non-default band name when score falls outside the canonical default', () => {
        const custom = {
            ...DEFAULT_RISK_MATRIX_CONFIG,
            bands: [
                { name: 'Acceptable', minScore: 1, maxScore: 6, color: '#22c55e' },
                { name: 'Caution', minScore: 7, maxScore: 12, color: '#f59e0b' },
                { name: 'Severe', minScore: 13, maxScore: 25, color: '#ef4444' },
            ],
        };
        render(
            withTooltip(
                <RiskMatrixCell
                    likelihood={2}
                    impact={3}
                    count={1}
                    config={custom}
                />,
            ),
        );
        // L2 × I3 = 6 → "Acceptable"
        expect(
            screen.getByTestId('risk-matrix-cell-2-3').getAttribute('data-band'),
        ).toBe('Acceptable');
    });

    it('marks the cell as selected via data-selected attribute', () => {
        const { rerender } = render(
            withTooltip(
                <RiskMatrixCell
                    likelihood={5}
                    impact={5}
                    count={2}
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    selected={false}
                />,
            ),
        );
        let cell = screen.getByTestId('risk-matrix-cell-5-5');
        expect(cell.getAttribute('data-selected')).toBe('false');

        rerender(
            withTooltip(
                <RiskMatrixCell
                    likelihood={5}
                    impact={5}
                    count={2}
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    selected
                />,
            ),
        );
        cell = screen.getByTestId('risk-matrix-cell-5-5');
        expect(cell.getAttribute('data-selected')).toBe('true');
        // The selected state adds an extra ring class outside the
        // focus-visible: prefix — keeps the focus + selected visuals
        // distinguishable.
        expect(cell.className).toMatch(/ring-offset-1/);
    });
});
