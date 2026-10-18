/**
 * THE ROTATION-AGE CARD SAYS WHICH AGE IS IN FORCE, AND SENDS WHAT IT SHOWS (#3708).
 *
 * `apiKeyRotationDays` is nullable and NULL means "the product default". The
 * card offers that as a named choice rather than an empty box, so the claims
 * worth pinning are the ones a careless edit would quietly break:
 *
 *   1. A NULL setting reads as the default, with its value spelled out, and no
 *      stepper is offered for a number nobody chose.
 *   2. Choosing the workspace's own age and saving PUTs that number.
 *   3. Choosing the default and saving PUTs an explicit `null` — not 90, which
 *      the pass would record as the tenant's OWN policy.
 *   4. A refused read says it cannot answer; it does not render the default as
 *      if it knew.
 */
import * as React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.setTimeout(60_000);

// Resolved against the real en.json, so assertions read the operator's copy —
// next-intl renders a MISSING key as its own path, which would pass a path
// assertion only while the catalogue is incomplete.
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

// STABLE, as the real hook is (`useCallback` over the slug): the card's load
// effect depends on it, and a fresh function per render would refetch on every
// render and reset whatever the operator had just chosen.
jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    return { useTenantApiUrl: () => apiUrl };
});

import { ApiKeyRotationCard } from '@/app/t/[tenantSlug]/(app)/admin/security/ApiKeyRotationCard';

const EN = (
    require('../../messages/en.json') as {
        admin: { security: { apiKeyRotation: Record<string, string> } };
    }
).admin.security.apiKeyRotation;
const fill = (s: string, params: Record<string, number>) =>
    Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), s);

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];

/** GET answers `stored`; a PUT echoes what it was sent, as the route does. */
function stubSettings(stored: number | null, readOk = true): void {
    calls = [];
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method, body });
        if (method === 'GET') {
            return { ok: readOk, json: async () => (readOk ? { apiKeyRotationDays: stored } : { error: 'Forbidden' }) };
        }
        return { ok: true, json: async () => ({ apiKeyRotationDays: (body as { apiKeyRotationDays: number | null }).apiKeyRotationDays }) };
    }) as unknown as typeof fetch;
}

async function mount(stored: number | null): Promise<HTMLElement> {
    stubSettings(stored);
    render(<ApiKeyRotationCard />);
    await screen.findByTestId('api-key-rotation-state');
    return screen.getByTestId('api-key-rotation-card');
}

const puts = () => calls.filter((c) => c.method === 'PUT');

afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
});

describe('a NULL setting', () => {
    it('reads as the product default, with its value, and offers no stepper', async () => {
        const card = await mount(null);
        expect(within(card).getByTestId('api-key-rotation-state').textContent).toContain(
            fill(EN.stateDefault, { days: 90 }),
        );
        expect(within(card).getByText(fill(EN.useDefault, { days: 90 }))).toBeTruthy();
        expect(within(card).getByTestId('api-key-rotation-mode-default').getAttribute('aria-checked')).toBe('true');
        expect(card.querySelector('[data-testid="api-key-rotation-days"]')).toBeNull();
        // Nothing changed, so there is nothing to save.
        expect((within(card).getByTestId('api-key-rotation-save') as HTMLButtonElement).disabled).toBe(true);
    });

    it("choosing the workspace's own age and saving PUTs that number", async () => {
        const user = userEvent.setup();
        const card = await mount(null);
        await user.click(within(card).getByTestId('api-key-rotation-mode-custom'));

        const input = within(card).getByRole('spinbutton') as HTMLInputElement;
        // The stepper starts at the default, so switching alone is a real choice.
        expect(input.value).toBe('90');
        fireEvent.focus(input);
        fireEvent.change(input, { target: { value: '30' } });
        fireEvent.blur(input);
        await user.click(within(card).getByTestId('api-key-rotation-save'));

        await screen.findByText(EN.saved);
        expect(puts()).toEqual([
            { url: '/api/t/acme/admin/security-settings', method: 'PUT', body: { apiKeyRotationDays: 30 } },
        ]);
        expect(within(card).getByTestId('api-key-rotation-state').textContent).toContain(
            fill(EN.stateCustom, { days: 30 }),
        );
    });
});

describe('a tenant value', () => {
    it("reads as the workspace's own, with the stepper holding it", async () => {
        const card = await mount(45);
        expect(within(card).getByTestId('api-key-rotation-state').textContent).toContain(
            fill(EN.stateCustom, { days: 45 }),
        );
        expect((within(card).getByRole('spinbutton') as HTMLInputElement).value).toBe('45');
    });

    it('choosing the default and saving PUTs an explicit null — never 90', async () => {
        const user = userEvent.setup();
        const card = await mount(45);
        await user.click(within(card).getByTestId('api-key-rotation-mode-default'));
        await user.click(within(card).getByTestId('api-key-rotation-save'));

        await screen.findByText(EN.saved);
        expect(puts().map((c) => c.body)).toEqual([{ apiKeyRotationDays: null }]);
        expect(within(card).getByTestId('api-key-rotation-state').textContent).toContain(
            fill(EN.stateDefault, { days: 90 }),
        );
    });
});

describe('a refused read', () => {
    it('says it cannot answer rather than showing the default as if it knew', async () => {
        stubSettings(null, false);
        render(<ApiKeyRotationCard />);
        const card = await screen.findByTestId('api-key-rotation-card');
        await within(card).findByText(EN.unavailable);
        expect(card.querySelector('[data-testid="api-key-rotation-state"]')).toBeNull();
        expect(card.querySelector('[data-testid="api-key-rotation-save"]')).toBeNull();
    });
});
