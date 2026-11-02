/** @jest-environment jsdom */

/**
 * The vendor templates index survives a refused create, says when it could
 * not load, marks built-in templates, and counts in plurals (#4933).
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// A stable translator per namespace that resolves `{n, plural, …}`, so a
// plural message is checked as a reader sees it (the shared mock leaves it raw).
jest.mock('next-intl', () => {
    const shared = jest.requireActual('../../__mocks__/next-intl.js');
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const PLURAL = /\{(\w+),\s*plural,((?:\s*(?:=\d+|one|other)\s*\{[^{}]*\})+)\s*\}/g;
    const OPTION = /(=\d+|one|other)\s*\{([^{}]*)\}/g;
    const has = (params: Record<string, unknown> | undefined, name: string) =>
        !!params && Object.prototype.hasOwnProperty.call(params, name);
    const format = (str: string, params?: Record<string, unknown>) =>
        str
            .replace(PLURAL, (block: string, name: string, options: string) => {
                if (!has(params, name)) return block;
                const n = Number(params![name]);
                const forms = new Map<string, string>();
                for (const m of options.matchAll(OPTION)) forms.set(m[1], m[2]);
                const body = forms.get(`=${n}`) ?? (n === 1 ? forms.get('one') : undefined) ?? forms.get('other');
                return body === undefined ? block : body.split('#').join(String(n));
            })
            .replace(/\{(\w+)\}/g, (m: string, name: string) => (has(params, name) ? String(params![name]) : m));
    const translators = new Map<string, unknown>();
    return {
        ...shared,
        useTranslations: (ns: string) => {
            if (!translators.has(ns)) {
                const t = (key: string, params?: Record<string, unknown>) => {
                    const val = lookup(ns, key);
                    return typeof val === 'string' ? format(val, params) : key;
                };
                translators.set(ns, t);
            }
            return translators.get(ns);
        },
    };
});

// Stable, as the real provider's are: a new function each render would
// re-run the page's load effect forever.
jest.mock('@/lib/tenant-context-provider', () => {
    const href = (path: string) => `/t/acme${path}`;
    const apiUrl = (path: string) => `/api/t/acme${path}`;
    const ctx = { permissions: { canWrite: true } };
    return {
        useTenantHref: () => href,
        useTenantApiUrl: () => apiUrl,
        useTenantContext: () => ctx,
    };
});
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/vendor-templates',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import { VendorTemplatesIndexClient } from '@/app/t/[tenantSlug]/(app)/admin/vendor-templates/VendorTemplatesIndexClient';

const EN = jest.requireActual('../../messages/en.json') as {
    admin: { vendorTemplates: Record<string, string> };
};
const VT = EN.admin.vendorTemplates;

function template(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        key: `key-${id}`,
        version: 2,
        name: `Template ${id}`,
        description: null,
        isPublished: true,
        isGlobal: false,
        updatedAt: '2026-10-01T00:00:00.000Z',
        _count: { sections: 1, questions: 3 },
        ...overrides,
    };
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const refused = (status: number, body: unknown) => ({ ok: false, status, json: async () => body });

afterEach(() => {
    (global.fetch as jest.Mock | undefined)?.mockReset?.();
});

describe('vendor templates index', () => {
    it('shows a refused create as its message instead of crashing on the error object', async () => {
        global.fetch = jest
            .fn()
            .mockResolvedValueOnce(ok([]))
            .mockResolvedValueOnce(
                refused(409, { error: { code: 'CONFLICT', message: 'A template with this key already exists.' } }),
            ) as unknown as typeof fetch;
        render(<VendorTemplatesIndexClient />);
        await screen.findByText(VT.emptyTitle);

        fireEvent.change(document.getElementById('new-template-key')!, { target: { value: 'soc2' } });
        fireEvent.change(document.getElementById('new-template-name')!, { target: { value: 'SOC 2' } });
        fireEvent.click(document.getElementById('create-template-btn')!);

        expect(await screen.findByText('A template with this key already exists.')).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(VT.title);
    });

    it('says the templates could not load instead of showing an empty register', async () => {
        global.fetch = jest.fn().mockResolvedValue(refused(500, {})) as unknown as typeof fetch;
        render(<VendorTemplatesIndexClient />);

        expect(await screen.findByText(VT.loadFailed)).toBeInTheDocument();
        expect(screen.queryByText(VT.emptyTitle)).toBeNull();
    });

    it('marks a built-in template and counts sections and questions in plurals', async () => {
        global.fetch = jest
            .fn()
            .mockResolvedValue(ok([template('a', { isGlobal: true }), template('b')])) as unknown as typeof fetch;
        render(<VendorTemplatesIndexClient />);

        await waitFor(() => expect(screen.getByTestId('template-built-in-a')).toHaveTextContent(VT.builtIn));
        expect(screen.queryByTestId('template-built-in-b')).toBeNull();
        expect(screen.getByTestId('template-row-b')).toHaveTextContent('Version 2 · 1 section · 3 questions');
        expect(screen.getByTestId('template-row-b')).not.toHaveTextContent('(s)');
    });
});
