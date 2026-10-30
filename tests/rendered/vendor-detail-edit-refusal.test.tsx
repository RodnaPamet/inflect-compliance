/**
 * The vendor detail page's Edit form, when the server refuses a save (#4534).
 *
 * `saveEdit` used to handle `res.ok` alone: a refused PATCH did nothing — no
 * message, the form still open — so a user who renamed a vendor to a taken
 * name, or set Active without a reviewed assessment, saw Save "not work".
 *
 * Mounted through the real page with `fetch` answered per route. Each test
 * opens the form, saves, and reads what a user would see.
 */
import * as React from 'react';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.setTimeout(60_000);
configure({ asyncUtilTimeout: 10_000 });

// Every value is ONE instance: the page's loaders are `useCallback`s over
// `apiUrl`, and a fresh function per render re-runs the load effect forever.
jest.mock('@/lib/tenant-context-provider', () => {
    const permissions = { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true };
    const ctx = {
        tenantSlug: 'acme',
        tenantName: 'Acme',
        permissions,
        appPermissions: { tasks: { create: true, edit: true } },
    };
    const apiUrl = (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`;
    const href = (p: string) => `/t/acme${p}`;
    return {
        useTenantApiUrl: () => apiUrl,
        useTenantHref: () => href,
        useTenantContext: () => ctx,
        usePermissions: () => permissions,
        useCurrentUserId: () => 'user-1',
    };
});

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
                    s = s.replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
                }
            }
            return s;
        };
        t.rich = (key: string) => walk(walk(en, ns), key) ?? key;
        t.has = (key: string) => typeof walk(walk(en, ns), key) === 'string';
        return t;
    };
    return {
        useTranslations: (ns: string) => make(ns),
        useLocale: () => 'en',
        useFormatter: () => ({ dateTime: (d: Date) => d.toISOString(), number: (n: number) => String(n) }),
    };
});

jest.mock('next/navigation', () => {
    const searchParams = new URLSearchParams();
    const router = { push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() };
    return {
        useRouter: () => router,
        usePathname: () => '/t/acme/vendors/v1',
        useSearchParams: () => searchParams,
        useParams: () => ({ tenantSlug: 'acme', vendorId: 'v1' }),
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

import VendorDetailPage from '@/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page';

const VENDOR = {
    id: 'v1',
    name: 'Acme Cloud',
    legalName: null,
    websiteUrl: null,
    domain: null,
    country: null,
    description: null,
    criticality: 'MEDIUM',
    status: 'ONBOARDING',
    inherentRisk: null,
    residualRisk: null,
    dataAccess: null,
    isSubprocessor: false,
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    _count: { documents: 0, assessments: 0, links: 0 },
};

type PatchAnswer = { status: number; body: unknown } | 'throw';
let patchAnswer: PatchAnswer;
let patchCalls: number;

function json(status: number, body: unknown) {
    return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);
}

beforeEach(() => {
    patchCalls = 0;
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn((input: string, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'PATCH' && url.endsWith('/api/t/acme/vendors/v1')) {
            patchCalls += 1;
            if (patchAnswer === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
            return json(patchAnswer.status, patchAnswer.body);
        }
        if (method === 'GET' && url.endsWith('/api/t/acme/vendors/v1')) return json(200, VENDOR);
        return json(200, []);
    });
});

/**
 * A promise React's `use` reads synchronously: marked fulfilled up front, as
 * React marks one it has already awaited. A bare `Promise.resolve` suspends
 * the first render, and with no Suspense boundary jsdom shows nothing.
 */
function settled<T>(value: T): Promise<T> {
    return Object.assign(Promise.resolve(value), { status: 'fulfilled', value });
}

function mount() {
    return render(
        <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false, dedupingInterval: 0 }}>
            <VendorDetailPage params={settled({ tenantSlug: 'acme', vendorId: 'v1' })} />
        </SWRConfig>,
    );
}

async function openEditAndSave() {
    mount();
    const edit = await screen.findByRole('button', { name: /edit/i });
    fireEvent.click(edit);
    const save = await waitFor(() => {
        const el = document.getElementById('save-vendor-btn');
        if (!el) throw new Error('no save button yet');
        return el;
    });
    fireEvent.click(save);
    await waitFor(() => expect(patchCalls).toBe(1));
}

const envelope = (code: string, message: string, details?: unknown) => ({
    error: { code, message, requestId: 'req-1', ...(details !== undefined ? { details } : {}) },
});

describe('vendor detail — a refused save says why and keeps the form (#4534)', () => {
    it('a taken name is reported on the Name field, in the page’s own words', async () => {
        patchAnswer = {
            status: 409,
            body: envelope('CONFLICT', 'A vendor with this name already exists', { reason: 'VENDOR_NAME_TAKEN' }),
        };
        await openEditAndSave();
        expect(
            await screen.findByText('Another vendor already has this name. Choose a different name.'),
        ).toBeInTheDocument();
        expect(document.getElementById('save-vendor-btn')).not.toBeNull();
        expect(document.getElementById('vendor-edit-name')).toHaveAttribute('aria-invalid', 'true');
    });

    it('an activation without a reviewed assessment gets its own sentence', async () => {
        patchAnswer = {
            status: 400,
            body: envelope('BAD_REQUEST', 'Cannot activate vendor without a completed assessment review.', {
                reason: 'VENDOR_ACTIVATION_NEEDS_REVIEW',
            }),
        };
        await openEditAndSave();
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent(/can't be made Active until an assessment has been sent/);
        expect(document.getElementById('save-vendor-btn')).not.toBeNull();
    });

    it('a validation refusal shows each refused field’s reason, not "Invalid request payload"', async () => {
        patchAnswer = {
            status: 400,
            body: envelope('VALIDATION_ERROR', 'Invalid request payload', [
                { path: ['websiteUrl'], code: 'invalid_string', message: 'Website must be a full URL' },
            ]),
        };
        await openEditAndSave();
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Website must be a full URL');
        expect(alert).not.toHaveTextContent('Invalid request payload');
    });

    it('any other refusal shows the server’s reason', async () => {
        patchAnswer = { status: 403, body: envelope('FORBIDDEN', 'You do not have permission to edit vendors') };
        await openEditAndSave();
        expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission to edit vendors');
    });

    it('a network failure says the save failed', async () => {
        patchAnswer = 'throw';
        await openEditAndSave();
        expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save the vendor. Please try again.");
        expect(document.getElementById('save-vendor-btn')).not.toBeNull();
    });

    it('a successful save closes the form', async () => {
        patchAnswer = { status: 200, body: { ...VENDOR, name: 'Acme Cloud Ltd' } };
        await openEditAndSave();
        await waitFor(() => expect(document.getElementById('save-vendor-btn')).toBeNull());
        expect(screen.queryByRole('alert')).toBeNull();
    });
});
