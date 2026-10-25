/**
 * A refused control create or template install shows the SERVER's reason
 * (#4126, the same family as the evidence "[object Object]" defects).
 *
 * Every API error body is the envelope `{ error: { code, message } }`. These
 * two read `typeof data.error === 'string' ? data.error : data.message`,
 * which is right for neither half of the envelope, so the server's reason
 * (a duplicate code, a plan limit, a missing permission) was dropped and the
 * generic fallback shown instead. They now go through `apiErrorMessage`.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

// A STABLE translator per namespace (the modal keys memos on `t`).
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    const resolve = (ns: string, key: string): unknown =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        if (cache.has(ns)) return cache.get(ns);
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).split(`{${p}}`).join(String(val));
            return v;
        };
        t.rich = (key: string) => {
            const v = resolve(ns, key);
            return typeof v === 'string' ? v : key;
        };
        t.has = (key: string) => typeof resolve(ns, key) === 'string';
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    usePathname: () => '/t/acme/controls',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => ({
        permissions: { canWrite: true, canAdmin: true, canRead: true },
        appPermissions: {},
        role: 'ADMIN',
        tenantSlug: 'acme',
    }),
    useTenantApiUrl: () => (path: string) =>
        `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantHref: () => (path: string) =>
        `/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

const TEMPLATES = [
    { id: 'tpl_1', code: 'A.5.1', title: 'Policies for information security', category: null, description: null },
];
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string | null) =>
        key === '/controls/templates'
            ? { data: TEMPLATES, isLoading: false, error: undefined, mutate: jest.fn() }
            : { data: undefined, isLoading: false, error: undefined, mutate: jest.fn() },
}));

import ControlTemplatesPage from '@/app/t/[tenantSlug]/(app)/controls/templates/page';
import { NewControlModal } from '@/app/t/[tenantSlug]/(app)/controls/NewControlModal';

const fetchMock = jest.fn();
function json(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
        headers: new Headers({ 'content-type': 'application/json' }),
    } as unknown as Response;
}

beforeEach(() => {
    fetchMock.mockReset();
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

function withSWR(ui: React.ReactNode) {
    return <SWRConfig value={{ provider: () => new Map() }}>{ui}</SWRConfig>;
}

describe('control templates — install refused', () => {
    it("shows the server's reason, not the generic fallback", async () => {
        fetchMock.mockResolvedValue(
            json({ error: { code: 'PLAN_LIMIT', message: 'plan_limit_exceeded: control' } }, 403),
        );
        render(withSWR(<ControlTemplatesPage />));
        await screen.findByText('Policies for information security');
        // The page's own per-row checkbox (the header one comes first).
        const boxes = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
        fireEvent.click(boxes[boxes.length - 1]);
        expect(document.getElementById('install-selected-btn')).not.toBeDisabled();
        await act(async () => {
            fireEvent.click(document.getElementById('install-selected-btn') as HTMLElement);
        });
        await waitFor(() => expect(screen.getByText('plan_limit_exceeded: control')).toBeInTheDocument());
    });
});

describe('new control — create refused', () => {
    it("shows the server's reason, not the generic fallback", async () => {
        fetchMock.mockResolvedValue(
            json({ error: { code: 'CONFLICT', message: 'A control with code AC-1 already exists.' } }, 409),
        );
        render(withSWR(<NewControlModal open setOpen={() => {}} tenantSlug="acme" />));
        fireEvent.change(document.getElementById('control-name-input') as HTMLInputElement, {
            target: { value: 'Access reviews' },
        });
        await act(async () => {
            fireEvent.click(document.getElementById('create-control-btn') as HTMLElement);
        });
        await waitFor(() =>
            expect(document.getElementById('new-control-error')).toHaveTextContent(
                'A control with code AC-1 already exists.',
            ),
        );
    });
});
