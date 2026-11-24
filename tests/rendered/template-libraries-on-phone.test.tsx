/** @jest-environment jsdom */

/**
 * Both template libraries on a phone: a page of cards at a time, each with a
 * real checkbox that takes a 44px tap, a title that wraps and a code that
 * never breaks, and an install bar pinned to the bottom of the screen that
 * carries the selection count from the first card to the last.
 *
 * Before, each library put every template (262 and 233 of them) on one page,
 * with 13px native checkboxes (or none visible) and the install action at one
 * end of an 18,000–222,000px page.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/controls/templates',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme', frameworkKey: 'ISO27001' }),
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
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => ({
        permissions: { canWrite: true, canAdmin: true, canRead: true },
        appPermissions: { controls: { create: true } },
        role: 'ADMIN',
        tenantSlug: 'acme',
    }),
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
    usePermissions: () => ({ frameworks: { view: true, install: true } }),
}));
let belowMd = true;
jest.mock('@/components/ui/hooks', () => ({
    ...jest.requireActual('@/components/ui/hooks'),
    useIsBelowMd: () => belowMd,
}));

const CONTROL_TEMPLATES = Array.from({ length: 45 }, (_, i) => ({
    id: `tpl_${i + 1}`,
    code: `A.5.${i + 1}`,
    title: `A long control template title that will not fit on one line of a phone, number ${i + 1}`,
    category: 'Organizational',
    description: null,
    _count: { tasks: 1, requirementLinks: 2 },
}));
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string | null) =>
        key === '/controls/templates'
            ? { data: CONTROL_TEMPLATES, isLoading: false, error: undefined, mutate: jest.fn() }
            : { data: undefined, isLoading: false, error: undefined, mutate: jest.fn() },
}));

import ControlTemplatesPage from '@/app/t/[tenantSlug]/(app)/controls/templates/page';
import TemplateLibraryPage from '@/app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/templates/page';
import { TEMPLATE_PHONE_PAGE_SIZE } from '@/components/controls-shared/template-library-phone';

const EN = jest.requireActual('../../messages/en.json') as {
    controls: { templates: Record<string, string> & { phone: Record<string, string> } };
    frameworks: { templates: Record<string, string> & { phone: Record<string, string> } };
};
const CT = EN.controls.templates;
const FT = EN.frameworks.templates;
const fill = (s: string, p: Record<string, string | number>) =>
    Object.entries(p).reduce((acc, [k, v]) => acc.split(`{${k}}`).join(String(v)), s);

const fetchMock = jest.fn();
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

beforeEach(() => {
    belowMd = true;
    fetchMock.mockReset();
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    Element.prototype.scrollIntoView = jest.fn();
});

/** The dock: pinned to the bottom, phone-only. */
function expectDock(): HTMLElement {
    const dock = screen.getByTestId('template-install-dock');
    for (const c of ['sticky', 'bottom-0', 'md:hidden']) expect(dock.className).toContain(c);
    return dock;
}

