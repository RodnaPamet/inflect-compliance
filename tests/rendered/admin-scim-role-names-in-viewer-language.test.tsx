/**
 * The SCIM page's role-mapping note names each role in the reader's language.
 *
 * The note spelled the role names inside the sentence ("the Reader role",
 * "Editors and Auditors", "Admin and Owner"), so the Bulgarian copy carried
 * English role names. They now come from the one role vocabulary (`roles.*`)
 * as values, the same names the members page shows.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/scim',
    useSearchParams: () => new URLSearchParams(),
}));

let mockCatalog: Record<string, unknown> = {};
jest.mock('next-intl', () => {
    const resolve = (path: string) =>
        path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), mockCatalog);
    const fill = (v: string, values?: Record<string, unknown>) =>
        v.replace(/\{(\w+)\}/g, (m, name) => (values && typeof values[name] === 'string' ? String(values[name]) : m));
    const make = (ns: string) => {
        const t = (key: string, values?: Record<string, unknown>) => {
            const v = resolve(`${ns}.${key}`);
            return typeof v === 'string' ? fill(v, values) : key;
        };
        // Rich text: string values fill their placeholders; tags keep their
        // text. Split on the tag tokens and keep the text between them (a
        // test mock over our own catalogue, not a sanitiser).
        t.rich = (key: string, values?: Record<string, unknown>) => t(key, values).split(/<\/?\w+>/).join('');
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'bg' };
});

jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    const href = (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    return { useTenantApiUrl: () => apiUrl, useTenantHref: () => href };
});
jest.mock('@inflect/ui/components/ui/hooks/use-toast', () => ({ useToast: () => ({ success: jest.fn(), error: jest.fn() }) }));
jest.mock('@/components/admin/IdentityCrossLinks', () => ({ IdentityCrossLinks: () => null }));
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));

import ScimAdminPage from '@/app/t/[tenantSlug]/(app)/admin/scim/page';
import bg from '../../messages/bg.json';
import en from '../../messages/en.json';

const ROLE_KEYS = ['READER', 'EDITOR', 'AUDITOR', 'AI_ADMIN', 'ADMIN', 'OWNER'] as const;

function renderIn(catalog: Record<string, unknown>) {
    mockCatalog = catalog;
    global.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ tokens: [], scimEndpoint: 'https://app.example.com/api/scim/v2', isEnabled: false }),
    })) as unknown as typeof fetch;
    render(<ScimAdminPage />);
    // The note is the one paragraph that opens with the "role mapping" label.
    const lead = (catalog as typeof en).admin.scim.roleMapBody.match(/<b>(.*?)<\/b>/)![1];
    return screen.getByText((_, el) => el?.tagName === 'DIV' && (el.textContent ?? '').startsWith(lead));
}

describe('the SCIM role-mapping note', () => {
    it('names every role in Bulgarian, with no English role name left in the sentence', () => {
        const note = renderIn(bg);
        const text = note.textContent ?? '';
        for (const key of ROLE_KEYS) expect(text).toContain(bg.roles[key]);
        for (const key of ROLE_KEYS) expect(text).not.toContain(en.roles[key]);
        expect(text).not.toMatch(/\{\w+\}/);
    });

    it('names the same roles in English from the same vocabulary', () => {
        const note = renderIn(en);
        const text = note.textContent ?? '';
        for (const key of ROLE_KEYS) expect(text).toContain(en.roles[key]);
        expect(text).not.toMatch(/\{\w+\}/);
    });
});
