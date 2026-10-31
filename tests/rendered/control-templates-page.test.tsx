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
            // One level of ICU plural, enough for `{count, plural, one {…} other {…}}`.
            if (params)
                v = (v as string).replace(
                    /\{(\w+), plural, one \{([^{}]*)\} other \{([^{}]*)\}\}/g,
                    (_m, name: string, one: string, other: string) =>
                        (Number(params[name]) === 1 ? one : other).split('#').join(String(params[name])),
                );
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

const tenant = {
    current: {
        permissions: { canWrite: true, canAdmin: true, canRead: true },
        appPermissions: { controls: { create: true } } as { controls: { create: boolean } },
        role: 'ADMIN',
        tenantSlug: 'acme',
    },
};
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => tenant.current,
    useTenantApiUrl: () => (path: string) =>
        `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantHref: () => (path: string) =>
        `/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

const TEMPLATES = [
    { id: 'tpl_1', code: 'A.5.1', title: 'Policies for information security', category: 'Organizational', description: null },
    { id: 'tpl_2', code: 'A.5.2', title: 'Information security roles', category: 'Organizational', description: null },
];
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string | null) =>
        key === '/controls/templates'
            ? { data: TEMPLATES, isLoading: false, error: undefined, mutate: jest.fn() }
            : { data: undefined, isLoading: false, error: undefined, mutate: jest.fn() },
}));

import ControlTemplatesPage from '@/app/t/[tenantSlug]/(app)/controls/templates/page';
import { formatPlanLimitMessage } from '@/lib/billing/plan-limit-message';

/**
 * #4795 — the control templates page: what a refused install says, what an
 * unmatched search says, and that only an installer is offered a selection.
 */

const fetchMock = jest.fn();
function json(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

beforeEach(() => {
    fetchMock.mockReset();
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    tenant.current = {
        permissions: { canWrite: true, canAdmin: true, canRead: true },
        appPermissions: { controls: { create: true } },
        role: 'ADMIN',
        tenantSlug: 'acme',
    };
});

function withSWR(ui: React.ReactNode) {
    return <SWRConfig value={{ provider: () => new Map() }}>{ui}</SWRConfig>;
}

async function selectFirstAndInstall() {
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select A.5.1 Policies for information security' }));
    await act(async () => {
        fireEvent.click(document.getElementById('install-selected-btn') as HTMLElement);
    });
}

describe('control templates — refused install (#4795)', () => {
    it('says a plan-limit refusal in words', async () => {
        fetchMock.mockResolvedValue(
            json({
                error: {
                    code: 'FORBIDDEN',
                    message: formatPlanLimitMessage({ plan: 'FREE', resource: 'control', limit: 10, current: 8 }),
                },
            }, 403),
        );
        render(withSWR(<ControlTemplatesPage />));
        await selectFirstAndInstall();
        await waitFor(() =>
            expect(
                screen.getByText('Your plan allows 10 controls and this workspace has 8, so these templates would go over the limit. Install fewer, or upgrade the plan.'),
            ).toBeInTheDocument(),
        );
        expect(screen.queryByText(/plan_limit_exceeded/)).not.toBeInTheDocument();
    });

    it('a 5xx keeps the fallback, not the server text', async () => {
        fetchMock.mockResolvedValue(json({ error: { message: 'connection reset by peer' } }, 500));
        render(withSWR(<ControlTemplatesPage />));
        await selectFirstAndInstall();
        await waitFor(() => expect(screen.getByText('Failed to install templates')).toBeInTheDocument());
        expect(screen.queryByText('connection reset by peer')).not.toBeInTheDocument();
    });

    it('a template that no longer exists is reported apart from existing controls', async () => {
        fetchMock.mockResolvedValue(
            json([
                { templateCode: 'A.5.1', controlId: 'c1', tasksCreated: 0, requirementsLinked: 0, skipped: false },
                { templateCode: '', controlId: '', tasksCreated: 0, requirementsLinked: 0, skipped: true, unresolvedTemplateId: 'gone' },
            ]),
        );
        render(withSWR(<ControlTemplatesPage />));
        await selectFirstAndInstall();
        await waitFor(() => expect(document.getElementById('install-success')).toHaveTextContent('1 control installed.'));
        expect(document.getElementById('install-success')).not.toHaveTextContent('skipped');
        expect(document.getElementById('install-unresolved')).toBeInTheDocument();
    });
});

describe('control templates — search and selection (#4795)', () => {
    it('an unmatched search says so and offers to clear it', async () => {
        render(withSWR(<ControlTemplatesPage />));
        fireEvent.change(document.getElementById('templates-search') as HTMLInputElement, {
            target: { value: 'zzz-nothing' },
        });
        expect(screen.getByText('No templates match your search')).toBeInTheDocument();
        expect(screen.queryByText('No templates yet')).not.toBeInTheDocument();
        fireEvent.click(document.getElementById('templates-clear-search') as HTMLElement);
        expect(screen.getByText('Policies for information security')).toBeInTheDocument();
    });

    it('every tick box has a name', () => {
        render(withSWR(<ControlTemplatesPage />));
        expect(screen.getByRole('checkbox', { name: 'Select every template shown' })).toBeInTheDocument();
        expect(screen.getByRole('checkbox', { name: 'Select A.5.2 Information security roles' })).toBeInTheDocument();
    });

    it('a viewer who cannot create controls gets no selection and no install bar', () => {
        tenant.current = {
            ...tenant.current,
            appPermissions: { controls: { create: false } },
        };
        render(withSWR(<ControlTemplatesPage />));
        expect(screen.getByText('Policies for information security')).toBeInTheDocument();
        expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
        expect(document.getElementById('install-selected-btn')).toBeNull();
    });
});
