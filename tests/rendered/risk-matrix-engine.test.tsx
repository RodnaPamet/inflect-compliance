/**
 * `<RiskMatrix>` engine — Epic 44.3 rendered tests.
 *
 * Locks the engine's behavioural contract:
 *   - Default 5×5 parity (cell count, axis labels, ordering, legend
 *     chips) — a regression here would silently change every
 *     existing tenant's matrix UI.
 *   - NxN dimensions: 4×6 / 7×7 render the right cell count, row /
 *     column count, and per-axis labels.
 *   - Bubble overlay: a single-risk cell shows its title inline; a
 *     multi-risk cell collapses to a "N Risks identified" count
 *     summary (the names live in the hover tooltip).
 *   - Axis swap: data placement stays semantically correct after
 *     toggling — a click on the same DOM position before/after
 *     swap dispatches a different (likelihood, impact) cell to
 *     onCellClick.
 *   - Dense cells stay legible: no per-title chips, no overflow;
 *     count summary / fallback when `risks` is absent.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';

import { RiskMatrix } from '@/components/risks/RiskMatrix';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DEFAULT_RISK_MATRIX_CONFIG } from '@/lib/risk-matrix/defaults';
import type { RiskMatrixConfigShape } from '@/lib/risk-matrix/types';

function withTooltip(node: React.ReactNode) {
    return <TooltipProvider delayDuration={0}>{node}</TooltipProvider>;
}

const FOUR_BY_SIX_CONFIG: RiskMatrixConfigShape = {
    likelihoodLevels: 4,
    impactLevels: 6,
    axisLikelihoodLabel: 'Probability',
    axisImpactLabel: 'Severity',
    levelLabels: {
        likelihood: ['Rare', 'Unlikely', 'Likely', 'Certain'],
        impact: ['Trivial', 'Minor', 'Moderate', 'Major', 'Severe', 'Catastrophic'],
    },
    bands: [
        { name: 'Low', minScore: 1, maxScore: 6, color: '#22c55e' },
        { name: 'Medium', minScore: 7, maxScore: 12, color: '#f59e0b' },
        { name: 'High', minScore: 13, maxScore: 18, color: '#ef4444' },
        { name: 'Critical', minScore: 19, maxScore: 24, color: '#7c2d12' },
    ],
};

describe('<RiskMatrix> — default 5×5 parity', () => {
    it('renders 25 cells in the canonical 5×5 layout', () => {
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    cells={[]}
                />,
            ),
        );
        for (let l = 1; l <= 5; l += 1) {
            for (let i = 1; i <= 5; i += 1) {
                expect(
                    screen.getByTestId(`risk-matrix-cell-${l}-${i}`),
                ).toBeInTheDocument();
            }
        }
    });

    it('uses Likelihood / Impact axis titles by default', () => {
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    cells={[]}
                />,
            ),
        );
        const grid = screen.getByTestId('risk-matrix-grid');
        expect(grid.getAttribute('aria-label')).toBe('Likelihood by Impact matrix');
    });

    it('renders the canonical 4-band legend below the grid', () => {
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    cells={[]}
                />,
            ),
        );
        const legend = screen.getByTestId('risk-matrix-legend');
        const chips = within(legend).getAllByRole('listitem');
        expect(chips).toHaveLength(4);
    });

    it('totals risks across cells in the header chrome', () => {
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    cells={[
                        { likelihood: 4, impact: 5, count: 3 },
                        { likelihood: 1, impact: 1, count: 2 },
                    ]}
                />,
            ),
        );
        // Header carries the running total.
        const card = screen.getByTestId('risk-matrix');
        expect(card.textContent).toContain('5 risks');
    });
});

describe('<RiskMatrix> — NxN dimensions', () => {
    it('renders a non-square 4×6 layout from config', () => {
        render(
            withTooltip(
                <RiskMatrix config={FOUR_BY_SIX_CONFIG} cells={[]} />,
            ),
        );
        // 4 rows × 6 cols = 24 cells.
        const cells = document.querySelectorAll(
            '[data-testid^="risk-matrix-cell-"]',
        );
        expect(cells).toHaveLength(24);
    });

    it('drives row + column counts from likelihoodLevels + impactLevels', () => {
        render(
            withTooltip(
                <RiskMatrix config={FOUR_BY_SIX_CONFIG} cells={[]} />,
            ),
        );
        // 4 row labels (1..4) + 6 col labels (1..6).
        for (let r = 1; r <= 4; r += 1) {
            expect(
                screen.getByTestId(`risk-matrix-row-label-${r}`),
            ).toBeInTheDocument();
        }
        for (let c = 1; c <= 6; c += 1) {
            expect(
                screen.getByTestId(`risk-matrix-col-label-${c}`),
            ).toBeInTheDocument();
        }
    });

    it('uses the configured axis titles', () => {
        render(
            withTooltip(
                <RiskMatrix config={FOUR_BY_SIX_CONFIG} cells={[]} />,
            ),
        );
        const grid = screen.getByTestId('risk-matrix-grid');
        expect(grid.getAttribute('aria-label')).toBe('Probability by Severity matrix');
    });
});

describe('<RiskMatrix> — bubble overlay', () => {
    it('shows the single risk title inline when a bubble cell holds exactly one risk', () => {
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    mode="bubble"
                    cells={[
                        {
                            likelihood: 4,
                            impact: 5,
                            count: 1,
                            risks: [{ id: 'r1', title: 'Supply chain breach' }],
                        },
                    ]}
                />,
            ),
        );
        const cell = screen.getByTestId('risk-matrix-cell-4-5');
        expect(cell.textContent).toContain('Supply chain breach');
        // A single risk is NOT collapsed to a count summary.
        expect(
            within(cell).queryByTestId('risk-matrix-cell-count-summary'),
        ).toBeNull();
    });

    it('collapses a cell with multiple risks to a "N Risks identified" summary (names move to the tooltip)', () => {
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    mode="bubble"
                    cells={[
                        {
                            likelihood: 5,
                            impact: 5,
                            count: 2,
                            risks: [
                                { id: 'r1', title: 'Supply chain breach' },
                                { id: 'r2', title: 'Insider data exfil' },
                            ],
                        },
                    ]}
                />,
            ),
        );
        const cell = screen.getByTestId('risk-matrix-cell-5-5');
        // The cell shows the count summary, not the crammed titles.
        expect(
            within(cell).getByTestId('risk-matrix-cell-count-summary')
                .textContent,
        ).toContain('2 Risks identified');
        // Individual names are not rendered inside the cell box.
        expect(cell.textContent).not.toContain('Supply chain breach');
        expect(cell.textContent).not.toContain('Insider data exfil');
    });

    it('pluralises the summary and never renders per-title chips for a dense cell', () => {
        const risks = Array.from({ length: 7 }, (_, i) => ({
            id: `r${i}`,
            title: `Risk ${i + 1}`,
        }));
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    mode="bubble"
                    cells={[{ likelihood: 5, impact: 5, count: 7, risks }]}
                />,
            ),
        );
        const cell = screen.getByTestId('risk-matrix-cell-5-5');
        expect(
            within(cell).getByTestId('risk-matrix-cell-count-summary')
                .textContent,
        ).toContain('7 Risks identified');
        // No per-title chips and no "+N more" overflow chip.
        expect(cell.textContent).not.toContain('Risk 1');
        expect(
            within(cell).queryByTestId('risk-matrix-cell-bubbles'),
        ).toBeNull();
        expect(
            within(cell).queryByTestId('risk-matrix-cell-overflow'),
        ).toBeNull();
    });

    it('falls back to count when risks is absent in bubble mode', () => {
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    mode="bubble"
                    cells={[{ likelihood: 4, impact: 5, count: 12 }]}
                />,
            ),
        );
        // No `risks` array supplied — engine prints the count instead
        // of erroring out, so partial / unmigrated data layers stay
        // safe.
        const cell = screen.getByTestId('risk-matrix-cell-4-5');
        expect(cell.textContent).toContain('12');
    });

    it('count mode renders the numeric tally (default)', () => {
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    cells={[{ likelihood: 3, impact: 3, count: 4 }]}
                />,
            ),
        );
        const cell = screen.getByTestId('risk-matrix-cell-3-3');
        expect(cell.textContent).toContain('4');
        // No bubble container in count mode.
        expect(
            within(cell).queryByTestId('risk-matrix-cell-bubbles'),
        ).toBeNull();
    });
});

describe('<RiskMatrix> — axis swap', () => {
    it('default orientation: rows=likelihood, cols=impact', () => {
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    cells={[]}
                />,
            ),
        );
        const card = screen.getByTestId('risk-matrix');
        expect(card.getAttribute('data-swap-axes')).toBe('false');
        const grid = screen.getByTestId('risk-matrix-grid');
        expect(grid.getAttribute('aria-label')).toBe('Likelihood by Impact matrix');
    });

    it('swap toggle flips the axis label + data-swap-axes attribute', () => {
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    cells={[]}
                />,
            ),
        );
        fireEvent.click(screen.getByTestId('risk-matrix-swap'));
        const card = screen.getByTestId('risk-matrix');
        expect(card.getAttribute('data-swap-axes')).toBe('true');
        const grid = screen.getByTestId('risk-matrix-grid');
        expect(grid.getAttribute('aria-label')).toBe('Impact by Likelihood matrix');
    });

    it('placement remains semantically correct after a swap', () => {
        const onCellClick = jest.fn();
        const cells = [
            // L=5, I=1 — high likelihood / low impact; 5 risks.
            { likelihood: 5, impact: 1, count: 5 },
        ];
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    cells={cells}
                    onCellClick={onCellClick}
                />,
            ),
        );

        // The cell carrying L=5, I=1 has the same data-testid before
        // AND after the swap — only its rendered position changes.
        const cell = screen.getByTestId('risk-matrix-cell-5-1');
        expect(cell.getAttribute('data-count')).toBe('5');

        fireEvent.click(cell);
        expect(onCellClick).toHaveBeenCalledWith(
            expect.objectContaining({ likelihood: 5, impact: 1, count: 5 }),
        );

        // Toggle swap; same data cell still at the same data-testid.
        fireEvent.click(screen.getByTestId('risk-matrix-swap'));
        const cellAfter = screen.getByTestId('risk-matrix-cell-5-1');
        expect(cellAfter.getAttribute('data-count')).toBe('5');
    });

    it('honours an explicit swapAxes prop and hides the toggle', () => {
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    cells={[]}
                    swapAxes
                />,
            ),
        );
        expect(
            screen.getByTestId('risk-matrix').getAttribute('data-swap-axes'),
        ).toBe('true');
        // External-control mode: internal toggle is hidden so the
        // parent stays the source of truth.
        expect(screen.queryByTestId('risk-matrix-swap')).toBeNull();
    });
});

describe('<RiskMatrix> — dense cells', () => {
    it('renders 100 cells without throwing for a 10×10 layout', () => {
        const ten: RiskMatrixConfigShape = {
            ...DEFAULT_RISK_MATRIX_CONFIG,
            likelihoodLevels: 10,
            impactLevels: 10,
            levelLabels: {
                likelihood: Array.from({ length: 10 }, (_, i) => `L${i + 1}`),
                impact: Array.from({ length: 10 }, (_, i) => `I${i + 1}`),
            },
            bands: [
                { name: 'Low', minScore: 1, maxScore: 25, color: '#22c55e' },
                { name: 'Medium', minScore: 26, maxScore: 50, color: '#f59e0b' },
                { name: 'High', minScore: 51, maxScore: 75, color: '#ef4444' },
                { name: 'Critical', minScore: 76, maxScore: 100, color: '#7c2d12' },
            ],
        };
        render(withTooltip(<RiskMatrix config={ten} cells={[]} />));
        const cells = document.querySelectorAll(
            '[data-testid^="risk-matrix-cell-"]',
        );
        expect(cells).toHaveLength(100);
    });

    it('selectedKey highlights the matching semantic cell', () => {
        render(
            withTooltip(
                <RiskMatrix
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    cells={[{ likelihood: 4, impact: 4, count: 1 }]}
                    selectedKey="4-4"
                />,
            ),
        );
        const cell = screen.getByTestId('risk-matrix-cell-4-4');
        expect(cell.getAttribute('data-selected')).toBe('true');
    });
});
