/**
 * The policy's SharePoint section says a refused action as a failure (#5313).
 * A refused push, pull or unlink used to appear in the green success notice.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en[ns]);
    const cache = new Map<string, unknown>();
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) cache.set(ns, (key: string) => {
                const v = resolve(ns, key);
                return typeof v === 'string' ? v : key;
            });
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});
// A STABLE url builder: the section keys its load effect on it.
const mockApiUrl = (p: string) => `/api/t/acme${p}`;
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => mockApiUrl,
}));
jest.mock('@/components/integrations/sharepoint/SharePointFilePicker', () => ({ SharePointFilePicker: () => null }));

import { PolicySharePointSection } from '@/app/t/[tenantSlug]/(app)/policies/[policyId]/PolicySharePointSection';

const SP = (jest.requireActual('../../messages/en.json') as { policies: { sharepoint: Record<string, string> } }).policies.sharepoint;

let pushStatus = 200;
beforeEach(() => {
    pushStatus = 200;
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
        if (u.endsWith('/integrations/sharepoint/connections')) return reply(200, [{ id: 'conn-1' }]);
        if (u.endsWith('/sharepoint/push') && init?.method === 'POST') return reply(pushStatus, pushStatus < 400 ? {} : { error: { code: 'FORBIDDEN', message: 'no' } });
        if (u.endsWith('/policies/p1/sharepoint')) return reply(200, { linked: true, webUrl: null, conflict: false });
        return reply(200, {});
    }) as unknown as typeof fetch;
});

async function push() {
    render(<PolicySharePointSection policyId="p1" />);
    const btn = await screen.findByRole('button', { name: SP.push });
    await act(async () => { fireEvent.click(btn); });
    return waitFor(() => {
        const el = document.getElementById('policy-sharepoint-notice');
        expect(el).not.toBeNull();
        return el as HTMLElement;
    });
}

it('a refused push reads as a failure, not a success', async () => {
    pushStatus = 403;
    const notice = await push();
    expect(notice).toHaveTextContent(SP.actionFailed);
    expect(notice.className).toMatch(/error/);
    expect(notice.className).not.toMatch(/success/);
});

it('a push that worked reads as a success', async () => {
    const notice = await push();
    expect(notice).toHaveTextContent(SP.pushed);
    expect(notice.className).toMatch(/success/);
});
