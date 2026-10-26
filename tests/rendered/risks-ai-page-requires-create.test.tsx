/**
 * The AI-assisted risk assessment page (`/risks/ai`) opens only for a user who
 * can create risks (#4327).
 *
 * Applying its suggestions creates risks, so the generate and apply routes
 * take `risks.create` and their usecases the coarse write tier — the two gates
 * `riskCanCreate` combines, as for the Risk button and the import. The page
 * used to show its form to everyone and gate only its buttons, each on ONE
 * of the two: Generate and Apply on the granular key, Edit and Dismiss on the
 * tier. So a custom role holding one without the other was offered a button
 * the server then refused.
 *
 * Three users, because each half of the gate needs its own case: a gate on
 * the tier alone passes the second, a gate on the key alone the third.
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';
import { SWRConfig } from 'swr';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';

type Tier = { canRead: boolean; canWrite: boolean; canAdmin: boolean; canAudit: boolean; canExport: boolean };
const WRITE_TIER: Tier = { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true };
const READ_TIER: Tier = { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false };

let tier: Tier = WRITE_TIER;
let appPermissions: PermissionSet = getPermissionsForRole('EDITOR');

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({
        userId: 'u1', tenantId: 't1', tenantSlug: 'acme', tenantName: 'Acme', role: 'EDITOR',
        permissions: tier,
        appPermissions,
    }),
    usePermissions: () => appPermissions,
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const resolve = (ns: string, key: string) =>
        key.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
        );
    const make = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            let s = v;
            if (params) for (const [p, val] of Object.entries(params)) s = s.replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            return s;
        };
        t.rich = (key: string) => resolve(ns, key) ?? key;
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(), replace: jest.fn(), refresh: jest.fn(),
        back: jest.fn(), forward: jest.fn(), prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/risks/ai',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));

import AIRiskAssessmentPage from '@/app/t/[tenantSlug]/(app)/risks/ai/page';

const en = require('../../messages/en.json');

beforeEach(() => {
    tier = WRITE_TIER;
    appPermissions = getPermissionsForRole('EDITOR');
    global.fetch = jest.fn(async () => ({
        ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({}), text: async () => '{}',
    }) as unknown as Response) as unknown as typeof fetch;
});

const mount = () =>
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <AIRiskAssessmentPage />
        </SWRConfig>,
    );

function expectRefused() {
    expect(document.getElementById('ai-no-permission')).not.toBeNull();
    expect(screen.getByText(en.risks.ai.permissionRequired)).toBeTruthy();
    expect(screen.getByRole('link', { name: en.risks.ai.viewRegister })).toHaveAttribute('href', '/t/acme/risks');
    expect(document.getElementById('ai-generate-form')).toBeNull();
    expect(document.getElementById('ai-generate-btn')).toBeNull();
}

it('a user who can create risks gets the form and its Generate button', () => {
    mount();
    expect(document.getElementById('ai-generate-form')).not.toBeNull();
    expect(document.getElementById('ai-generate-btn')).not.toBeNull();
    expect(document.getElementById('ai-no-permission')).toBeNull();
});

it('the write tier without risks.create is refused the page', () => {
    appPermissions = {
        ...getPermissionsForRole('EDITOR'),
        risks: { ...getPermissionsForRole('EDITOR').risks, create: false },
    };
    mount();
    expectRefused();
});

it('risks.create without the write tier is refused the page', () => {
    // A custom role on a READER base that grants `risks.create`: the key
    // passes, the usecases' write tier does not.
    tier = READ_TIER;
    appPermissions = {
        ...getPermissionsForRole('READER'),
        risks: { ...getPermissionsForRole('READER').risks, create: true },
    };
    mount();
    expectRefused();
});
