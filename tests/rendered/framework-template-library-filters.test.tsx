/** @jest-environment jsdom */

/**
 * The template library filters on the page, can search by name, and says
 * when it could not load (#4735).
 *
 *   - The library is read once; the category options do not shrink to the
 *     chosen category or to the chosen section.
 *   - Typing filters by code or title as you type.
 *   - A template's frequency is worded, not printed as stored.
 *   - A failed read offers a retry rather than "No templates match".
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/frameworks/ISO27001/templates',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme', frameworkKey: 'ISO27001' }),
}));

// A stable translator per namespace, as next-intl gives, so effects settle.
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
    usePermissions: () => ({ frameworks: { view: true, install: false } }),
}));

import TemplateLibraryPage from '@/app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/templates/page';

const EN = jest.requireActual('../../messages/en.json') as {
    frameworks: { templates: Record<string, string> & { frequency: Record<string, string> } };
};
const T = EN.frameworks.templates;

const tmpl = (code: string, title: string, category: string, section: string) => ({
    id: code, code, title, description: null, category, defaultFrequency: 'QUARTERLY',
    isGlobal: true, installed: false, packs: [], tasks: [],
    requirements: [{ code: `R-${code}`, title, section, framework: { key: 'ISO27001', name: 'ISO 27001' } }],
});
const TEMPLATES = [
    tmpl('A-5.1', 'Policies', 'ORGANIZATIONAL', 'A.5'),
    tmpl('A-8.1', 'Endpoint devices', 'TECHNOLOGICAL', 'A.8'),
];

const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
let templatesReply: () => ReturnType<typeof reply>;

beforeEach(() => {
    templatesReply = () => reply(200, TEMPLATES);
    global.fetch = jest.fn(async (url: string) =>
        String(url).includes('action=templates')
            ? templatesReply()
            : reply(200, { id: 'fw1', key: 'ISO27001', name: 'ISO 27001', version: '2022' }),
    ) as unknown as typeof fetch;
});

async function openCategoryPicker() {
    const trigger = document.querySelector('#filter-category') as HTMLElement;
    await act(async () => { fireEvent.click(trigger); });
}

describe('template library filters', () => {
    it('reads the whole library once, and filters on the page', async () => {
        render(<TemplateLibraryPage />);
        await screen.findByText('Policies');
        const urls = (global.fetch as jest.Mock).mock.calls.map(([u]) => String(u)).filter((u) => u.includes('action=templates'));
        expect(urls).toEqual(['/api/t/acme/frameworks/ISO27001?action=templates']);
    });

    it('keeps every category on offer after one is chosen', async () => {
        render(<TemplateLibraryPage />);
        await screen.findByText('Policies');
        await openCategoryPicker();
        const organizational = await screen.findByRole('option', { name: 'ORGANIZATIONAL' });
        await act(async () => { fireEvent.click(organizational); });
        await waitFor(() => expect(screen.queryByText('Endpoint devices')).toBeNull());
        expect(screen.getByText('Policies')).toBeInTheDocument();

        await openCategoryPicker();
        // The other category is still a choice, one step away.
        const technological = await screen.findByRole('option', { name: 'TECHNOLOGICAL' });
        await act(async () => { fireEvent.click(technological); });
        await waitFor(() => expect(screen.getByText('Endpoint devices')).toBeInTheDocument());
        expect(screen.queryByText('Policies')).toBeNull();
    });

    it('searches by code or title as you type', async () => {
        render(<TemplateLibraryPage />);
        await screen.findByText('Policies');
        fireEvent.change(document.getElementById('template-search')!, { target: { value: 'endpoint' } });
        expect(screen.queryByText('Policies')).toBeNull();
        expect(screen.getByText('Endpoint devices')).toBeInTheDocument();

        fireEvent.change(document.getElementById('template-search')!, { target: { value: 'a-5' } });
        expect(screen.getByText('Policies')).toBeInTheDocument();
        expect(screen.queryByText('Endpoint devices')).toBeNull();
    });

    it("words a template's frequency", async () => {
        render(<TemplateLibraryPage />);
        await screen.findByText('Policies');
        expect(screen.getAllByText(T.frequency.QUARTERLY).length).toBe(2);
        expect(screen.queryByText('QUARTERLY')).toBeNull();
    });

    it('says the library could not load, with a retry, instead of "no match"', async () => {
        let calls = 0;
        templatesReply = () => (calls++ === 0 ? reply(500, {}) : reply(200, TEMPLATES));
        render(<TemplateLibraryPage />);
        expect(await screen.findByText(T.loadFailed)).toBeInTheDocument();
        expect(screen.queryByText(T.emptyFilter)).toBeNull();
        await act(async () => { fireEvent.click(document.getElementById('template-load-retry')!); });
        expect(await screen.findByText('Policies')).toBeInTheDocument();
    });
});
