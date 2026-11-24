/**
 * THE INCIDENT AUTHORITY CARD SETS WHAT EVERY INCIDENT NAMES, AND IS WHERE THE
 * INCIDENT PAGE'S LINK LANDS.
 *
 *   1. It reads the stored authority and says what incidents show.
 *   2. Saving PUTs the typed value, trimmed, to the security settings route;
 *      an emptied field PUTs an explicit null ("none named").
 *   3. It carries the anchor the incident page links to from the first paint,
 *      and scrolls itself into view once loaded when the URL names it.
 *   4. A refused read says it cannot answer, and offers no field.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.setTimeout(60_000);

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    const resolve = (path: string): unknown =>
        path.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const make = (ns: string) => (key: string, params?: Record<string, unknown>) => {
        let v = resolve(`${ns}.${key}`);
        if (typeof v !== 'string') return key;
        if (params)
            for (const [p, val] of Object.entries(params))
                v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
        return v as string;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

// Stable, as the real hook is: the load effect depends on it.
jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    return { useTenantApiUrl: () => apiUrl };
});

import { IncidentAuthorityCard } from '@/app/t/[tenantSlug]/(app)/admin/security/IncidentAuthorityCard';

const EN = (
    require('../../messages/en.json') as {
        admin: { security: { incidentAuthority: Record<string, string> } };
    }
).admin.security.incidentAuthority;

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];

/** GET answers `stored`; a PUT answers what the route stores (trimmed, empty → null). */
function stubSettings(stored: string | null, readOk = true): void {
    calls = [];
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method, body });
        if (method === 'GET') {
            return { ok: readOk, json: async () => (readOk ? { incidentAuthority: stored } : { error: 'Forbidden' }) };
        }
        const sent = (body as { incidentAuthority: string | null }).incidentAuthority;
        return { ok: true, json: async () => ({ incidentAuthority: sent?.trim() || null }) };
    }) as unknown as typeof fetch;
}

async function mount(stored: string | null): Promise<HTMLElement> {
    stubSettings(stored);
    render(<IncidentAuthorityCard />);
    await screen.findByTestId('incident-authority-state');
    return screen.getByTestId('incident-authority-card');
}

const puts = () => calls.filter((c) => c.method === 'PUT');
const input = (card: HTMLElement) => within(card).getByLabelText(EN.label) as HTMLInputElement;
const saveButton = (card: HTMLElement) => within(card).getByRole('button', { name: EN.save }) as HTMLButtonElement;

const scrollIntoView = jest.fn();
beforeAll(() => {
    Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
    scrollIntoView.mockClear();
    window.history.replaceState(null, '', '/');
});

describe('reading the setting', () => {
    it('shows a named authority in the state line and the field', async () => {
        const card = await mount('BSI (Germany)');
        expect(within(card).getByTestId('incident-authority-state').textContent).toBe(
            EN.stateSet.replace('{authority}', 'BSI (Germany)'),
        );
        expect(input(card).value).toBe('BSI (Germany)');
        // Nothing changed, so nothing to save.
        expect(saveButton(card).disabled).toBe(true);
    });

    it('says when none is named, with an empty field', async () => {
        const card = await mount(null);
        expect(within(card).getByTestId('incident-authority-state').textContent).toBe(EN.stateNone);
        expect(input(card).value).toBe('');
    });

    it('bounds the field to the length the server accepts', async () => {
        const card = await mount(null);
        expect(input(card).maxLength).toBe(200);
    });
});

describe('saving', () => {
    it('PUTs the typed authority, trimmed, to the security settings route', async () => {
        const user = userEvent.setup();
        const card = await mount(null);
        await user.type(input(card), '  CCB (Belgium)  ');
        await user.click(saveButton(card));

        await screen.findByText(EN.saved);
        expect(puts()).toEqual([
            { url: '/api/t/acme/admin/security-settings', method: 'PUT', body: { incidentAuthority: 'CCB (Belgium)' } },
        ]);
        expect(within(card).getByTestId('incident-authority-state').textContent).toBe(
            EN.stateSet.replace('{authority}', 'CCB (Belgium)'),
        );
    });

    it('an emptied field PUTs an explicit null, and says it was cleared', async () => {
        const user = userEvent.setup();
        const card = await mount('BSI (Germany)');
        await user.clear(input(card));
        await user.click(saveButton(card));

        await screen.findByText(EN.cleared);
        expect(puts().map((c) => c.body)).toEqual([{ incidentAuthority: null }]);
        expect(within(card).getByTestId('incident-authority-state').textContent).toBe(EN.stateNone);
    });

    it("shows the server's refusal sentence", async () => {
        const user = userEvent.setup();
        const card = await mount(null);
        (globalThis.fetch as unknown as jest.Mock).mockImplementationOnce(async () => ({
            ok: false,
            json: async () => ({ error: { code: 'BAD_REQUEST', message: 'incidentAuthority must be at most 200 characters' } }),
        }));
        await user.type(input(card), 'x');
        await user.click(saveButton(card));
        await within(card).findByText('incidentAuthority must be at most 200 characters');
    });
});

describe('the anchor the incident page links to', () => {
    it('is on the card from the first paint, before the setting loads', () => {
        stubSettings(null);
        render(<IncidentAuthorityCard />);
        expect(screen.getByTestId('incident-authority-card').id).toBe('incident-authority');
    });

    it('scrolls the card into view once loaded when the URL names it', async () => {
        window.history.replaceState(null, '', '/t/acme/admin/security#incident-authority');
        const card = await mount('BSI (Germany)');
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(scrollIntoView.mock.contexts[0]).toBe(card);
    });

    it('does not scroll when the URL names no anchor', async () => {
        await mount('BSI (Germany)');
        expect(scrollIntoView).not.toHaveBeenCalled();
    });
});

describe('a refused read', () => {
    it('says it cannot answer and offers no field', async () => {
        stubSettings(null, false);
        render(<IncidentAuthorityCard />);
        const card = screen.getByTestId('incident-authority-card');
        await within(card).findByText(EN.unavailable);
        expect(within(card).queryByLabelText(EN.label)).toBeNull();
    });
});
