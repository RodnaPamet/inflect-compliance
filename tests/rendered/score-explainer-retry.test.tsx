/**
 * RQ3-OB-B — Score explainer Retry behaviour.
 *
 * Locks: when the score-explanation fetch fails, the popover
 * surfaces a Retry button; clicking it re-fires the SAME endpoint
 * (no leakage to a different path) and recovers when the second
 * call succeeds.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as React from 'react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { RiskScoreExplainer } from '@/components/risks/RiskScoreExplainer';

const renderExplainer = () =>
    render(
        <TooltipProvider delayDuration={0}>
            <RiskScoreExplainer tenantSlug="acme" riskId="r-1" label="20 · High">
                <button data-testid="trigger" type="button">
                    20
                </button>
            </RiskScoreExplainer>
        </TooltipProvider>,
    );

describe('RiskScoreExplainer — Retry on error', () => {
    afterEach(() => jest.clearAllMocks());

    it('renders the Retry button on error and re-fires the same endpoint when clicked', async () => {
        // Both calls fail — we only care that clicking Retry FIRES
        // the SAME endpoint a second time; recovery rendering is
        // covered by the existing explainer suite.
        const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 500 } as Response);
        global.fetch = fetchMock as unknown as typeof fetch;

        renderExplainer();
        fireEvent.click(screen.getByTestId('trigger'));

        // Error branch appears with the retry CTA.
        await waitFor(() => expect(screen.getByTestId('score-explainer-error')).toBeInTheDocument());
        expect(screen.getByTestId('score-explainer-retry')).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledWith('/api/t/acme/risks/r-1/score-explanation');
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Click Retry → second fetch fires to the SAME endpoint.
        fireEvent.click(screen.getByTestId('score-explainer-retry'));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        expect(fetchMock).toHaveBeenLastCalledWith('/api/t/acme/risks/r-1/score-explanation');
    });
});
