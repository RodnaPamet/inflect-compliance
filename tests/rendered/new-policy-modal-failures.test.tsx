/** @jest-environment jsdom */

/**
 * The create-policy dialog reports what the server said (#4127).
 *
 *   1. A refused create showed the error envelope as raw JSON
 *      (`JSON.stringify(data.error)`) instead of its message.
 *   2. Linking the suggested controls ignored the response and navigated to
 *      the new policy anyway, so a refused link looked like a success.
 *
 * And what it does not know yet (#4279):
 *
 *   3. The template picker said "No templates available." while the list was
 *      still loading, and again when the load failed.
 *   4. The category options and the create-failure fallback were hard-coded
 *      English.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Which catalogue the mocked next-intl reads. Hoisted, read lazily.
const mockLocale = { current: 'en' as 'en' | 'bg' };

jest.mock('next-intl', () => {
    const catalogs = {
        en: jest.requireActual('../../messages/en.json') as Record<string, Record<string, unknown>>,
        bg: jest.requireActual('../../messages/bg.json') as Record<string, Record<string, unknown>>,
    };
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            catalogs[mockLocale.current][ns],
        );
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            return v;
        };
        t.rich = (key: string) => {
            const v = resolve(ns, key);
            return typeof v === 'string' ? v : key;
        };
        t.has = (key: string) => typeof resolve(ns, key) === 'string';
        return t;
    };
    return {
        useTranslations: (ns: string) => {
            const key = `${mockLocale.current}:${ns}`;
            if (!cache.has(key)) cache.set(key, make(ns));
            return cache.get(key);
        },
        useLocale: () => mockLocale.current,
    };
});

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: mockPush, replace: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/policies',
    useSearchParams: () => new URLSearchParams(),
}));

const mockApiUrl = (path: string) => `/api/t/acme${path}`;
const mockHref = (path: string) => `/t/acme${path}`;
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => mockApiUrl,
    useTenantHref: () => mockHref,
    useTenantContext: () => ({ permissions: { canWrite: true, canAdmin: true }, tenantSlug: 'acme', userId: 'u1' }),
}));

// The lazily-loaded content editor is not under test.
jest.mock('next/dynamic', () => () => function DynamicStub() {
    return null;
});

import { NewPolicyModal } from '@/app/t/[tenantSlug]/(app)/policies/NewPolicyModal';
import { TooltipProvider } from '@/components/ui/tooltip';

type PolicyMessages = {
    createPolicy: string;
    templates: Record<string, string>;
    new: Record<string, string> & { categories: Record<string, string> };
};
const EN = (jest.requireActual('../../messages/en.json') as { policies: PolicyMessages }).policies;
const BG = (jest.requireActual('../../messages/bg.json') as { policies: PolicyMessages }).policies;

const fetchMock = jest.fn();
const json = (body: unknown, status = 200) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const SUGGESTIONS = {
    templateExternalRef: 'access-control',
    totalSuggested: 1,
    frameworks: [
        {
            frameworkKey: 'iso27001',
            frameworkLabel: 'ISO 27001',
            suggestions: [
                {
                    controlId: 'c1',
                    controlName: 'Access control',
                    controlCode: 'A.5.15',
                    requirements: [{ code: 'A.5.15', title: 'Access control', provenance: 'from_toolkit' }],
                    provenance: 'from_toolkit',
                    preChecked: true,
                },
            ],
        },
    ],
};

function renderModal(props: { isTemplateMode?: boolean } = {}) {
    render(
        <TooltipProvider>
            <NewPolicyModal open setOpen={jest.fn()} {...props} />
        </TooltipProvider>,
    );
}

async function submitTitle(title: string) {
    fireEvent.change(document.getElementById('policy-title-input')!, { target: { value: title } });
    fireEvent.click(screen.getByRole('button', { name: EN.createPolicy }));
}

beforeEach(() => {
    fetchMock.mockReset();
    mockPush.mockReset();
    mockLocale.current = 'en';
    global.fetch = fetchMock as unknown as typeof fetch;
});

it('a refused create shows the server\'s message, not raw JSON', async () => {
    fetchMock.mockResolvedValue(
        json({ error: { code: 'FORBIDDEN', message: 'Your plan allows 10 policies.', requestId: 'r1' } }, 403),
    );
    renderModal();
    await submitTitle('Access Control');
    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('Your plan allows 10 policies.');
    expect(error).not.toHaveTextContent('{');
});

it('a refused control link keeps the dialog open and says why; Skip still goes on', async () => {
    fetchMock.mockImplementation(async (url: string) => {
        if (url === '/api/t/acme/policies') {
            return json({ id: 'p1', title: 'Access Control', suggestedControlLinks: SUGGESTIONS }, 201);
        }
        if (url === '/api/t/acme/policies/p1/control-links') {
            return json({ error: { code: 'FORBIDDEN', message: 'You cannot change controls.' } }, 403);
        }
        return json([]);
    });
    renderModal();
    await submitTitle('Access Control');

    const confirm = await waitFor(() => {
        const el = document.getElementById('suggest-confirm');
        expect(el).not.toBeNull();
        return el as HTMLElement;
    });
    fireEvent.click(confirm);

    expect(await screen.findByText('You cannot change controls.')).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();

    fireEvent.click(document.getElementById('suggest-skip')!);
    expect(mockPush).toHaveBeenCalledWith('/t/acme/policies/p1');
});

describe('the template picker says what it knows', () => {
    it('says it is loading while the templates are on their way — not "No templates available."', async () => {
        fetchMock.mockReturnValue(new Promise(() => {})); // never settles
        renderModal({ isTemplateMode: true });
        expect(await screen.findByText(EN.new.templatesLoading)).toBeInTheDocument();
        expect(screen.queryByText(EN.new.templatesEmpty)).toBeNull();
    });

    it('a refused load shows the server\'s reason', async () => {
        fetchMock.mockResolvedValue(json({ error: { code: 'FORBIDDEN', message: 'Templates are not enabled.' } }, 403));
        renderModal({ isTemplateMode: true });
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Templates are not enabled.');
        expect(screen.queryByText(EN.new.templatesEmpty)).toBeNull();
    });

    it('a network failure says the load failed', async () => {
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
        renderModal({ isTemplateMode: true });
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent(EN.new.templatesLoadFailed);
        expect(screen.queryByText(EN.new.templatesEmpty)).toBeNull();
    });

    it('an empty library, and only that, reads "No templates available."', async () => {
        fetchMock.mockResolvedValue(json([]));
        renderModal({ isTemplateMode: true });
        expect(await screen.findByText(EN.new.templatesEmpty)).toBeInTheDocument();
        expect(screen.queryByText(EN.new.templatesLoading)).toBeNull();
    });
});

describe('the create path speaks the user\'s language', () => {
    it('the category options are translated, while the stored value stays the same', async () => {
        mockLocale.current = 'bg';
        fetchMock.mockResolvedValue(json({ id: 'p1', title: 'X' }, 201));
        renderModal();
        fireEvent.click(document.getElementById('policy-category-select')!);
        const listbox = await screen.findByRole('listbox');
        const labels = within(listbox).getAllByRole('option').map((o) => o.textContent?.trim());
        expect(labels).toEqual(Object.values(BG.new.categories));
        expect(labels).not.toContain('Information Security');

        // Picking the translated label still stores the canonical value.
        fireEvent.click(within(listbox).getByRole('option', { name: BG.new.categories.informationSecurity }));
        fireEvent.change(document.getElementById('policy-title-input')!, { target: { value: 'Политика' } });
        fireEvent.click(screen.getByRole('button', { name: BG.createPolicy }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/t/acme/policies', expect.anything()));
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.category).toBe('Information Security');
    });

    it('a refusal with no message falls back to a translated sentence', async () => {
        mockLocale.current = 'bg';
        fetchMock.mockResolvedValue(json({}, 500));
        renderModal();
        fireEvent.change(document.getElementById('policy-title-input')!, { target: { value: 'Политика' } });
        fireEvent.click(screen.getByRole('button', { name: BG.createPolicy }));
        const error = await screen.findByRole('alert');
        expect(error).toHaveTextContent(BG.new.createFailed);
        expect(error).not.toHaveTextContent('Failed to create policy');
    });
});
