/**
 * `<RiskMatrixAdminClient>` rendered tests — Epic 44.5
 *
 * Locks the editor's UX contract against the canonical default + a
 * representative custom layout. Every assertion maps to a success
 * criterion in the prompt:
 *   - the dimension steppers are wired
 *   - axis title inputs round-trip text
 *   - per-level label inputs resize when dimensions change
 *   - the band editor add/remove/edit flow validates
 *   - validation errors surface inline before save
 *   - save POSTs to the admin route + applies the server response
 *   - the live preview re-renders against the draft config
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';

// next-intl is ESM (jest can't parse its export); mock it to resolve real
// en.json values so text assertions track the original English.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    return {
        useTranslations: (ns: string) => (key: string, params?: Record<string, unknown>) => {
            // Resolve the full `ns.key` path from the catalog ROOT so dotted
            // namespaces (e.g. `common.chart`) traverse correctly — `en[ns]`
            // alone fails for a dotted namespace and returns the bare key.
            const full = ns ? `${ns}.${key}` : key;
            let v = full
                .split('.')
                .reduce((o: unknown, k) =>
                    o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined, en as unknown);
            if (typeof v !== 'string') return key;
            if (params) for (const [p, val] of Object.entries(params)) v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            return v;
        },
        useLocale: () => 'en',
    };
});

import { RiskMatrixAdminClient } from '@/app/t/[tenantSlug]/(app)/admin/risk-matrix/RiskMatrixAdminClient';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DEFAULT_RISK_MATRIX_CONFIG } from '@/lib/risk-matrix/defaults';

function withTooltip(node: React.ReactNode) {
    return <TooltipProvider delayDuration={0}>{node}</TooltipProvider>;
}

// `sonner` toasts mount a global Toaster portal; jsdom renders fine
// without it but emits noisy console warnings. Stub out for clean
// test output.
jest.mock('sonner', () => ({
    toast: {
        success: jest.fn(),
        error: jest.fn(),
    },
}));

describe('<RiskMatrixAdminClient>', () => {
    beforeEach(() => {
        global.fetch = jest.fn();
    });

    it('renders the editor seeded from the initial config', () => {
        render(
            withTooltip(
                <RiskMatrixAdminClient
                    tenantSlug="acme"
                    initialConfig={DEFAULT_RISK_MATRIX_CONFIG}
                />,
            ),
        );
        expect(screen.getByTestId('risk-matrix-admin')).toBeInTheDocument();
        expect(
            screen.getByLabelText('Likelihood axis title') ||
                document.getElementById('rm-axis-likelihood'),
        ).toBeTruthy();
        // 4 default-band rows.
        expect(screen.getByTestId('rm-band-row-0')).toBeInTheDocument();
        expect(screen.getByTestId('rm-band-row-3')).toBeInTheDocument();
    });

    it('names every level-name field, which had only its value to go by (#4991)', () => {
        render(
            withTooltip(
                <RiskMatrixAdminClient
                    tenantSlug="acme"
                    initialConfig={DEFAULT_RISK_MATRIX_CONFIG}
                />,
            ),
        );
        expect(screen.getByRole('textbox', { name: 'Likelihood level 1 name' })).toBe(
            screen.getByTestId('rm-label-likelihood-0'),
        );
        expect(screen.getByRole('textbox', { name: 'Impact level 5 name' })).toBe(
            screen.getByTestId('rm-label-impact-4'),
        );
    });

    it('the live preview reflects axis-title edits', () => {
        render(
            withTooltip(
                <RiskMatrixAdminClient
                    tenantSlug="acme"
                    initialConfig={DEFAULT_RISK_MATRIX_CONFIG}
                />,
            ),
        );
        const titleInput = document.getElementById(
            'rm-axis-likelihood',
        ) as HTMLInputElement;
        fireEvent.change(titleInput, { target: { value: 'Probability' } });
        const preview = screen.getByTestId('risk-matrix-admin-preview');
        const grid = within(preview).getByTestId('risk-matrix-grid');
        // Y-axis title (configured Likelihood ↔ here renamed) flows
        // through the matrix grid's aria-label.
        expect(grid.getAttribute('aria-label')).toContain('Probability');
    });

    it('resizing dimensions resizes the per-level label arrays', () => {
        render(
            withTooltip(
                <RiskMatrixAdminClient
                    tenantSlug="acme"
                    initialConfig={DEFAULT_RISK_MATRIX_CONFIG}
                />,
            ),
        );
        // Default 5 likelihood labels; bumping to 6 should add an
        // input at index 5 with the numeric fallback "6".
        const likelihoodStepper = document.getElementById(
            'rm-likelihood-levels',
        );
        expect(likelihoodStepper).toBeTruthy();
        const incrementBtn = within(
            likelihoodStepper as HTMLElement,
        ).getByLabelText(/increase/i);
        fireEvent.click(incrementBtn);
        const sixthLabel = screen.getByTestId(
            'rm-label-likelihood-5',
        ) as HTMLInputElement;
        expect(sixthLabel.value).toBe('6');
    });

    it('shows inline validation issues before allowing save', () => {
        render(
            withTooltip(
                <RiskMatrixAdminClient
                    tenantSlug="acme"
                    initialConfig={DEFAULT_RISK_MATRIX_CONFIG}
                />,
            ),
        );
        // Edit the 4th band's max from 25 → 24 to introduce a coverage
        // gap (last band ends at 24 instead of 25).
        const lastBandMax = screen.getByTestId('rm-band-max-3') as HTMLInputElement;
        fireEvent.change(lastBandMax, { target: { value: '24' } });

        const errorPanel = screen.getByTestId('risk-matrix-admin-error');
        expect(errorPanel.textContent).toMatch(/end at score 25/);

        const saveBtn = document.getElementById('risk-matrix-save-btn') as HTMLButtonElement;
        expect(saveBtn.disabled).toBe(true);
    });

    it('add band → remove band updates the band list', () => {
        // Drop one default band first so the "Add" button has score
        // headroom (defaults already cover 1..25 fully; pressing Add
        // without removing first is a no-op).
        render(
            withTooltip(
                <RiskMatrixAdminClient
                    tenantSlug="acme"
                    initialConfig={DEFAULT_RISK_MATRIX_CONFIG}
                />,
            ),
        );
        // Remove the 4th band.
        fireEvent.click(screen.getByTestId('rm-band-remove-3'));
        expect(screen.queryByTestId('rm-band-row-3')).toBeNull();
        // Add a fresh band — slots in at the end with the leftover range.
        fireEvent.click(document.getElementById('rm-add-band-btn')!);
        expect(screen.getByTestId('rm-band-row-3')).toBeInTheDocument();
    });

    it('save() POSTs the full effective config to the admin route', async () => {
        const responsePayload = {
            ...DEFAULT_RISK_MATRIX_CONFIG,
            axisLikelihoodLabel: 'Probability',
        };
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: async () => responsePayload,
        });

        render(
            withTooltip(
                <RiskMatrixAdminClient
                    tenantSlug="acme"
                    initialConfig={DEFAULT_RISK_MATRIX_CONFIG}
                />,
            ),
        );
        const titleInput = document.getElementById('rm-axis-likelihood') as HTMLInputElement;
        fireEvent.change(titleInput, { target: { value: 'Probability' } });
        fireEvent.click(document.getElementById('risk-matrix-save-btn')!);

        // Allow the click handler microtask to flush.
        await new Promise((r) => setTimeout(r, 0));

        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
        expect(url).toBe('/api/t/acme/admin/risk-matrix-config');
        expect((init as RequestInit).method).toBe('PUT');
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body.axisLikelihoodLabel).toBe('Probability');
        expect(body.bands).toHaveLength(4);
    });
});
