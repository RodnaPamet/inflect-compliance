/**
 * polish #14 — the explainer popover must close on Escape.
 *
 * Radix's Popover handles Escape natively when focus is inside the
 * content; this test PINS that the wiring is intact (no future
 * onEscapeKeyDown override that swallows the event without
 * propagating, no trigger that traps focus).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

import { RiskScoreExplainer } from '@/components/risks/RiskScoreExplainer';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';

const PAYLOAD = {
    riskId: 'r-1',
    inherent: {
        likelihood: 4, impact: 5, score: 20,
        likelihoodLabel: null, impactLabel: null,
        bandName: 'High', bandColor: '#ef4444',
    },
    residual: null,
    controls: { summary: 'No controls', participatingCount: 0, suggestedScore: null },
    quant: null,
    openBreaches: [],
    recentEvents: [],
};

describe('RiskScoreExplainer — keyboard close', () => {
    afterEach(() => { jest.resetAllMocks(); });

    it('Escape on the open popover closes it', async () => {
        global.fetch = jest.fn(async () => ({ ok: true, json: async () => PAYLOAD })) as unknown as typeof fetch;

        render(
            <KeyboardShortcutProvider>
                <RiskScoreExplainer tenantSlug="acme" riskId="r-1">
                    <span>20</span>
                </RiskScoreExplainer>
            </KeyboardShortcutProvider>,
        );
        fireEvent.click(screen.getByLabelText('Explain this score'));
        await waitFor(() =>
            expect(screen.getByRole('region', { name: /Score explanation/ })).toBeInTheDocument(),
        );

        fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
        await waitFor(() =>
            expect(screen.queryByRole('region', { name: /Score explanation/ })).toBeNull(),
        );
    });
});
