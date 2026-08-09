/**
 * polish #3 — provenance attribution grammar.
 *
 * The AI source previously read "(accepted AI suggestion) by Alice",
 * which made the human assessor sound incidental to the machine.
 * The decision belongs to the acceptor; the AI is the proposer.
 *
 * Renders the explainer popover with a one-event recentEvents list
 * per source and asserts the user-facing string.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as React from 'react';

jest.mock('@/lib/format-date', () => ({
    formatDateTime: () => '2026-06-11 12:00',
}));

import { RiskScoreExplainer } from '@/components/risks/RiskScoreExplainer';

type Event = {
    kind: 'INHERENT' | 'RESIDUAL';
    likelihood: number;
    impact: number;
    score: number;
    source: 'USER' | 'DERIVED' | 'PLAN' | 'AI' | 'MIGRATION';
    justification: string | null;
    actorName: string | null;
    createdAt: string;
};

function payload(event: Event) {
    return {
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
        recentEvents: [event],
    };
}

async function openPopoverWith(event: Event) {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => payload(event) })) as unknown as typeof fetch;
    render(
        <RiskScoreExplainer tenantSlug="acme" riskId="r-1">
            <span>20</span>
        </RiskScoreExplainer>,
    );
    fireEvent.click(screen.getByLabelText('Explain this score'));
    await waitFor(() => expect(screen.getByText(/Inherent 20/)).toBeInTheDocument());
}

const baseEvent: Event = {
    kind: 'INHERENT',
    likelihood: 4, impact: 5, score: 20,
    source: 'USER',
    justification: null,
    actorName: 'Alice',
    createdAt: '2026-06-11T12:00:00Z',
};

describe('explainer — provenance attribution grammar', () => {
    afterEach(() => { jest.resetAllMocks(); });

    it('USER attributes the assessor', async () => {
        await openPopoverWith({ ...baseEvent, source: 'USER' });
        expect(screen.getByText(/manual assessment by Alice/)).toBeInTheDocument();
    });

    it('AI puts the assessor on the verb, not the suggestion', async () => {
        await openPopoverWith({ ...baseEvent, source: 'AI' });
        expect(screen.getByText(/AI suggestion · accepted by Alice/)).toBeInTheDocument();
    });

    it('AI without an actor still reads honestly', async () => {
        await openPopoverWith({ ...baseEvent, source: 'AI', actorName: null });
        expect(screen.getByText(/AI suggestion(?!.*accepted)/)).toBeInTheDocument();
    });

    it('MIGRATION never claims an actor (the backfill is honest about itself)', async () => {
        await openPopoverWith({ ...baseEvent, source: 'MIGRATION', actorName: 'Alice' });
        expect(screen.getByText(/pre-provenance backfill/)).toBeInTheDocument();
        expect(screen.queryByText(/by Alice/)).toBeNull();
    });

    it('DERIVED and PLAN keep their wording', async () => {
        await openPopoverWith({ ...baseEvent, source: 'DERIVED', actorName: 'Bob' });
        expect(screen.getByText(/accepted control derivation by Bob/)).toBeInTheDocument();
    });
});
