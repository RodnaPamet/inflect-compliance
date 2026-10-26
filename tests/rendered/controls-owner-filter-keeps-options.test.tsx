/**
 * Picking one owner in the Controls Owner filter must leave the others on
 * offer (#4275).
 *
 * The Owner options are built from the controls loaded, and the server answers
 * an Owner filter with that owner's controls only. So the list rebuilt from the
 * answer offered nobody else, and a second owner could never be picked. The
 * page now keeps every option the facet has offered.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.setTimeout(180_000);

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantSlug: 'acme', tenantName: 'Acme', permissions: {} }),
    usePermissions: () => ({}),
    useCurrentUserId: () => 'user-me',
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
                    s = s.replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
                }
            }
            return s;
        };
        t.rich = (key: string) => walk(walk(en, ns), key) ?? key;
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => {
    const searchParams = new URLSearchParams();
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
        usePathname: () => '/t/acme',
        useSearchParams: () => searchParams,
        useParams: () => ({ tenantSlug: 'acme' }),
    };
});

jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { ControlsClient } from '@/app/t/[tenantSlug]/(app)/controls/ControlsClient';
import { getPermissionsForRole } from '@/lib/permissions';

const en = require('../../messages/en.json');

type Row = React.ComponentProps<typeof ControlsClient>['initialControls'][number];
const control = (id: string, name: string, owner: { id: string; name: string; email: string }) =>
    ({
        id,
        code: id.toUpperCase(),
        annexId: null,
        name,
        status: 'NOT_STARTED',
        applicability: 'APPLICABLE',
        category: null,
        frequency: null,
        owner,
        ownerUserId: owner.id,
        _count: { evidenceLinks: 0, evidenceControlLinks: 0 },
        taskTotal: 0,
        taskDone: 0,
        frameworks: [],
    }) as unknown as Row;

const ANA = { id: 'u-ana', name: 'Ana Ader', email: 'ana@example.test' };
const BEA = { id: 'u-bea', name: 'Bea Bauer', email: 'bea@example.test' };
const ROWS = [control('ctl-1', 'Access review', ANA), control('ctl-2', 'Backup test', BEA)];
const OWNER_OF: Record<string, string> = { 'ctl-1': ANA.id, 'ctl-2': BEA.id };

const ownerQueries: string[] = [];

beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/t/acme/controls');
    ownerQueries.length = 0;
    // The server's half of the bug: an Owner filter answers with that
    // owner's controls only.
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'https://test.local');
        let body: unknown = {};
        if (url.pathname.endsWith('/controls')) {
            const owners = url.searchParams.get('ownerUserId');
            if (owners) ownerQueries.push(owners);
            const picked = owners?.split(',');
            const rows = picked ? ROWS.filter((r) => picked.includes(OWNER_OF[r.id])) : ROWS;
            body = { rows, truncated: false };
        }
        return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => body,
            text: async () => JSON.stringify(body),
        } as unknown as Response;
    }) as unknown as typeof fetch;
});

it('after one owner is picked, the Owner filter still offers the other', async () => {
    const perms = getPermissionsForRole('EDITOR');
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TooltipProvider>
                <ControlsClient
                    initialControls={ROWS}
                    tenantSlug="acme"
                    permissions={{ canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true }}
                    appPermissions={{
                        controls: { create: perms.controls.create, edit: perms.controls.edit },
                        tasks: { edit: perms.tasks.edit, assign: perms.tasks.assign },
                    evidence: { upload: true },
                    risks: { create: true },
                        admin: { manage: perms.admin.manage },
                    }}
                />
            </TooltipProvider>
        </SWRConfig>,
    );
    await screen.findAllByText('Backup test');

    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: en.common.ui.filter }));
    });
    await act(async () => {
        fireEvent.click(await screen.findByRole('option', { name: new RegExp(`^${en.controls.filters.owner}`) }));
    });
    await act(async () => {
        fireEvent.click(await screen.findByRole('option', { name: new RegExp(ANA.name) }));
    });

    // The server has answered the Owner filter with Ana's controls only.
    await waitFor(() => expect(ownerQueries).toContain(ANA.id));
    await waitFor(() => expect(screen.queryAllByText('Backup test')).toHaveLength(0));

    // Bea is still on offer, so a second owner can be picked.
    expect(await screen.findByRole('option', { name: new RegExp(BEA.name) })).toBeTruthy();
});
