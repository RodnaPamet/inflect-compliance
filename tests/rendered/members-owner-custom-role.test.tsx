/**
 * The members page and an OWNER's custom role (#3720).
 *
 * An OWNER membership never carries a custom role, and only an OWNER changes
 * an OWNER membership at all. So, on the page:
 *
 *   - an OWNER row is not editable by an ADMIN (the API refuses every change an
 *     ADMIN could ask for there — a role change, an assignment, a clear);
 *   - an OWNER's editor on an OWNER row offers no custom role;
 *   - a LEGACY OWNER row that already carries one shows an OWNER the only change
 *     it takes — removing it — and that sends `{ customRoleId: null }` alone.
 *
 * Every "not offered" assertion is paired with an "offered" one on the same
 * render path, so a page that rendered nothing at all would fail here.
 */
import type { Role } from '@prisma/client';
import * as React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/members',
    useSearchParams: () => new URLSearchParams(),
}));

import MembersAdminPage from '@/app/t/[tenantSlug]/(app)/admin/members/page';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getPermissionsForRole } from '@/lib/permissions';

const member = (id: string, role: string, customRole: { id: string; name: string } | null = null) => ({
    id,
    userId: `u-${id}`,
    role,
    customRoleId: customRole?.id ?? null,
    customRole,
    status: 'ACTIVE',
    invitedAt: null,
    deactivatedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    user: { id: `u-${id}`, name: `Person ${id}`, email: `${id}@example.com`, image: null, createdAt: '2026-01-01' },
    invitedBy: null,
    activeSessionCount: 0,
});

const MEMBERS = [
    member('m-reader', 'READER'),
    member('m-owner', 'OWNER'),
    member('m-legacy', 'OWNER', { id: 'cr-1', name: 'Reviewers' }),
];

function renderAs(role: Extract<Role, 'OWNER' | 'ADMIN'>) {
    global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (init?.method === 'PATCH') return { ok: true, json: async () => ({}) } as unknown as Response;
        const body = u.includes('view=invites')
            ? []
            : u.endsWith('/admin/roles')
              ? [{ id: 'cr-1', name: 'Reviewers', baseRole: 'READER', isActive: true }]
              : u.endsWith('/admin/members')
                ? MEMBERS
                : [];
        return { ok: true, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    render(
        <TooltipProvider>
            <TenantProvider
                value={{
                    userId: 'viewer',
                    tenantId: 'tenant-1',
                    tenantSlug: 'acme',
                    tenantName: 'Acme',
                    role,
                    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
                    appPermissions: getPermissionsForRole(role),
                    modules: { processCanvas: false },
                }}
            >
                <MembersAdminPage />
            </TenantProvider>
        </TooltipProvider>,
    );
}

const byId = (id: string) => document.getElementById(id);

/** Let the page's fetches land; cells REMOUNT on each, so helpers re-query when they act. */
async function settled() {
    await waitFor(() => expect((global.fetch as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(3));
    await new Promise((r) => setTimeout(r, 50));
}

const badge = async (id: string) => {
    await settled();
    return waitFor(() => {
        const el = byId(`role-badge-${id}`);
        if (!el) throw new Error(`role-badge-${id} never rendered`);
        return el;
    });
};

async function openEditor(id: string) {
    await settled();
    await waitFor(() => {
        if (byId(`role-select-${id}`)) return;
        const el = byId(`role-badge-${id}`);
        if (!el) throw new Error(`role-badge-${id} never rendered`);
        fireEvent.click(el);
        if (!byId(`role-select-${id}`)) throw new Error('the editor did not open');
    });
}

const patches = () =>
    (global.fetch as jest.Mock).mock.calls
        .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
        .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) }));

describe('members page — an OWNER never carries a custom role', () => {
    it('an ADMIN cannot open the editor on an OWNER row, while the same click opens a READER row', async () => {
        renderAs('ADMIN');
        expect(await badge('m-owner')).toHaveAttribute('aria-disabled', 'true');
        for (let i = 0; i < 3; i++) {
            fireEvent.click(byId('role-badge-m-owner')!);
            await new Promise((r) => setTimeout(r, 30));
        }
        expect(byId('role-select-m-owner')).toBeNull();
        await openEditor('m-reader');
        expect(byId('role-select-m-reader')).not.toBeNull();
    });

    it('an OWNER opens the editor on an OWNER row and is offered no custom role — a READER row offers one', async () => {
        renderAs('OWNER');
        await openEditor('m-owner');
        expect(byId('custom-role-select-m-owner')).toBeNull();
        expect(byId('role-remove-custom-role-m-owner')).toBeNull();
        fireEvent.click(byId('role-badge-m-reader') ?? document.body);
        await openEditor('m-reader');
        await waitFor(() => expect(byId('custom-role-select-m-reader')).not.toBeNull());
    });

    it('a legacy OWNER row carrying one offers an OWNER its removal, which sends { customRoleId: null } alone', async () => {
        renderAs('OWNER');
        await openEditor('m-legacy');
        const notice = await waitFor(() => {
            const el = byId('role-legacy-custom-role-m-legacy');
            if (!el) throw new Error('legacy notice never rendered');
            return el;
        });
        expect(notice.textContent).toContain('Owner cannot carry a custom role');
        // Nothing else to save on that row, and no picker to put another one on.
        expect(byId('role-save-m-legacy')).toBeDisabled();
        expect(byId('custom-role-select-m-legacy')).toBeNull();

        fireEvent.click(byId('role-remove-custom-role-m-legacy')!);
        await waitFor(() => expect(patches()).toHaveLength(1));
        expect(patches()[0]).toEqual({ url: expect.stringContaining('/admin/members/m-legacy'), body: { customRoleId: null } });
    });
});
