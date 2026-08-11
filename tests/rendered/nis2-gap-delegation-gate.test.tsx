/**
 * NIS2 gap — the delegation panel is gated on `admin.manage`, not `canWrite`.
 *
 * Assign / dispatch / finalize are all `requirePermission('admin.manage')` at
 * the API. The panel used to render on `canWrite`, which is TRUE for EDITOR
 * while `admin.manage` is false — so an EDITOR was shown a control surface
 * where every button 403s, and simply opening the page fired a denied read that
 * writes an immutable AUTHZ_DENIED row (Epic C.1).
 *
 * The load-bearing assertion is not "the panel is hidden" — it is that the
 * admin-only ENDPOINT IS NEVER REQUESTED for a non-admin. Hiding the panel
 * while still firing its read would look identical on screen and keep writing
 * the audit rows.
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme-corp' }),
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), replace: jest.fn() }),
    usePathname: () => '/t/acme-corp/audits/nis2-gap',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const cache = new Map<string, unknown>();
    const lookup = (ns: string, key: string) =>
        key
            .split('.')
            .reduce(
                (o: unknown, k) =>
                    o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined,
                (en as Record<string, unknown>)[ns],
            );
    const make = (ns: string) => {
        const t = ((key: string, params?: Record<string, unknown>) => {
            let v = lookup(ns, key);
            if (typeof v !== 'string') return key;
            if (params) {
                for (const [p, val] of Object.entries(params)) {
                    v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
                }
            }
            return v as string;
        }) as ((key: string, params?: Record<string, unknown>) => string) & Record<string, unknown>;
        // The real translator is a callable carrying these; the page uses
        // `tx.rich` for the CC BY disclaimer.
        t.has = (key: string) => typeof lookup(ns, key) === 'string';
        t.raw = (key: string) => lookup(ns, key);
        t.rich = (key: string) => lookup(ns, key) ?? key;
        return t;
    };
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) cache.set(ns, make(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

jest.mock('next-auth/react', () => ({ signOut: jest.fn(), signIn: jest.fn() }));

import { SWRConfig } from 'swr';
import { Nis2GapLifecycleClient } from '@/app/t/[tenantSlug]/(app)/audits/nis2-gap/Nis2GapLifecycleClient';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';

const ASSESSMENT_ID = 'asm-1';

/** A STANDALONE, still-open run — the one state that shows the real panel. */
const PAYLOAD = {
    history: [
        {
            id: ASSESSMENT_ID,
            source: 'STANDALONE',
            status: 'IN_PROGRESS',
            completedAt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            overall: 62,
            gapCount: 4,
            answered: 40,
            total: 116,
        },
    ],
    snapshots: [],
    latest: {
        score: {
            overall: 62,
            byDomain: [
                {
                    domainId: 1,
                    code: 'D1',
                    name: { en: 'Access control', de: 'Zugriff' },
                    score: 62,
                    answered: 8,
                    total: 10,
                },
            ],
        },
        gaps: [],
        fineExposureGaps: 0,
        answeredTotal: 40,
        questionTotal: 116,
    },
};

let requestedUrls: string[] = [];

function installFetch() {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async (url: string) => {
        requestedUrls.push(url);
        if (url.endsWith('/audits/nis2-gap')) {
            return { ok: true, json: async () => PAYLOAD };
        }
        if (url.includes('/assignments')) {
            // What the API actually does for a non-admin. If the gate regresses,
            // this is the row the product would be writing on every page view.
            return {
                ok: false,
                status: 403,
                json: async () => ({ error: { code: 'FORBIDDEN', message: 'forbidden' } }),
            };
        }
        return { ok: true, json: async () => ({ suggestions: [] }) };
    });
}

function ctxFor(role: 'OWNER' | 'EDITOR') {
    return {
        userId: 'user-1',
        tenantId: 'tenant-1',
        tenantSlug: 'acme-corp',
        tenantName: 'Acme Corp',
        role,
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: role === 'OWNER',
            canAudit: true,
            canExport: true,
        },
        appPermissions: getPermissionsForRole(role),
    };
}

function mount(role: 'OWNER' | 'EDITOR') {
    const perms = getPermissionsForRole(role);
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TenantProvider value={ctxFor(role)}>
                <TooltipProvider>
                    <Nis2GapLifecycleClient
                        tenantSlug="acme-corp"
                        canWrite
                        canManage={perms.admin.manage}
                    />
                </TooltipProvider>
            </TenantProvider>
        </SWRConfig>,
    );
}

beforeEach(() => {
    requestedUrls = [];
    installFetch();
});
afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

describe('NIS2 gap delegation panel — permission gate', () => {
    // The premise the whole fix rests on. If this ever flips, the gate is
    // gratuitous and the test above it is testing nothing.
    it('EDITOR has canWrite but not admin.manage', () => {
        const editor = getPermissionsForRole('EDITOR');
        expect(editor.admin.manage).toBe(false);
        expect(getPermissionsForRole('OWNER').admin.manage).toBe(true);
    });

    it('renders the panel for an admin', async () => {
        const { container } = mount('OWNER');
        await waitFor(() =>
            expect(container.querySelector('#nis2-gap-dispatch-btn')).toBeTruthy(),
        );
    });

    it('hides the panel from an EDITOR', async () => {
        const { container } = mount('EDITOR');
        // Wait for the page itself to render, so this is not just asserting
        // against an empty tree that has not loaded yet.
        await waitFor(() =>
            expect(container.querySelector('#nis2-gap-rerun-btn')).toBeTruthy(),
        );
        expect(container.querySelector('#nis2-gap-dispatch-btn')).toBeNull();
    });

    it('never requests the admin-only assignments endpoint for an EDITOR', async () => {
        const { container } = mount('EDITOR');
        await waitFor(() =>
            expect(container.querySelector('#nis2-gap-rerun-btn')).toBeTruthy(),
        );
        // The point of the gate: no denied read, so no AUTHZ_DENIED row.
        expect(requestedUrls.filter((u) => u.includes('/assignments'))).toHaveLength(0);
    });

    it('does request it for an admin', async () => {
        const { container } = mount('OWNER');
        await waitFor(() =>
            expect(container.querySelector('#nis2-gap-dispatch-btn')).toBeTruthy(),
        );
        await waitFor(() =>
            expect(requestedUrls.filter((u) => u.includes('/assignments')).length).toBeGreaterThan(0),
        );
    });
});
