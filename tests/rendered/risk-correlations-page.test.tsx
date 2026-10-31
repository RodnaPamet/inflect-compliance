/** @jest-environment jsdom */

/**
 * The risk correlation matrix (#4771).
 *
 *   1. An editable pair is a button: reachable and usable from the keyboard.
 *   2. Editing needs `risks.edit`, as the route does.
 *   3. A suggestion names its two risks; an empty result says so.
 *   4. A coefficient outside −1..1 is refused on the page, and a server
 *      refusal shows the server's reason.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

let appPermissions: Record<string, unknown> = { risks: { edit: true } };
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({
        tenantSlug: 'acme',
        permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true },
        appPermissions,
    }),
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
    usePathname: () => '/t/acme/risks/correlations',
    useSearchParams: () => new URLSearchParams(),
}));
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));

import CorrelationMatrixPage from '@/app/t/[tenantSlug]/(app)/risks/correlations/page';
import { TooltipProvider } from '@/components/ui/tooltip';

const EN = jest.requireActual('../../messages/en.json') as { risks: { correlations: Record<string, string> } };
const C = EN.risks.correlations;

const MATRIX = {
    riskIds: ['r1', 'r2'], riskTitles: ['Ransomware', 'Outage'],
    matrix: [[1, 0.25], [0.25, 1]], isPositiveSemiDefinite: true, isPositiveDefinite: true, minEigenvalue: 0.75,
};
let suggestions: unknown[] = [];
let putStatus = 200;
let puts: unknown[] = [];

beforeEach(() => {
    appPermissions = { risks: { edit: true } };
    suggestions = [];
    putStatus = 200;
    puts = [];
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const reply = (status: number, body: unknown) => ({
            ok: status < 400, status, headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => body, text: async () => JSON.stringify(body),
        });
        if (method === 'PUT') {
            puts.push(JSON.parse(String(init?.body ?? '{}')));
            return putStatus === 200 ? reply(200, {}) : reply(putStatus, { error: { code: 'BAD_REQUEST', message: 'A risk cannot be correlated with itself' } });
        }
        if (String(url).includes('/suggest')) return reply(200, { suggestions });
        return reply(200, { matrix: MATRIX });
    }) as unknown as typeof fetch;
});

const mount = () =>
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider><CorrelationMatrixPage /></TooltipProvider>
        </SWRConfig>,
    );

const pairLabel = C.editPairAria.replace('{a}', 'Ransomware').replace('{b}', 'Outage').replace('{value}', '0.25');

describe('Risk correlation matrix', () => {
    it('edits a pair through a real button, showing two decimals', async () => {
        mount();
        const cell = await screen.findByRole('button', { name: pairLabel });
        expect(cell).toHaveTextContent('0.25');
        cell.focus();
        expect(cell).toHaveFocus();
        await act(async () => { fireEvent.click(cell); });
        expect(document.getElementById('corr-coefficient')).toHaveValue('0.25');
    });

    it('offers no edit without risks.edit', async () => {
        appPermissions = { risks: { edit: false } };
        mount();
        expect((await screen.findAllByText('0.25', { selector: 'span' })).length).toBe(2);
        expect(screen.queryByRole('button', { name: pairLabel })).toBeNull();
    });

    it('refuses a coefficient outside −1..1 before sending it', async () => {
        mount();
        await act(async () => { fireEvent.click(await screen.findByRole('button', { name: pairLabel })); });
        fireEvent.change(document.getElementById('corr-coefficient')!, { target: { value: '1.5' } });
        await act(async () => { fireEvent.click(document.getElementById('corr-save')!); });
        expect(screen.getByTestId('corr-edit-error')).toHaveTextContent(C.coefficientRange);
        expect(puts).toHaveLength(0);
    });

    it("shows the server's reason when a save is refused", async () => {
        putStatus = 400;
        mount();
        await act(async () => { fireEvent.click(await screen.findByRole('button', { name: pairLabel })); });
        fireEvent.change(document.getElementById('corr-coefficient')!, { target: { value: '0.4' } });
        await act(async () => { fireEvent.click(document.getElementById('corr-save')!); });
        await waitFor(() => expect(screen.getByTestId('corr-edit-error')).toHaveTextContent('A risk cannot be correlated with itself'));
    });

    it('names the two risks of a suggestion', async () => {
        suggestions = [{ riskAId: 'r1', riskBId: 'r2', suggestedCoefficient: 0.4, reason: 'shared category' }];
        mount();
        await screen.findByRole('button', { name: pairLabel });
        await act(async () => { fireEvent.click(document.getElementById('correlations-suggest-btn')!); });
        expect(await screen.findByTestId('corr-suggestion-r1-r2')).toHaveTextContent('Ransomware ↔ Outage');
    });

    it('says when there are no suggestions', async () => {
        mount();
        await screen.findByRole('button', { name: pairLabel });
        await act(async () => { fireEvent.click(document.getElementById('correlations-suggest-btn')!); });
        expect(await screen.findByTestId('corr-no-suggestions')).toHaveTextContent(C.noSuggestions);
    });
});
