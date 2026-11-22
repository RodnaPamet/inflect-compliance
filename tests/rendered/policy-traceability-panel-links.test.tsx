/** @jest-environment jsdom */
/**
 * The policy traceability panel offers every control and says why a link
 * was refused (#5226, #5227).
 *
 * It read `/controls?limit=100`, so a tenant with more than a hundred
 * controls could never link the rest, and a refused link did nothing at all.
 */
import * as React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';

const toastError = jest.fn();
jest.mock('@inflect/ui/components/ui/hooks/use-toast', () => ({
    ...jest.requireActual('@inflect/ui/components/ui/hooks/use-toast'),
    useToast: () => ({ error: toastError, success: jest.fn(), warning: jest.fn(), info: jest.fn() }),
}));

import PolicyTraceabilityPanel from '@/components/PolicyTraceabilityPanel';

const originalMatchMedia = window.matchMedia;
beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: (query: string) => ({
            matches: query.includes('1024'),
            media: query,
            onchange: null,
            addListener: jest.fn(),
            removeListener: jest.fn(),
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
            dispatchEvent: jest.fn(),
        }),
    });
});
afterAll(() => {
    Object.defineProperty(window, 'matchMedia', { writable: true, value: originalMatchMedia });
});

const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json }) as unknown as Response;
// 150 controls: more than the 100 the panel used to ask for.
const CONTROLS = Array.from({ length: 150 }, (_, i) => ({
    id: `c${i}`,
    code: `CTL-${String(i).padStart(3, '0')}`,
    name: `Control ${i}`,
    status: 'IMPLEMENTED',
}));
const fetchMock = jest.fn();

beforeEach(() => {
    toastError.mockReset();
    fetchMock.mockReset();
    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
            return Promise.resolve({
                ok: false,
                status: 403,
                json: async () => ({ error: { code: 'FORBIDDEN', message: 'You cannot edit controls.' } }),
            } as unknown as Response);
        }
        if (input.endsWith('/traceability')) return Promise.resolve(ok({ controls: [], risks: [], assets: [] }));
        if (input.startsWith('/api/t/acme/controls')) {
            return Promise.resolve(ok(input === '/api/t/acme/controls' ? { rows: CONTROLS, truncated: false } : { items: CONTROLS.slice(0, 100) }));
        }
        return Promise.resolve(ok({}));
    });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});

function mount() {
    return render(
        <TooltipProvider delayDuration={0}>
            <PolicyTraceabilityPanel
                endpoint="/api/t/acme/policies/p1/traceability"
                tenantHref={(p) => p}
                policyId="p1"
                apiUrl={(p) => `/api/t/acme${p}`}
                canWrite
            />
        </TooltipProvider>,
    );
}

it('offers controls past the first hundred (#5226)', async () => {
    const user = userEvent.setup();
    mount();
    const picker = await waitFor(() => {
        const el = document.getElementById('policy-link-control');
        expect(el).not.toBeNull();
        return el as HTMLElement;
    });
    await user.click(picker);
    // 150 options render through the virtualized list; End jumps to the
    // last, which a hundred-row read never held.
    await user.type(screen.getByPlaceholderText('Search controls…'), '{End}');
    expect(await screen.findByText('CTL-149 — Control 149')).toBeInTheDocument();
});

it('says why a link was refused (#5227)', async () => {
    const user = userEvent.setup();
    mount();
    const picker = await waitFor(() => {
        const el = document.getElementById('policy-link-control');
        expect(el).not.toBeNull();
        return el as HTMLElement;
    });
    await user.click(picker);
    await act(async () => {
        await user.click(await screen.findByText('CTL-000 — Control 0'));
    });
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('You cannot edit controls.'));
});