describe('control template library on a phone', () => {
    const mount = () => render(<SWRConfig value={{ provider: () => new Map() }}><ControlTemplatesPage /></SWRConfig>);

    it('puts the search first, one page of cards, and more on request', () => {
        mount();
        const cards = () => screen.getAllByTestId('template-phone-card');
        expect(cards()).toHaveLength(TEMPLATE_PHONE_PAGE_SIZE);
        const search = document.getElementById('templates-search') as HTMLElement;
        expect(search.compareDocumentPosition(cards()[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // The desktop install card is not shown on a phone; the table is not rendered.
        expect(document.getElementById('install-selected-btn')?.closest('.max-md\\:hidden')).not.toBeNull();
        expect(screen.queryByTestId('templates-table')).toBeNull();
        const more = screen.getByRole('button', { name: fill(CT.phone.showMore, { remaining: 25 }) });
        expect(more.className).toContain('min-h-11');
        fireEvent.click(more);
        expect(cards()).toHaveLength(2 * TEMPLATE_PHONE_PAGE_SIZE);
        fireEvent.click(screen.getByRole('button', { name: fill(CT.phone.showMore, { remaining: 5 }) }));
        expect(cards()).toHaveLength(45);
        expect(screen.queryByRole('button', { name: /Show more/ })).toBeNull();
        // A new search starts at one page again.
        fireEvent.change(document.getElementById('templates-search') as HTMLInputElement, { target: { value: 'A.5.' } });
        expect(cards()).toHaveLength(TEMPLATE_PHONE_PAGE_SIZE);
    });

    it('each card has a real checkbox with a 44px tap, a wrapping title and an unbroken code', () => {
        mount();
        const card = screen.getAllByTestId('template-phone-card')[0];
        const box = within(card).getByRole('checkbox', { name: fill(CT.selectRow, { name: `A.5.1 ${CONTROL_TEMPLATES[0].title}` }) });
        expect(box.className).toContain('pointer-coarse:after:min-h-11');
        expect(box.className).toContain('h-6');
        expect(within(card).getByText('A.5.1').className).toContain('whitespace-nowrap');
        const title = within(card).getByText(CONTROL_TEMPLATES[0].title);
        expect(title.className).toContain('break-words');
        expect(title.className).not.toContain('truncate');
        // The card's text is the checkbox's label: tapping it selects.
        fireEvent.click(title);
        expect(box).toHaveAttribute('data-state', 'checked');
    });

    it('keeps the selection count in the pinned bar, and installs what was selected', async () => {
        fetchMock.mockResolvedValue(ok([{ skipped: false }, { skipped: false }]));
        mount();
        const dock = expectDock();
        const install = within(dock).getByRole('button', { name: fill(CT.installSelected, { count: 0 }) });
        expect(install).toBeDisabled();
        expect(install.className).toContain('min-h-11');

        const boxes = screen.getAllByTestId('template-select');
        fireEvent.click(boxes[0]);
        fireEvent.click(boxes[2]);
        expect(within(dock).getByRole('button', { name: fill(CT.installSelected, { count: 2 }) })).toBeEnabled();

        await act(async () => {
            fireEvent.click(within(dock).getByRole('button', { name: fill(CT.installSelected, { count: 2 }) }));
        });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/t/acme/controls/templates/install');
        expect(JSON.parse((init as RequestInit).body as string)).toEqual({ templateIds: ['tpl_1', 'tpl_3'] });
        await waitFor(() => expect(document.getElementById('install-success')).toBeInTheDocument());
        // The outcome is brought into view: Install was tapped at the bottom.
        expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    });

    it('a larger screen keeps the table and no pinned bar', () => {
        belowMd = false;
        mount();
        expect(screen.queryAllByTestId('template-phone-card')).toHaveLength(0);
        expect(screen.getByTestId('templates-table')).toBeInTheDocument();
    });
});

describe('framework template library on a phone', () => {
    const tmpl = (n: number, installed = false) => ({
        id: `t${n}`, code: `A-5.${n}`, title: `Framework template with a title long enough to wrap, ${n}`,
        description: null, category: 'ORGANIZATIONAL', defaultFrequency: 'QUARTERLY', isGlobal: true, installed,
        packs: [], tasks: [], requirements: [{ code: `5.${n}`, title: 'R', section: 'A.5', framework: { key: 'ISO27001', name: 'ISO 27001' } }],
    });
    const LIBRARY = [tmpl(0, true), ...Array.from({ length: 29 }, (_, i) => tmpl(i + 1))];

    beforeEach(() => {
        fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === 'POST') return ok({});
            return String(url).includes('action=templates')
                ? ok(LIBRARY)
                : ok({ id: 'fw', key: 'ISO27001', name: 'ISO 27001', version: '2022' });
        });
    });

    it('shows one page of cards, real checkboxes, wrapping titles, and more on request', async () => {
        render(<TemplateLibraryPage />);
        await screen.findByText(LIBRARY[0].title);
        expect(document.querySelectorAll('#template-list > [id^="template-A-"]')).toHaveLength(TEMPLATE_PHONE_PAGE_SIZE);
        const title = screen.getAllByTestId('template-title')[1];
        expect(title.className).toContain('md:truncate');
        expect(title.className).toContain('max-md:basis-full');
        expect(screen.getByText('A-5.1').className).toContain('whitespace-nowrap');
        // An installed template has no box; every other card has a real one.
        expect(screen.getAllByTestId('template-select')).toHaveLength(TEMPLATE_PHONE_PAGE_SIZE - 1);
        expect(document.querySelectorAll('#template-list input[type="checkbox"]')).toHaveLength(0);
        fireEvent.click(screen.getByRole('button', { name: fill(FT.phone.showMore, { remaining: 10 }) }));
        expect(document.querySelectorAll('#template-list > [id^="template-A-"]')).toHaveLength(30);
    });

    it('carries the count in the pinned bar and installs the selection in one request', async () => {
        render(<TemplateLibraryPage />);
        await screen.findByText(LIBRARY[0].title);
        const dock = expectDock();
        expect(within(dock).getByRole('button', { name: fill(FT.installNSelected, { count: 0 }) })).toBeDisabled();
        const boxes = screen.getAllByTestId('template-select');
        fireEvent.click(boxes[0]);
        fireEvent.click(boxes[1]);
        const install = within(dock).getByRole('button', { name: fill(FT.installNSelected, { count: 2 }) });
        // The header's bulk button is the larger screen's.
        expect(document.getElementById('bulk-install-btn')?.className).toContain('max-md:hidden');
        await act(async () => { fireEvent.click(install); });
        const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
        expect(post?.[0]).toBe('/api/t/acme/frameworks/ISO27001?action=bulk-install');
        expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({ templateCodes: ['A-5.1', 'A-5.2'] });
    });
});
