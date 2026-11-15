/** @jest-environment jsdom */

/**
 * The heatmap cell speaks the reader's language (#5309).
 *
 * The axis titles and toggles around it were Bulgarian; every cell's
 * screen-reader label, tooltip and bubble summary ("3 Risks identified") were
 * English literals in the component.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

// The Bulgarian catalogue, memoised per namespace. `mock`-prefixed so the
// hoisted factory may read it.
const mockBg: Record<string, unknown> = require('../../messages/bg.json');
jest.mock('next-intl', () => {
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        const lookup = (key: string) => walk(mockBg, ns ? `${ns}.${key}` : key);
        const t = (key: string, values?: Record<string, unknown>) => {
            const v = lookup(key);
            if (typeof v !== 'string') return key;
            return v.replace(/\{(\w+)\}/g, (m, name) => (values && name in values ? String(values[name]) : m));
        };
        t.has = (key: string) => typeof lookup(key) === 'string';
        return t;
    };
    return {
        useTranslations: (ns = '') => {
            if (!cache.has(ns)) cache.set(ns, make(ns));
            return cache.get(ns);
        },
        useLocale: () => 'bg',
    };
});

import { RiskMatrixCell } from '@/components/risks/RiskMatrixCell';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DEFAULT_RISK_MATRIX_CONFIG } from '@/lib/risk-matrix/defaults';

function bg(path: string): string {
    const v = path.split('.').reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        mockBg,
    );
    if (typeof v !== 'string') throw new Error(`no bg message ${path}`);
    return v;
}

const risks = [
    { id: 'r1', title: 'Фишинг' },
    { id: 'r2', title: 'Прекъсване' },
    { id: 'r3', title: 'Изтичане' },
];

describe('<RiskMatrixCell> in Bulgarian', () => {
    it('labels the cell for a screen reader in Bulgarian', () => {
        render(
            <TooltipProvider delayDuration={0}>
                <RiskMatrixCell
                    likelihood={5}
                    impact={5}
                    count={3}
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    aleOverlay
                    totalAle={125000}
                    formatMoney={(v) => `€${v}`}
                    collisionRatio={12}
                />
            </TooltipProvider>,
        );
        const label = screen.getByTestId('risk-matrix-cell-5-5').getAttribute('aria-label') ?? '';
        expect(label).toContain(`3 ${bg('common.chart.riskOther')}`);
        expect(label).toContain(bg('common.chart.cellAleAria').replace('{amount}', '€125000'));
        expect(label).toContain(bg('common.chart.cellCollisionAria').replace('{ratio}', '12'));
        expect(label).not.toMatch(/\brisks\b|annualised|warning/);
    });

    it('summarises a multi-risk bubble cell in Bulgarian', () => {
        render(
            <TooltipProvider delayDuration={0}>
                <RiskMatrixCell
                    likelihood={5}
                    impact={5}
                    count={3}
                    config={DEFAULT_RISK_MATRIX_CONFIG}
                    mode="bubble"
                    risks={risks}
                />
            </TooltipProvider>,
        );
        const summary = screen.getByTestId('risk-matrix-cell-count-summary');
        expect(summary.textContent).toBe(bg('common.chart.cellRisksIdentified').replace('{count}', '3'));
        expect(summary.textContent).not.toMatch(/identified/i);
    });
});
