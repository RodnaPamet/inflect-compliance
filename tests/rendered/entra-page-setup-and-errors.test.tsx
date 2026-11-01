/** @jest-environment jsdom */
/**
 * The Microsoft Entra ID page says what sign-in uses and what failed (#4869).
 *
 * Before: step 1 was hard-coded English telling every workspace to create an
 * app registration, though sign-in uses the deployment's own app; a failed
 * read looked like "not configured" and "No group mappings yet"; an add
 * refusal was guessed from its status; the breadcrumb had no links.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/admin/entra',
    useSearchParams: () => new URLSearchParams(),
}));

// next-intl: the global manual mock in __mocks__/ resolves keys against messages/en.json.
const permissions = { admin: { view: true, manage: true, owner_management: true } };
jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path}`;
    const href = (path: string) => `/t/acme${path}`;
    return {
        useTenantApiUrl: () => apiUrl,
        useTenantHref: () => href,
        usePermissions: () => permissions,
    };
});

import EntraProviderWizard from '@/app/t/[tenantSlug]/(app)/admin/entra/page';

const en = require('../../messages/en.json');
const E = en.admin.entra;

const SIGN_IN_APP = {
    clientId: '33333333-3333-4333-8333-333333333333',
    redirectUri: 'https://app.example/api/auth/callback/microsoft-entra-id',
};
const CONFIG = {
    aadTenantId: '11111111-1111-4111-8111-111111111111',
    clientId: '22222222-2222-4222-8222-222222222222',
    groupClaimMode: 'securityGroup',
    enforceGroupGate: false,
};

type Reply = { status: number; body: unknown };
function serve(provider: Reply, mappings: Reply = { status: 200, body: [] }, add?: Reply) {
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
        const path = String(url);
        const reply = path.endsWith('/sso/entra')
            ? provider
            : init?.method === 'POST' && add
              ? add
              : mappings;
        return { ok: reply.status < 300, status: reply.status, json: async () => reply.body } as unknown as Response;
    }) as unknown as typeof fetch;
}

afterEach(cleanup);

describe('step 1: the Microsoft app sign-in uses', () => {
    it("names the deployment's app and its redirect URI, in words, with no internal name", async () => {
        serve({ status: 200, body: { config: null, signInApp: SIGN_IN_APP } });
        render(<EntraProviderWizard />);
        expect(await screen.findByText(SIGN_IN_APP.clientId)).toBeTruthy();
        expect(document.getElementById('entra-redirect-uri')?.textContent).toBe(SIGN_IN_APP.redirectUri);
        expect(screen.getByText(E.signInApp.consent)).toBeTruthy();
        const text = document.body.textContent ?? '';
        expect(text).not.toMatch(/\bIC\b|IC_URL|Create an App Registration/);
    });

    it('says when the stored client ID is not the app sign-in uses, and not when it is', async () => {
        serve({ status: 200, body: { id: 'p1', isEnabled: true, config: CONFIG, signInApp: SIGN_IN_APP } });
        render(<EntraProviderWizard />);
        expect(await screen.findByText(E.clientIdNotSignInApp)).toBeTruthy();
        cleanup();

        serve({
            status: 200,
            body: { id: 'p1', isEnabled: true, config: { ...CONFIG, clientId: SIGN_IN_APP.clientId.toUpperCase() }, signInApp: SIGN_IN_APP },
        });
        render(<EntraProviderWizard />);
        await screen.findByDisplayValue(CONFIG.aadTenantId);
        expect(screen.queryByText(E.clientIdNotSignInApp)).toBeNull();
    });
});

describe('a failed read', () => {
    it('says the settings could not be loaded and keeps Save off, so nothing is overwritten', async () => {
        serve({ status: 500, body: { error: { message: 'boom' } } });
        render(<EntraProviderWizard />);
        expect(await screen.findByText(E.loadFailed)).toBeTruthy();
        expect((document.getElementById('entra-save-btn') as HTMLButtonElement).disabled).toBe(true);
    });

    it('says the mappings could not be loaded rather than that there are none', async () => {
        serve({ status: 200, body: { config: CONFIG, signInApp: SIGN_IN_APP } }, { status: 500, body: null });
        render(<EntraProviderWizard />);
        expect(await screen.findByText(E.mappings.loadFailed)).toBeTruthy();
        expect(screen.queryByText(E.mappings.emptyTitle)).toBeNull();
    });
});

describe('adding a mapping', () => {
    async function addWith(reply: Reply) {
        serve({ status: 200, body: { config: CONFIG, signInApp: SIGN_IN_APP } }, { status: 200, body: [] }, reply);
        render(<EntraProviderWizard />);
        await screen.findByText(E.mappings.emptyTitle);
        fireEvent.change(document.getElementById('entra-mapping-group-id')!, { target: { value: 'g-1' } });
        fireEvent.click(screen.getByRole('button', { name: E.mappings.addMapping }));
    }

    it("shows the server's own sentence for a refusal, not a guess from its status", async () => {
        await addWith({ status: 403, body: { error: { message: 'Only an Owner can map a group to AI admin.' } } });
        expect(await screen.findByText('Only an Owner can map a group to AI admin.')).toBeTruthy();
    });

    it('words a refused group ID by its field, and a duplicate as a duplicate', async () => {
        await addWith({
            status: 400,
            body: { error: { code: 'VALIDATION_ERROR', message: 'Invalid request payload', details: [{ path: ['aadGroupId'], message: 'Invalid uuid' }] } },
        });
        expect(await screen.findByText(E.mappings.errInvalidGuid)).toBeTruthy();
        cleanup();

        await addWith({ status: 409, body: { error: { message: 'A mapping for this Entra group already exists' } } });
        expect(await screen.findByText(E.mappings.errExists)).toBeTruthy();
    });
});

it('the breadcrumb leads back to the dashboard and admin', async () => {
    serve({ status: 200, body: { config: null, signInApp: SIGN_IN_APP } });
    render(<EntraProviderWizard />);
    await screen.findByText(SIGN_IN_APP.clientId);
    await waitFor(() => {
        const hrefs = Array.from(document.querySelectorAll('nav a')).map((a) => a.getAttribute('href'));
        expect(hrefs).toEqual(expect.arrayContaining(['/t/acme/dashboard', '/t/acme/admin']));
    });
});
