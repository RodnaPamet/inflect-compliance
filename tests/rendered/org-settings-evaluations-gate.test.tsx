/**
 * THE ORG SETTINGS PAGE RENDERS THE EVALUATIONS CARD ONLY WHERE BOTH GATES
 * HOLD (owner decisions 2026-11-12): the viewer administers the organization,
 * AND the operator has not opted the organization out in
 * EVALS_CARD_HIDDEN_ORG_SLUGS. Every organization shows it by default.
 *
 * Renders the real server page (awaited, then mounted) with the org context
 * and the agent-switch read stubbed, so the test proves the page asks the
 * gate with the context's slug and role and the server variable.
 */
import * as React from 'react';
import { render, screen, cleanup } from '@testing-library/react';

const mockCtx: { current: { orgSlug: string; orgRole: string } } = {
    current: { orgSlug: 'acme', orgRole: 'ORG_ADMIN' },
};

jest.mock('@/app-layer/context', () => ({
    getOrgCtx: jest.fn(async () => ({
        requestId: 'r',
        userId: 'u',
        organizationId: 'o',
        permissions: {},
        ...mockCtx.current,
    })),
}));
jest.mock('@/app-layer/usecases/org-agent-switches', () => ({
    getOrgAgentSwitches: jest.fn(async () => ({})),
}));
// The per-turn ceilings the same section shows (#4594).
jest.mock('@/app-layer/usecases/org-agent-turn-caps', () => ({
    getOrgAgentTurnCaps: jest.fn(async () => ({})),
}));
jest.mock('next-intl/server', () => ({
    getTranslations: async () => (key: string) => key,
}));
jest.mock('@/app/org/[orgSlug]/(app)/settings/OrgAgentSwitchesSection', () => ({
    OrgAgentSwitchesSection: () => <div data-testid="org-agent-switches" />,
}));
jest.mock('@/app/org/[orgSlug]/(app)/settings/OrgSettingsIntro', () => ({
    OrgSettingsIntro: () => null,
}));
jest.mock('@/app/org/[orgSlug]/(app)/settings/OrgEvaluationsCard', () => ({
    OrgEvaluationsCard: () => <div data-testid="org-evaluations" />,
}));

import OrgSettingsPage from '@/app/org/[orgSlug]/(app)/settings/page';

async function renderPage() {
    const ui = await OrgSettingsPage({ params: Promise.resolve({ orgSlug: mockCtx.current.orgSlug }) });
    render(ui);
}

const ORIGINAL = process.env.EVALS_CARD_HIDDEN_ORG_SLUGS;
afterEach(() => {
    cleanup();
    if (ORIGINAL === undefined) delete process.env.EVALS_CARD_HIDDEN_ORG_SLUGS;
    else process.env.EVALS_CARD_HIDDEN_ORG_SLUGS = ORIGINAL;
});

describe('org settings page — Evaluations card gate', () => {
    it('shows the card to an org admin when nothing is opted out', async () => {
        delete process.env.EVALS_CARD_HIDDEN_ORG_SLUGS;
        mockCtx.current = { orgSlug: 'acme', orgRole: 'ORG_ADMIN' };
        await renderPage();
        expect(screen.getByTestId('org-agent-switches')).toBeInTheDocument();
        expect(screen.getByTestId('org-evaluations')).toBeInTheDocument();
    });

    it('shows the card to the org owner of an organization another one opted out', async () => {
        process.env.EVALS_CARD_HIDDEN_ORG_SLUGS = 'other';
        mockCtx.current = { orgSlug: 'acme', orgRole: 'ORG_OWNER' };
        await renderPage();
        expect(screen.getByTestId('org-evaluations')).toBeInTheDocument();
    });

    it('hides the card in an organization that opted out', async () => {
        process.env.EVALS_CARD_HIDDEN_ORG_SLUGS = 'other, acme';
        mockCtx.current = { orgSlug: 'acme', orgRole: 'ORG_OWNER' };
        await renderPage();
        expect(screen.getByTestId('org-agent-switches')).toBeInTheDocument();
        expect(screen.queryByTestId('org-evaluations')).toBeNull();
    });

    it('hides the card from a reader, opted out or not', async () => {
        delete process.env.EVALS_CARD_HIDDEN_ORG_SLUGS;
        mockCtx.current = { orgSlug: 'acme', orgRole: 'ORG_READER' };
        await renderPage();
        expect(screen.getByTestId('org-agent-switches')).toBeInTheDocument();
        expect(screen.queryByTestId('org-evaluations')).toBeNull();
    });
});
