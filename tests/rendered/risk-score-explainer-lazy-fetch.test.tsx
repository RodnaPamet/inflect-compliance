/**
 * The explainer fetches on OPEN, never on mount.
 *
 * A risks table renders one explainer per row. If each chip fetched its own
 * explanation eagerly, a 50-row page would fire 50 requests nobody asked for
 * — the entire reason the payload is lazy.
 *
 * B3-5 — replaces the source-scan in `guardrails/risk-score-explainer.test.ts`
 * ("the explainer lazy-fetches on open — no eager per-chip fetch"), which
 * asserted this by slicing the component source between two declaration
 * NAMES:
 *
 *     component.slice(
 *         component.indexOf('const onOpenChange'),
 *         component.indexOf('return ('),
 *     )
 *
 * CLAUDE.md bans that shape outright: reorder the two declarations and the
 * slice runs backwards, yielding an EMPTY string — every `not.toMatch` inside
 * it then passes while checking nothing. It also cannot distinguish "the
 * handler mentions loadExplanation" from "no request goes out until open",
 * which is the property that actually matters.
 *
 * Counting real fetches settles both.
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

function mountRows(count: number) {
    return render(
        <KeyboardShortcutProvider>
            {Array.from({ length: count }, (_, i) => (
                <RiskScoreExplainer key={i} tenantSlug="acme" riskId={`r-${i}`} label={`${i} · High`}>
                    <span>{i}</span>
                </RiskScoreExplainer>
            ))}
        </KeyboardShortcutProvider>,
    );
}

describe('RiskScoreExplainer — lazy fetch', () => {
    let fetchMock: jest.Mock;
    beforeEach(() => {
        fetchMock = jest.fn(async () => ({ ok: true, json: async () => PAYLOAD }));
        global.fetch = fetchMock as unknown as typeof fetch;
    });
    afterEach(() => { jest.resetAllMocks(); });

    it('fires ZERO requests when a table of chips mounts', () => {
        mountRows(25);
        // The whole point: 25 chips on screen, no network.
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fetches exactly once when one chip is opened', async () => {
        mountRows(25);
        fireEvent.click(screen.getByLabelText('7 · High, explain'));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        // …and it asked for THAT row, not a neighbour's.
        expect(String(fetchMock.mock.calls[0][0])).toContain('r-7');
    });

    it('opening a second chip does not re-fetch the first', async () => {
        mountRows(3);
        fireEvent.click(screen.getByLabelText('0 · High, explain'));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        fireEvent.click(screen.getByLabelText('2 · High, explain'));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        const urls = fetchMock.mock.calls.map((c) => String(c[0]));
        expect(urls.filter((u) => u.includes('r-0'))).toHaveLength(1);
        expect(urls.filter((u) => u.includes('r-2'))).toHaveLength(1);
    });
});
