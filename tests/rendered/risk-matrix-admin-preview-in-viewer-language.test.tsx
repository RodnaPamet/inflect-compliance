/**
 * The risk-matrix editor's live preview reads in the viewer's language.
 *
 * The preview is a display of the draft, like every other matrix in the
 * product, so the DEFAULT vocabulary ("Low", "Rare", "Likelihood") shows in
 * Bulgarian to a Bulgarian reader, and a name the tenant typed shows as typed.
 * It used to receive the raw draft and showed the English defaults on a
 * Bulgarian page. The editor's own fields keep the stored values: they are
 * what a save writes.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';

jest.mock('next-intl', () => {
    const bg = jest.requireActual('../../messages/bg.json');
    return {
        useTranslations: (ns: string) => (key: string, params?: Record<string, unknown>) => {
            let v = `${ns}.${key}`
                .split('.')
                .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), bg);
            if (typeof v !== 'string') return key;
            if (params) for (const [p, val] of Object.entries(params)) v = (v as string).split(`{${p}}`).join(String(val));
            return v as string;
        },
        useLocale: () => 'bg',
    };
});

jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

import { RiskMatrixAdminClient } from '@/app/t/[tenantSlug]/(app)/admin/risk-matrix/RiskMatrixAdminClient';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DEFAULT_RISK_MATRIX_CONFIG } from '@/lib/risk-matrix/defaults';
import bg from '../../messages/bg.json';

const words = bg.riskMatrixDefaults;

function renderEditor() {
    return render(
        <TooltipProvider delayDuration={0}>
            <RiskMatrixAdminClient tenantSlug="acme" initialConfig={DEFAULT_RISK_MATRIX_CONFIG} />
        </TooltipProvider>,
    );
}

const preview = () => screen.getByTestId('risk-matrix-admin-preview');

describe('the risk-matrix preview, read in Bulgarian', () => {
    it('shows the default axis and band names in Bulgarian, never the English defaults', () => {
        renderEditor();
        const grid = within(preview()).getByTestId('risk-matrix-grid');
        expect(grid.getAttribute('aria-label')).toContain(words.axis.likelihood);
        expect(grid.getAttribute('aria-label')).not.toContain(DEFAULT_RISK_MATRIX_CONFIG.axisLikelihoodLabel);

        const text = preview().textContent ?? '';
        expect(text).toContain(words.axis.impact);
        for (const band of DEFAULT_RISK_MATRIX_CONFIG.bands) {
            expect(text).toContain(words.band[band.name as keyof typeof words.band]);
            expect(text).not.toContain(band.name);
        }
    });

    it('keeps a name the tenant typed exactly as typed', () => {
        renderEditor();
        fireEvent.change(screen.getByTestId('rm-band-name-0'), { target: { value: 'Tolerable' } });
        const text = preview().textContent ?? '';
        expect(text).toContain('Tolerable');
        // The other bands are still the product's, so still translated.
        expect(text).toContain(words.band.Medium);
    });

    it('leaves the editor fields holding the stored values a save writes', () => {
        renderEditor();
        expect((screen.getByTestId('rm-label-likelihood-0') as HTMLInputElement).value).toBe(
            DEFAULT_RISK_MATRIX_CONFIG.levelLabels.likelihood[0],
        );
        expect((screen.getByTestId('rm-band-name-0') as HTMLInputElement).value).toBe(
            DEFAULT_RISK_MATRIX_CONFIG.bands[0].name,
        );
    });
});
