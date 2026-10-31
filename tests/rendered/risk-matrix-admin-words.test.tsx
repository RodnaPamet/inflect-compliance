/**
 * #4823 — the risk-matrix editor speaks to the person editing it: a broken
 * rule is a sentence about bands and levels, never a field name; a smaller
 * grid says how many risks it would leave outside before anybody saves; and a
 * failed save never shows its HTTP status.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';

// next-intl is ESM; this resolves real en.json values, and the flat
// `{count, plural, one {…} other {…}}` blocks the catalogue uses, so a test
// asserting a count asserts the sentence rather than its template.
jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const PLURAL = /\{(\w+),\s*plural,\s*one\s*\{([^{}]*)\}\s*other\s*\{([^{}]*)\}\s*\}/g;
    const format = (str: string, params: Record<string, unknown> = {}) =>
        str
            .replace(PLURAL, (_b: string, name: string, one: string, other: string) => {
                const n = Number(params[name]);
                return (n === 1 ? one : other).replace(/#/g, String(n));
            })
            .replace(/\{(\w+)\}/g, (m: string, name: string) => (name in params ? String(params[name]) : m));
    const cache = new Map<string, unknown>();
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) {
                cache.set(ns, (key: string, params?: Record<string, unknown>) => {
                    const v = `${ns}.${key}`
                        .split('.')
                        .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en);
                    return typeof v === 'string' ? format(v, params) : key;
                });
            }
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

import { RiskMatrixAdminClient } from '@/app/t/[tenantSlug]/(app)/admin/risk-matrix/RiskMatrixAdminClient';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DEFAULT_RISK_MATRIX_CONFIG } from '@/lib/risk-matrix/defaults';
import type { RiskLevelsInUse } from '@/lib/risk-matrix/levels-in-use';
import en from '../../messages/en.json';

const rm = en.admin.riskMatrix;

function renderEditor(levelsInUse?: RiskLevelsInUse[]) {
    return render(
        <TooltipProvider delayDuration={0}>
            <RiskMatrixAdminClient tenantSlug="acme" initialConfig={DEFAULT_RISK_MATRIX_CONFIG} levelsInUse={levelsInUse} />
        </TooltipProvider>,
    );
}

const decrease = (id: string) =>
    fireEvent.click(within(document.getElementById(id) as HTMLElement).getByLabelText(/decrease/i));

beforeEach(() => {
    global.fetch = jest.fn();
});

describe('a broken rule', () => {
    it('names the scores no band covers, not a field', () => {
        renderEditor();
        // The default bands are 1-4, 5-9, 10-16, 17-25: ending the second at 7
        // leaves 8 and 9 uncovered.
        fireEvent.change(screen.getByTestId('rm-band-max-1'), { target: { value: '7' } });
        const panel = screen.getByTestId('risk-matrix-admin-error');
        const [second, third] = DEFAULT_RISK_MATRIX_CONFIG.bands.slice(1, 3);
        expect(panel).toHaveTextContent(
            rm.issue.bandGap
                .replace('{start}', '8')
                .replace('{end}', '9')
                .replace('{from}', second.name)
                .replace('{to}', third.name),
        );
        expect(panel.textContent).not.toMatch(/minScore|maxScore|→/);
    });

    it('says the last band must reach the highest score', () => {
        renderEditor();
        fireEvent.change(screen.getByTestId('rm-band-max-3'), { target: { value: '24' } });
        expect(screen.getByTestId('risk-matrix-admin-error')).toHaveTextContent(
            rm.issue.lastBandEnd.replace('{expected}', '25').replace('{got}', '24'),
        );
    });

    it('says when two bands overlap', () => {
        renderEditor();
        fireEvent.change(screen.getByTestId('rm-band-min-2'), { target: { value: '9' } });
        const [second, third] = DEFAULT_RISK_MATRIX_CONFIG.bands.slice(1, 3);
        expect(screen.getByTestId('risk-matrix-admin-error')).toHaveTextContent(
            rm.issue.bandOverlap.replace('{from}', second.name).replace('{to}', third.name),
        );
    });
});

describe('a smaller grid', () => {
    const levels: RiskLevelsInUse[] = [
        { likelihood: 5, impact: 2, count: 2 },
        { likelihood: 3, impact: 3, count: 4 },
    ];

    it('says nothing while every risk still has a cell', () => {
        renderEditor(levels);
        expect(document.getElementById('risk-matrix-outside-warning')).toBeNull();
    });

    it('says how many risks it would leave outside, before saving', () => {
        renderEditor(levels);
        decrease('rm-likelihood-levels');
        const warning = document.getElementById('risk-matrix-outside-warning') as HTMLElement;
        expect(warning).toHaveTextContent('2 risks use a likelihood or impact above this grid.');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('uses the singular for one risk', () => {
        renderEditor([{ likelihood: 2, impact: 5, count: 1 }]);
        decrease('rm-impact-levels');
        expect(document.getElementById('risk-matrix-outside-warning')).toHaveTextContent(
            '1 risk uses a likelihood or impact above this grid.',
        );
    });
});

describe('a failed save', () => {
    const save = () => fireEvent.click(document.getElementById('risk-matrix-save-btn') as HTMLElement);

    it('shows the server\'s reason for a refusal', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: false,
            status: 403,
            json: async () => ({ error: { message: 'You cannot change the risk matrix.' } }),
        });
        renderEditor();
        save();
        await waitFor(() =>
            expect(screen.getByTestId('risk-matrix-admin-error')).toHaveTextContent('You cannot change the risk matrix.'),
        );
    });

    it('says only that it failed when the server faults, never the status', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
        renderEditor();
        save();
        await waitFor(() => expect(screen.getByTestId('risk-matrix-admin-error')).toHaveTextContent(rm.saveFailedGeneric));
        expect(screen.getByTestId('risk-matrix-admin-error').textContent).not.toMatch(/500/);
    });
});

describe('the wording', () => {
    it('speaks of the workspace and of example risks, not a tenant or a payload', () => {
        renderEditor();
        const text = document.body.textContent ?? '';
        expect(text).toContain(rm.description);
        expect(text).toContain(rm.previewHint);
        expect(text).not.toMatch(/tenant|synthetic|payload/i);
    });
});
