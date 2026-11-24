/** @jest-environment jsdom */

/**
 * On a phone the correlation matrix gives way to a notice and a list of the
 * correlated pairs, strongest first, each linking to its two risks; the
 * uncorrelated pairs fold behind one control, so the list holds every pair
 * the grid does. A writer edits a pair from its row, and the editor opens
 * beside that row rather than below a list it may be screens away from.
 *
 * The switch is CSS (`md:hidden` on the list, `max-md:hidden` on the grid),
 * so this reads those classes.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
let belowMd = true;
jest.mock('@/components/ui/hooks', () => ({
    ...jest.requireActual('@/components/ui/hooks'),
    useIsBelowMd: () => belowMd,
}));

import CorrelationMatrixPage from '@/app/t/[tenantSlug]/(app)/risks/correlations/page';
import { TooltipProvider } from '@/components/ui/tooltip';

const EN = jest.requireActual('../../messages/en.json') as {
    risks: { correlations: Record<string, string> & { phone: Record<string, string> } };
};
const P = EN.risks.correlations.phone;

const MATRIX = {
    riskIds: ['r1', 'r2', 'r3'],
    riskTitles: ['Ransomware', 'Outage', 'Fraud'],
    matrix: [
        [1, 0.25, -0.7],
        [0.25, 1, 0],
        [-0.7, 0, 1],
    ],
    isPositiveSemiDefinite: true, isPositiveDefinite: true, minEigenvalue: 0.2,
};

beforeEach(() => {
    appPermissions = { risks: { edit: true } };
    belowMd = true;
    global.fetch = jest.fn(async () => ({
        ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ matrix: MATRIX }), text: async () => '',
    })) as unknown as typeof fetch;
});

const mount = () =>
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider><CorrelationMatrixPage /></TooltipProvider>
        </SWRConfig>,
    );

describe('the correlation matrix on a phone', () => {
    it('shows a notice and the list below md, and the grid only from md up', async () => {
        mount();
        const list = await screen.findByTestId('corr-phone-list');
        expect(list.className).toContain('md:hidden');
        expect(within(list).getByText(P.notice)).toBeInTheDocument();
        const grid = screen.getByRole('table').parentElement as HTMLElement;
        expect(grid.className).toContain('max-md:hidden');
    });

    it('lists the correlated pairs strongest first, each linking to its two risks', async () => {
        mount();
        const list = within(await screen.findByRole('list', { name: P.listAria }));
        const rows = list.getAllByRole('listitem');
        expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['corr-pair-0-2', 'corr-pair-0-1']);
        expect(rows[0]).toHaveTextContent('-0.70');
        const links = within(rows[0]).getAllByRole('link');
        expect(links.map((l) => l.getAttribute('href'))).toEqual(['/t/acme/risks/r1', '/t/acme/risks/r3']);
        expect(links.map((l) => l.textContent)).toEqual(['Ransomware', 'Fraud']);
        for (const link of links) expect(link.className).toContain('min-h-11');
    });

    it('holds every other pair behind one control, so the list has every pair the grid does', async () => {
        mount();
        const folded = await screen.findByTestId('corr-phone-uncorrelated');
        expect(folded.tagName).toBe('DETAILS');
        expect(within(folded).getByText(P.uncorrelated.replace('{count}', '1'))).toBeInTheDocument();
        expect(within(folded).getByTestId('corr-pair-1-2')).toHaveTextContent('0.00');
        const all = document.querySelectorAll('[data-testid^="corr-pair-"]');
        // n(n−1)/2 pairs above the diagonal.
        expect(all).toHaveLength(3);
    });

    it("opens the editor beside the tapped pair, with the pair's figure", async () => {
        mount();
        const row = await screen.findByTestId('corr-pair-0-2');
        const edit = within(row).getByRole('button', {
            name: P.editAria.replace('{a}', 'Ransomware').replace('{b}', 'Fraud').replace('{value}', '-0.70'),
        });
        expect(edit.className).toContain('min-h-11');
        await act(async () => { fireEvent.click(edit); });
        expect(within(row).getByRole('textbox')).toHaveValue('-0.7');
        expect(document.querySelectorAll('#corr-coefficient')).toHaveLength(1);
    });

    it('offers no edit to a reader', async () => {
        appPermissions = { risks: { edit: false } };
        mount();
        const row = await screen.findByTestId('corr-pair-0-2');
        expect(within(row).queryByRole('button')).toBeNull();
    });

    it('says so when no pair is correlated', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({ matrix: { ...MATRIX, matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] } }), text: async () => '',
        })) as unknown as typeof fetch;
        mount();
        expect(await screen.findByTestId('corr-phone-none')).toHaveTextContent(P.none);
    });
});
