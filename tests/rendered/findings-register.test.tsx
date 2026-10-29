/**
 * The Findings register (#4461), mounted with what the server page passes.
 *
 * - The "Finding" button and the per-row status actions are offered only to a
 *   role with the coarse write tier: `createFinding` and `updateFinding` both
 *   `assertCanWrite` and nothing more, so a Reader, Auditor or AI admin was
 *   shown both and refused.
 * - A refused status change says why. It used to flip the badge and flip it
 *   back with nothing said.
 * - The table has no bulk actions, so it shows no select column.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.setTimeout(60_000);

// `computePermissions` lives beside the server-side tenant resolver, which
// imports the Prisma client; the role ladder itself needs none of it.
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantSlug: 'acme', tenantName: 'Acme', permissions: {} }),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const make = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const v = walk(walk(en, ns), key);
            if (typeof v !== 'string') return key;
            let s = v;
            if (params) {
                for (const [p, val] of Object.entries(params)) {
                    s = s.replace(new RegExp(`\\{${p}(, number)?\\}`, 'g'), String(val));
                }
            }
            return s;
        };
        t.rich = (key: string) => walk(walk(en, ns), key) ?? key;
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

const mockNav = { searchParams: new URLSearchParams() };
jest.mock('next/navigation', () => {
    const router = {
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    };
    return {
        useRouter: () => router,
        usePathname: () => '/t/acme/findings',
        useSearchParams: () => mockNav.searchParams,
        useParams: () => ({ tenantSlug: 'acme' }),
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn(), dismiss: jest.fn() };
jest.mock('@inflect/ui/components/ui/hooks/use-toast', () => ({ useToast: () => mockToast }));

import type { Role } from '@prisma/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { FindingsClient } from '@/app/t/[tenantSlug]/(app)/findings/FindingsClient';
import { computePermissions } from '@/lib/tenant-context';

const en = require('../../messages/en.json');
const F = en.findings;

type Props = React.ComponentProps<typeof FindingsClient>;
type Row = Props['initialFindings'][number];

const ROW: Row = {
    id: 'finding-1',
    title: 'Access reviews not performed quarterly',
    severity: 'HIGH',
    type: 'NONCONFORMITY',
    status: 'OPEN',
    owner: null,
    assignee: null,
    control: null,
    audit: null,
    _count: { riskLinks: 0 },
};

const TRANSLATIONS: Props['translations'] = {
    title: F.title,
    listDescription: F.listDescription,
    open: F.open,
    newFinding: F.newFinding,
    findingTitle: F.findingTitle,
    severity: F.severity,
    type: F.type,
    owner: F.owner,
    status: F.status,
    description: F.description,
    dueDate: F.dueDate,
    createFinding: F.createFinding,
    noFindings: F.noFindings,
    low: F.low,
    medium: F.medium,
    high: F.high,
    critical: F.critical,
    nonconformity: F.nonconformity,
    observation: F.observation,
    opportunity: F.opportunity,
    inProgress: F.inProgress,
    readyForVerification: F.readyForVerification,
    closed: F.closed,
    cancel: en.common.cancel,
    actions: en.common.actions,
};

type FetchHandler = (url: string, init?: RequestInit) => { status: number; body: unknown } | undefined;
let handler: FetchHandler = () => undefined;
const calls: Array<{ url: string; method: string; body?: unknown }> = [];

beforeEach(() => {
    calls.length = 0;
    handler = () => undefined;
    mockNav.searchParams = new URLSearchParams();
    Object.values(mockToast).forEach((fn) => fn.mockReset());
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const custom = handler(url, init);
        const { status, body } = custom ?? {
            status: 200,
            body: /\/findings(\?|$)/.test(url) ? { rows: [ROW], truncated: false } : [],
        };
        return Promise.resolve({
            ok: status >= 200 && status < 300,
            status,
            json: () => Promise.resolve(body),
        });
    }) as unknown as typeof fetch;
});

function mount(role: Role, rows: Row[] = [ROW]) {
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TooltipProvider>
                <FindingsClient
                    initialFindings={rows}
                    tenantSlug="acme"
                    canWrite={computePermissions(role).canWrite}
                    translations={TRANSLATIONS}
                />
            </TooltipProvider>
        </SWRConfig>,
    );
}

const table = () => screen.getByTestId('findings-table');
const createButton = () => screen.queryByRole('button', { name: F.newFinding });

describe('the register offers writes to the roles the server lets write', () => {
    it.each<Role>(['OWNER', 'ADMIN', 'EDITOR'])('%s sees the Finding button and the status action', async (role) => {
        mount(role);
        await screen.findByText(ROW.title);
        expect(createButton()).toBeInTheDocument();
        expect(within(table()).getByRole('button', { name: F.inProgress })).toBeInTheDocument();
    });

    it.each<Role>(['READER', 'AUDITOR', 'AI_ADMIN'])('%s sees neither', async (role) => {
        mount(role);
        await screen.findByText(ROW.title);
        expect(createButton()).toBeNull();
        expect(within(table()).queryByRole('button', { name: F.inProgress })).toBeNull();
        // The column that held them is gone rather than left empty.
        expect(within(table()).queryByText(en.common.actions)).toBeNull();
    });
});

describe('a refused status change says why', () => {
    it("toasts the server's reason and puts the status back", async () => {
        const REFUSAL = 'Finding not found';
        handler = (url, init) =>
            init?.method === 'PUT' && url.endsWith('/findings/finding-1')
                ? { status: 404, body: { error: { code: 'NOT_FOUND', message: REFUSAL } } }
                : undefined;
        mount('EDITOR');
        const action = await within(table()).findByRole('button', { name: F.inProgress });
        await act(async () => {
            fireEvent.click(action);
        });
        await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(REFUSAL));
        expect(calls.some((c) => c.method === 'PUT' && (c.body as { status?: string })?.status === 'IN_PROGRESS')).toBe(true);
        // Rolled back by the time the reason is shown: the row is OPEN again,
        // so it offers OPEN's action and not the next one.
        expect(within(table()).getByRole('button', { name: F.inProgress })).toBeInTheDocument();
        expect(within(table()).queryByRole('button', { name: F.readyForVerification })).toBeNull();
    });

    it('falls back to a sentence of its own when the server gives none', async () => {
        handler = (_url, init) => (init?.method === 'PUT' ? { status: 500, body: null } : undefined);
        mount('EDITOR');
        const action = await within(table()).findByRole('button', { name: F.inProgress });
        await act(async () => {
            fireEvent.click(action);
        });
        await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(F.statusUpdateFailed));
    });
});

describe('the table has no select column', () => {
    it.each<Role>(['ADMIN', 'READER'])('%s gets no row checkboxes', async (role) => {
        mount(role);
        await screen.findByText(ROW.title);
        expect(within(table()).queryAllByRole('checkbox')).toHaveLength(0);
    });
});
