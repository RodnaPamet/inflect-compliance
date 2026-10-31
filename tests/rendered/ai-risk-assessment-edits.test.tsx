/** @jest-environment jsdom */

/**
 * The AI-assisted risk assessment keeps a reviewer's corrections (#4776).
 *
 *   1. "Save & Accept" keeps the edit: the card shows it, and the apply
 *      request carries it. It used to be thrown away, so the risk was
 *      created with the model's original text.
 *   2. A suggestion that matched a risk already in the register is said to
 *      have been linked, not counted as added.
 *   3. A malformed stored control list does not take the page down.
 */
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { getPermissionsForRole } from '@/lib/permissions';

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({
        userId: 'u1', tenantId: 't1', tenantSlug: 'acme', tenantName: 'Acme', role: 'EDITOR',
        permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true },
        appPermissions: getPermissionsForRole('EDITOR'),
    }),
    usePermissions: () => getPermissionsForRole('EDITOR'),
}));

jest.mock('next-intl', () => {
    const shared = jest.requireActual('../../__mocks__/next-intl.js');
    const translators = new Map<string, unknown>();
    return {
        ...shared,
        useTranslations: (ns: string) => {
            if (!translators.has(ns)) translators.set(ns, shared.useTranslations(ns));
            return translators.get(ns);
        },
    };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/risks/ai',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));

import AIRiskAssessmentPage from '@/app/t/[tenantSlug]/(app)/risks/ai/page';

const EN = jest.requireActual('../../messages/en.json') as { risks: { ai: Record<string, string> } };
const AI = EN.risks.ai;

const SESSION = {
    session: { id: 'sess-1', status: 'GENERATED', provider: 'stub', modelName: null, createdAt: '2026-10-31T00:00:00.000Z' },
    items: [
        {
            id: 'item-1', title: 'Model title', description: 'Model text', category: 'Technical',
            threat: null, vulnerability: null, likelihoodSuggested: 2, impactSuggested: 2,
            rationale: null, suggestedControlsJson: '{not json', status: 'PENDING', assetId: null,
            createdRiskId: null, confidence: 'high', structuredRationaleJson: null, isFallback: false,
        },
    ],
};

let applyBody: Record<string, unknown> | null = null;
let applyReply: Record<string, unknown> = {};

beforeEach(() => {
    applyBody = null;
    applyReply = { id: 'sess-1', status: 'APPLIED', items: [], summary: { created: 1, linkedExisting: 0 } };
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
        const reply = (body: unknown) => ({
            ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => body, text: async () => JSON.stringify(body),
        });
        if (String(url).endsWith('/generate')) return reply(SESSION);
        if (String(url).endsWith('/apply')) {
            applyBody = JSON.parse(String(init?.body ?? '{}'));
            return reply(applyReply);
        }
        return reply({});
    }) as unknown as typeof fetch;
});

async function generate() {
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <AIRiskAssessmentPage />
        </SWRConfig>,
    );
    await act(async () => { fireEvent.click(document.getElementById('ai-generate-btn')!); });
    await screen.findByText('Model title');
}

describe('AI-assisted risk assessment — review', () => {
    it('keeps an edit made with Save & Accept, and sends it with the apply', async () => {
        await generate();

        await act(async () => { fireEvent.click(document.getElementById('edit-0')!); });
        fireEvent.change(document.getElementById('edit-title-0')!, { target: { value: 'Reviewed title' } });
        fireEvent.change(document.getElementById('edit-desc-0')!, { target: { value: 'Reviewed text' } });
        await act(async () => { fireEvent.click(document.getElementById('save-edit-0')!); });

        // The card now shows the reviewer's text, marked as edited.
        expect(screen.getByText('Reviewed title')).toBeInTheDocument();
        expect(screen.getByTestId('suggestion-edited-0')).toHaveTextContent(AI.edited);

        await act(async () => { fireEvent.click(document.getElementById('apply-btn')!); });
        await screen.findByText(/added to your register/);

        expect(applyBody).toEqual({
            acceptedItemIds: ['item-1'],
            edits: [{ itemId: 'item-1', title: 'Reviewed title', description: 'Reviewed text', likelihood: 2, impact: 2 }],
        });
    });

    it('says when an accepted suggestion was linked to a risk already in the register', async () => {
        applyReply = { id: 'sess-1', status: 'APPLIED', items: [], summary: { created: 0, linkedExisting: 1 } };
        await generate();

        await act(async () => { fireEvent.click(document.getElementById('accept-0')!); });
        await act(async () => { fireEvent.click(document.getElementById('apply-btn')!); });

        expect(await screen.findByText(/already in your register/)).toBeInTheDocument();
        expect(applyBody).toEqual({ acceptedItemIds: ['item-1'], edits: [] });
    });

    it('renders a suggestion whose stored control list is malformed', async () => {
        await generate();
        expect(document.getElementById('suggestion-0')).not.toBeNull();
    });
});
