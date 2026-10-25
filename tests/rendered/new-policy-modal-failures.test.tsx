/** @jest-environment jsdom */

/**
 * The create-policy dialog reports what the server said (#4127).
 *
 *   1. A refused create showed the error envelope as raw JSON
 *      (`JSON.stringify(data.error)`) instead of its message.
 *   2. Linking the suggested controls ignored the response and navigated to
 *      the new policy anyway, so a refused link looked like a success.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
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
            if (!cache.has(ns)) cache.set(ns, make(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
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

const EN = (jest.requireActual('../../messages/en.json') as {
    policies: { createPolicy: string; templates: Record<string, string> };
}).policies;

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

function renderModal() {
    render(
        <TooltipProvider>
            <NewPolicyModal open setOpen={jest.fn()} />
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
