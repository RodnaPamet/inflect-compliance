/** @jest-environment jsdom */

/**
 * The Entra page shows an Admin the directory and client ID read-only.
 *
 * They decide whose Microsoft sign-ins the group mappings apply to, so setting
 * Entra up and changing them is Owner-tier
 * (tests/unit/entra-provider-usecase.test.ts holds the server's refusal).
 */
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/admin/entra',
    useSearchParams: () => new URLSearchParams(),
}));

// next-intl: the global manual mock in __mocks__/ resolves keys against messages/en.json.

const permissions = { admin: { view: true, manage: true, owner_management: false } };
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

const CONFIG = {
    aadTenantId: '11111111-1111-4111-8111-111111111111',
    clientId: '22222222-2222-4222-8222-222222222222',
    groupClaimMode: 'securityGroup',
    enforceGroupGate: false,
};

function serve(provider: unknown) {
    global.fetch = jest.fn(async (url: string) => ({
        ok: true,
        json: async () => (String(url).endsWith('/sso/entra') ? provider : []),
    })) as unknown as typeof fetch;
}

afterEach(() => {
    cleanup();
    permissions.admin.owner_management = false;
});

const field = (id: string) => document.getElementById(id) as HTMLInputElement;

describe('the Entra page and its directory', () => {
    it('shows an Admin the directory and client ID read-only, and the rest editable', async () => {
        serve({ id: 'p1', isEnabled: true, config: CONFIG });
        render(<EntraProviderWizard />);
        expect(await screen.findByText(/Only an Owner can change the directory or client ID/)).toBeTruthy();
        expect(field('aadTenantId').disabled).toBe(true);
        expect(field('clientId').disabled).toBe(true);
        expect(field('domains').disabled).toBe(false);
        expect((document.getElementById('entra-save-btn') as HTMLButtonElement).disabled).toBe(false);
    });

    it('does not let an Admin set Entra up', async () => {
        serve(null);
        render(<EntraProviderWizard />);
        expect(await screen.findByText(/Only an Owner can set up Microsoft Entra ID/)).toBeTruthy();
        expect((document.getElementById('entra-save-btn') as HTMLButtonElement).disabled).toBe(true);
    });

    it('lets an Owner change them', async () => {
        permissions.admin.owner_management = true;
        serve({ id: 'p1', isEnabled: true, config: CONFIG });
        render(<EntraProviderWizard />);
        expect(await screen.findByDisplayValue(CONFIG.aadTenantId)).toBeTruthy();
        expect(field('aadTenantId').disabled).toBe(false);
        expect(screen.queryByText(/Only an Owner can/)).toBeNull();
    });
});
