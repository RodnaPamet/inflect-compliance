/** @jest-environment jsdom */

/**
 * The key risk indicators page (#4769).
 *
 *   1. A lower-is-worse indicator's thresholds are labelled "Green ≥ /
 *      Amber ≥" and stored in the columns `computeRag` reads for them, so
 *      "Green 95, Amber 90" means what it says.
 *   2. A rejected reading stays in its box, with the reason beside it.
 *   3. Edit, deactivate and delete need `risks.edit`, as their routes do.
 *   4. The card words its values and names its risk and owner.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

let appPermissions: Record<string, unknown> = { risks: { edit: true } };
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({
        tenantName: 'Acme', tenantSlug: 'acme',
        permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true },
        appPermissions,
    }),
    useMoneyFormatter: () => (v: number | null | undefined) => String(v ?? ''),
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
    usePathname: () => '/t/acme/risks/kri',
    useSearchParams: () => new URLSearchParams(),
}));
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));
jest.mock('../../src/app/t/[tenantSlug]/(app)/risks/_shared/RiskPicker', () => ({ RiskPicker: () => null }));
jest.mock('@/components/ui/user-combobox', () => ({ UserCombobox: () => null }));
import KriPage from '@/app/t/[tenantSlug]/(app)/risks/kri/page';
import { TooltipProvider } from '@/components/ui/tooltip';

const EN = jest.requireActual('../../messages/en.json') as {
    risks: { kri: Record<string, string> & { rag: Record<string, string> } };
};
const K = EN.risks.kri;

const KRI = {
    id: 'k1', name: 'Patch coverage', description: null, unit: '%', direction: 'LOWER_IS_WORSE',
    greenMax: 90, amberMax: 95, frequency: 'MONTHLY', targetValue: 98, ownerUserId: 'u2', isActive: true,
    riskId: 'r1', risk: { id: 'r1', title: 'Unpatched servers' }, owner: { id: 'u2', name: 'Dana', email: 'dana@example.com' },
    latestReading: { value: 92, ragStatus: 'AMBER' }, sparkline: [90, 91, 92],
};

let writes: Array<{ method: string; url: string; body: unknown }> = [];
let readingStatus = 200;

beforeEach(() => {
    appPermissions = { risks: { edit: true } };
    writes = [];
    readingStatus = 200;
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const reply = (status: number, body: unknown) => ({
            ok: status < 400, status, headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => body, text: async () => JSON.stringify(body),
        });
        if (method === 'GET') return reply(200, { kris: [KRI] });
        writes.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (String(url).includes('/readings')) {
            return readingStatus === 200
                ? reply(200, { success: true })
                : reply(readingStatus, { error: { code: 'BAD_REQUEST', message: 'Reading outside the allowed range' } });
        }
        return reply(200, {});
    }) as unknown as typeof fetch;
});

const mount = () =>
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider><KriPage /></TooltipProvider>
        </SWRConfig>,
    );

describe('Key risk indicators page', () => {
    it('labels and stores a lower-is-worse indicator by what each figure means', async () => {
        mount();
        await screen.findByText('Patch coverage');

        // Choose "Lower is worse" for the new indicator.
        fireEvent.click(document.getElementById('kri-direction')!);
        fireEvent.click(await screen.findByRole('option', { name: K.dirLowerWorse }));

        const form = document.getElementById('kri-name')!.closest('.space-y-default') as HTMLElement;
        expect(within(form).getByText(K.greenMin)).toBeInTheDocument();
        expect(within(form).getByText(K.amberMin)).toBeInTheDocument();

        fireEvent.change(document.getElementById('kri-name')!, { target: { value: 'MFA coverage' } });
        fireEvent.change(document.getElementById('kri-green')!, { target: { value: '95' } });
        fireEvent.change(document.getElementById('kri-amber')!, { target: { value: '90' } });
        await act(async () => { fireEvent.click(document.getElementById('kri-create-btn')!); });

        // GREEN while ≥ amberMax and AMBER while ≥ greenMax, as computeRag reads them.
        await waitFor(() => expect(writes.find((w) => w.method === 'POST')).toBeDefined());
        const body = writes.find((w) => w.method === 'POST')!.body as Record<string, unknown>;
        expect(body).toMatchObject({ direction: 'LOWER_IS_WORSE', amberMax: 95, greenMax: 90 });
    });

    it('describes the card in words, with its risk and owner', async () => {
        mount();
        await screen.findByText('Patch coverage');
        expect(screen.getByTestId('kri-rag-k1')).toHaveTextContent(`${K.rag.AMBER} · 92%`);
        const meta = screen.getByTestId('kri-meta-k1');
        expect(meta).toHaveTextContent(K.dirLowerWorse);
        expect(meta).toHaveTextContent(K.freqMonthly);
        expect(meta).toHaveTextContent(K.thresholdsLower.replace('{green}', '95').replace('{amber}', '90'));
        expect(screen.getByRole('link', { name: 'Unpatched servers' })).toHaveAttribute('href', '/t/acme/risks/r1');
        expect(screen.getByTestId('kri-links-k1')).toHaveTextContent('Dana');
    });

    it('keeps a rejected reading in its box and says why', async () => {
        readingStatus = 400;
        mount();
        await screen.findByText('Patch coverage');
        const input = screen.getByTestId('kri-reading-input-k1');
        fireEvent.change(input, { target: { value: '120' } });
        await act(async () => { fireEvent.click(screen.getByTestId('kri-reading-add-k1')); });

        expect(await screen.findByTestId('kri-reading-error-k1')).toHaveTextContent('Reading outside the allowed range');
        expect(input).toHaveValue('120');
    });

    it('says a reading must be a number instead of ignoring it', async () => {
        mount();
        await screen.findByText('Patch coverage');
        fireEvent.change(screen.getByTestId('kri-reading-input-k1'), { target: { value: 'abc' } });
        await act(async () => { fireEvent.click(screen.getByTestId('kri-reading-add-k1')); });
        expect(screen.getByTestId('kri-reading-error-k1')).toHaveTextContent(K.readingNotNumber);
        expect(writes).toHaveLength(0);
    });

    it('offers edit, deactivate and delete only with risks.edit', async () => {
        appPermissions = { risks: { edit: false } };
        mount();
        await screen.findByText('Patch coverage');
        expect(screen.queryByTestId('kri-edit-k1')).toBeNull();
        expect(screen.queryByTestId('kri-toggle-k1')).toBeNull();
        expect(screen.queryByTestId('kri-delete-k1')).toBeNull();
        // Recording a reading only needs the write tier.
        expect(screen.getByTestId('kri-reading-add-k1')).toBeInTheDocument();
    });
});
