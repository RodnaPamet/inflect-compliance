/**
 * `<RiskMatrixLegend>` rendered tests — Epic 44.2.
 *
 * Locks the legend's UX contract:
 *   - one chip per configured band (default 4-tier)
 *   - chip carries the band's hex colour as inline backgroundColor
 *   - chip text matches the configured band name (custom layouts work)
 *   - score range surfaces by default, hides when showRanges=false
 *   - empty bands renders a non-error placeholder
 *   - role="list" / role="listitem" expose the grouping to a11y
 */

import { render, screen, within } from '@testing-library/react';
import * as React from 'react';

import { RiskMatrixLegend } from '@/components/risks/RiskMatrixLegend';
import { DEFAULT_RISK_MATRIX_CONFIG } from '@/lib/risk-matrix/defaults';

describe('<RiskMatrixLegend>', () => {
    it('renders one chip per configured band', () => {
        render(<RiskMatrixLegend config={DEFAULT_RISK_MATRIX_CONFIG} />);
        const list = screen.getByTestId('risk-matrix-legend');
        expect(within(list).getAllByRole('listitem')).toHaveLength(4);
        expect(
            screen.getByTestId('risk-matrix-legend-chip-low'),
        ).toBeInTheDocument();
        expect(
            screen.getByTestId('risk-matrix-legend-chip-medium'),
        ).toBeInTheDocument();
        expect(
            screen.getByTestId('risk-matrix-legend-chip-high'),
        ).toBeInTheDocument();
        expect(
            screen.getByTestId('risk-matrix-legend-chip-critical'),
        ).toBeInTheDocument();
    });

    it('shows the score range alongside each band by default', () => {
        render(<RiskMatrixLegend config={DEFAULT_RISK_MATRIX_CONFIG} />);
        expect(
            screen.getByTestId('risk-matrix-legend-chip-low').textContent,
        ).toContain('1–4');
        expect(
            screen.getByTestId('risk-matrix-legend-chip-critical').textContent,
        ).toContain('15–25');
    });

    it('hides the score range when showRanges=false', () => {
        render(
            <RiskMatrixLegend
                config={DEFAULT_RISK_MATRIX_CONFIG}
                showRanges={false}
            />,
        );
        expect(
            screen.getByTestId('risk-matrix-legend-chip-low').textContent,
        ).not.toContain('1–4');
    });

    it('applies the configured hex colour to the chip swatch', () => {
        render(<RiskMatrixLegend config={DEFAULT_RISK_MATRIX_CONFIG} />);
        const chip = screen.getByTestId('risk-matrix-legend-chip-critical');
        const swatch = chip.querySelector('[aria-hidden="true"]') as HTMLElement;
        expect(swatch).toBeTruthy();
        // jsdom-normalised inline style
        expect(swatch.style.backgroundColor).toBe('rgb(124, 45, 18)'); // #7c2d12
    });

    it('renders custom 3-band layouts cleanly', () => {
        render(
            <RiskMatrixLegend
                config={{
                    bands: [
                        {
                            name: 'Acceptable',
                            minScore: 1,
                            maxScore: 6,
                            color: '#22c55e',
                        },
                        {
                            name: 'Caution',
                            minScore: 7,
                            maxScore: 12,
                            color: '#f59e0b',
                        },
                        {
                            name: 'Severe',
                            minScore: 13,
                            maxScore: 25,
                            color: '#ef4444',
                        },
                    ],
                }}
            />,
        );
        expect(
            screen.getByTestId('risk-matrix-legend-chip-acceptable'),
        ).toBeInTheDocument();
        expect(
            screen.getByTestId('risk-matrix-legend-chip-caution'),
        ).toBeInTheDocument();
        expect(
            screen.getByTestId('risk-matrix-legend-chip-severe'),
        ).toBeInTheDocument();
    });

    it('renders a placeholder when bands is empty', () => {
        render(<RiskMatrixLegend config={{ bands: [] }} />);
        const node = screen.getByTestId('risk-matrix-legend');
        expect(node.textContent).toMatch(/no severity bands/i);
    });

    it('uses the documented role="list" for assistive tech grouping', () => {
        render(<RiskMatrixLegend config={DEFAULT_RISK_MATRIX_CONFIG} />);
        const list = screen.getByTestId('risk-matrix-legend');
        expect(list.getAttribute('role')).toBe('list');
        expect(list.getAttribute('aria-label')).toBe('Risk severity legend');
    });

    it('switches to vertical layout when orientation=vertical', () => {
        render(
            <RiskMatrixLegend
                config={DEFAULT_RISK_MATRIX_CONFIG}
                orientation="vertical"
            />,
        );
        const list = screen.getByTestId('risk-matrix-legend');
        expect(list.className).toMatch(/flex-col/);
    });
});
