/**
 * RQ3-OB-E — grid keyboard navigation rendered tests.
 *
 * Locks: the matrix advertises role="grid", which contracts arrow-key
 * navigation across cells. Roving tabindex (one tabbable cell at a
 * time) + arrow keys (clamped at edges) + Home/End for row jumps.
 *
 * The grid is keyboard-navigable only when `onCellClick` is wired
 * (a read-only matrix has no destination, so arrow nav would be a
 * dead end). Tests assert both branches.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { RiskMatrix } from '@/components/risks/RiskMatrix';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DEFAULT_RISK_MATRIX_CONFIG } from '@/lib/risk-matrix/defaults';

function withTooltip(node: React.ReactNode) {
    return <TooltipProvider delayDuration={0}>{node}</TooltipProvider>;
}

const cellAt = (likelihood: number, impact: number) =>
    screen.getByTestId(`risk-matrix-cell-${likelihood}-${impact}`);

const tabIndexOf = (el: HTMLElement) => el.getAttribute('tabindex');

/**
 * RiskMatrixCell treats `count === 0` as non-interactive (empty
 * cells have no destination). Seed every cell with a stub count so
 * the keyboard-nav contract is exercised across the whole grid.
 */
const FULL_CELLS = Array.from({ length: 5 }, (_, l) =>
    Array.from({ length: 5 }, (_, i) => ({
        likelihood: l + 1,
        impact: i + 1,
        count: 1,
    })),
).flat();

describe('RiskMatrix — RQ3-OB-E grid keyboard nav', () => {
    it('non-interactive matrix: every cell stays tabIndex=-1 (no dead-end stops)', () => {
        render(
            withTooltip(
                <RiskMatrix config={DEFAULT_RISK_MATRIX_CONFIG} cells={[]} />,
            ),
        );
        for (const l of [1, 2, 3, 4, 5]) {
            for (const i of [1, 2, 3, 4, 5]) {
                expect(tabIndexOf(cellAt(l, i))).toBe('-1');
            }
        }
    });

    it('interactive matrix: exactly ONE cell carries tabIndex=0 — the default landing spot (5×5 top-left)', () => {
        const onCellClick = jest.fn();
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    cells={FULL_CELLS}
                    onCellClick={onCellClick}
                />,
            ),
        );
        // Default top-left rendered cell = high likelihood (5) × low impact (1).
        const tabbable = screen
            .getAllByTestId(/^risk-matrix-cell-/)
            .filter((el) => tabIndexOf(el) === '0');
        expect(tabbable).toHaveLength(1);
        expect(tabbable[0].getAttribute('data-testid')).toBe('risk-matrix-cell-5-1');
    });

    it('ArrowDown moves focus down a row (likelihood 5 → 4)', () => {
        const onCellClick = jest.fn();
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    cells={FULL_CELLS}
                    onCellClick={onCellClick}
                />,
            ),
        );
        const start = cellAt(5, 1);
        start.focus();
        fireEvent.keyDown(start, { key: 'ArrowDown' });
        // The new tabbable cell is L=4, I=1.
        expect(tabIndexOf(cellAt(4, 1))).toBe('0');
        expect(tabIndexOf(cellAt(5, 1))).toBe('-1');
    });

    it('ArrowRight moves focus along the impact axis (1 → 2)', () => {
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    cells={FULL_CELLS}
                    onCellClick={jest.fn()}
                />,
            ),
        );
        const start = cellAt(5, 1);
        start.focus();
        fireEvent.keyDown(start, { key: 'ArrowRight' });
        expect(tabIndexOf(cellAt(5, 2))).toBe('0');
    });

    it('ArrowLeft at the left edge clamps (no wrap, no panic)', () => {
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    cells={FULL_CELLS}
                    onCellClick={jest.fn()}
                />,
            ),
        );
        const start = cellAt(5, 1);
        start.focus();
        fireEvent.keyDown(start, { key: 'ArrowLeft' });
        // Stays put — geographic axes don't wrap.
        expect(tabIndexOf(cellAt(5, 1))).toBe('0');
    });

    it('ArrowUp at the top edge clamps', () => {
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    cells={FULL_CELLS}
                    onCellClick={jest.fn()}
                />,
            ),
        );
        const start = cellAt(5, 1);
        start.focus();
        fireEvent.keyDown(start, { key: 'ArrowUp' });
        expect(tabIndexOf(cellAt(5, 1))).toBe('0');
    });

    it('Home jumps to the row\'s left edge', () => {
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    cells={FULL_CELLS}
                    onCellClick={jest.fn()}
                />,
            ),
        );
        // Start at (5, 3), Home → (5, 1).
        const start = cellAt(5, 1);
        start.focus();
        fireEvent.keyDown(start, { key: 'ArrowRight' });
        fireEvent.keyDown(cellAt(5, 2), { key: 'ArrowRight' });
        expect(tabIndexOf(cellAt(5, 3))).toBe('0');
        fireEvent.keyDown(cellAt(5, 3), { key: 'Home' });
        expect(tabIndexOf(cellAt(5, 1))).toBe('0');
    });

    it('End jumps to the row\'s right edge (5×5: impact 5)', () => {
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    cells={FULL_CELLS}
                    onCellClick={jest.fn()}
                />,
            ),
        );
        const start = cellAt(5, 1);
        start.focus();
        fireEvent.keyDown(start, { key: 'End' });
        expect(tabIndexOf(cellAt(5, 5))).toBe('0');
    });

    it('Enter still fires onCellClick (arrow nav does NOT shadow Enter/Space)', () => {
        const onCellClick = jest.fn();
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    cells={FULL_CELLS}
                    onCellClick={onCellClick}
                />,
            ),
        );
        const start = cellAt(5, 1);
        start.focus();
        fireEvent.keyDown(start, { key: 'Enter' });
        expect(onCellClick).toHaveBeenCalled();
    });
});
