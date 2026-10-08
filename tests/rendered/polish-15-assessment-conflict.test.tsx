/**
 * polish #15 — assessment-panel save-conflict warning.
 *
 * If the user opens a manual residual draft and then saves a new
 * inherent assessment, the draft now applies to a DIFFERENT
 * inherent baseline. The panel must warn before the residual save,
 * not silently rebase the conclusion.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as React from 'react';

// next-intl is ESM (jest can't parse its export); mock it to resolve real
// en.json values (with {var} interpolation) so text assertions still hold.
// No local `next-intl` factory here, on purpose.
//
// This file used to declare one, and its namespace lookup was `en[ns]` — a
// SINGLE top-level key. It split the KEY on dots but not the NAMESPACE, so a
// component calling `useTranslations('common.ui')` resolved `en['common.ui']`,
// got undefined, and fell through to `return key`. Every string it rendered
// came out as the key rather than the English text.
//
// That was invisible while the components this panel renders used
// single-segment namespaces. `<NumberStepper>` localising its
// `incrementAriaLabel` default (#3209) made it visible: `getAllByLabelText(
// 'Increase')` started failing because the label was the literal "increase".
//
// `__mocks__/next-intl.js` is applied automatically and resolves
// `${namespace}.${key}` as one path, which is correct for nested catalogues.
// Its docblock says a local factory overrides it — so declaring one here was
// opting out of the working implementation. It also exports a strict superset
// of what this file used (`useLocale` included).

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
}));

import { RiskAssessmentPanel, type AssessmentRisk } from '@/app/t/[tenantSlug]/(app)/risks/[riskId]/RiskAssessmentPanel';

const MATRIX = {
    likelihoodLevels: 5,
    impactLevels: 5,
    axisLikelihoodLabel: 'Likelihood',
    axisImpactLabel: 'Impact',
    levelLabels: { likelihood: ['1', '2', '3', '4', '5'], impact: ['1', '2', '3', '4', '5'] },
    bands: [{ name: 'Low', minScore: 1, maxScore: 6, color: '#22c55e' }],
};
const SUGGESTION = {
    riskId: 'r-1',
    inherent: { likelihood: 4, impact: 5, score: 20 },
    current: { residualLikelihood: null, residualImpact: null, residualScore: null },
    suggestion: null,
    combined: { likelihoodReduction: 0, impactReduction: 0, participatingCount: 0, contributions: [] },
    summary: 'No linked controls carry an effectiveness signal yet',
};
const BASE: AssessmentRisk = {
    likelihood: 4, impact: 5, inherentScore: 20,
    residualLikelihood: null, residualImpact: null, residualScore: null,
    treatment: null, nextReviewAt: null, status: 'OPEN',
};

function mockFetch() {
    return jest.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/risk-matrix-config')) return { ok: true, json: async () => MATRIX };
        if (url.includes('/residual-suggestion')) return { ok: true, json: async () => SUGGESTION };
        if (url.includes('/kri-breaches')) return { ok: true, json: async () => ({ breaches: [] }) };
        // P1 — Step 4 mounts the treatment-plan card, which lists plans.
        if (url.includes('/treatment-plans')) return { ok: true, json: async () => ({ rows: [] }) };
        if (init?.method === 'PUT') return { ok: true, json: async () => ({ success: true }) };
        throw new Error(`Unexpected fetch: ${url}`);
    });
}

describe('assessment panel — save-conflict warning', () => {
    it('saving inherent while a residual draft is open surfaces a baseline warning', async () => {
        global.fetch = mockFetch() as unknown as typeof fetch;
        render(
            <RiskAssessmentPanel
                tenantSlug="t-1"
                riskId="r-1"
                risk={BASE}
                matrixConfig={MATRIX as React.ComponentProps<typeof RiskAssessmentPanel>['matrixConfig']}
                canWrite
                canAdmin={false}
                ownerChoices={[]}
                onRiskUpdated={() => {}}
                onQuantify={() => {}}
                onLinkControls={() => {}}
                onStatusChange={() => {}}
            />,
        );
        await waitFor(() =>
            expect(screen.getByText(/1 · Inherent assessment/)).toBeInTheDocument(),
        );

        // Open the manual residual draft.
        // Dirty the inherent step BEFORE opening the residual draft:
        // the "Save assessment" button needs an inherent-dirty state.
        // Each NumberStepper has its own Increase/Decrease pair —
        // the inherent likelihood is the FIRST in DOM order.
        const incButtons = screen.getAllByLabelText('Increase');
        fireEvent.click(incButtons[0]);
        // Open the manual residual draft.
        fireEvent.click(screen.getByText('Assess residual manually'));
        expect(screen.queryByTestId('residual-baseline-warning')).toBeNull();
        // Save inherent now that the residual override panel is open.
        fireEvent.click(await screen.findByText('Save assessment'));

        await waitFor(() =>
            expect(screen.getByTestId('residual-baseline-warning')).toBeInTheDocument(),
        );
        expect(screen.getByTestId('residual-baseline-warning').textContent).toMatch(
            /Inherent has changed/,
        );
    });

    it('canceling the residual draft clears the warning', async () => {
        global.fetch = mockFetch() as unknown as typeof fetch;
        render(
            <RiskAssessmentPanel
                tenantSlug="t-1"
                riskId="r-1"
                risk={BASE}
                matrixConfig={MATRIX as React.ComponentProps<typeof RiskAssessmentPanel>['matrixConfig']}
                canWrite
                canAdmin={false}
                ownerChoices={[]}
                onRiskUpdated={() => {}}
                onQuantify={() => {}}
                onLinkControls={() => {}}
                onStatusChange={() => {}}
            />,
        );
        await waitFor(() =>
            expect(screen.getByText(/1 · Inherent assessment/)).toBeInTheDocument(),
        );
        fireEvent.click(screen.getAllByLabelText('Increase')[0]);
        fireEvent.click(screen.getByText('Assess residual manually'));
        fireEvent.click(await screen.findByText('Save assessment'));
        await waitFor(() =>
            expect(screen.getByTestId('residual-baseline-warning')).toBeInTheDocument(),
        );
        fireEvent.click(screen.getByText('Cancel'));
        expect(screen.queryByTestId('residual-baseline-warning')).toBeNull();
    });
});
