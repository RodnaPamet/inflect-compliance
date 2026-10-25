/**
 * The members page offers Deactivate and Remove on an OWNER's or an AI_ADMIN's
 * row only to an OWNER, and on nobody's own row.
 *
 * The server refuses anyone else (`deactivateTenantMember` /
 * `removeTenantMember` ask `admin.owner_management` for an OWNER or AI_ADMIN
 * target — AI_ADMIN since #4118 — and refuse the caller's own membership;
 * tests/unit/owner-membership-removal-authority.test.ts), so a viewer is not
 * shown a menu item that can only fail. Every "not offered" assertion is paired
 * with an "offered" one on the same menu, so a menu that rendered nothing at
 * all would fail here.
 *
 * A row on which the viewer can do nothing at all — a DEACTIVATED OWNER, for an
 * ADMIN — has no three-dot trigger: it used to open an empty menu.
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

const member = (id: string, role: string, extra: { userId?: string; status?: string } = {}) => ({
    id,
    userId: extra.userId ?? `u-${id}`,
    role,
    customRoleId: null,
    customRole: null,
    status: extra.status ?? 'ACTIVE',
    invitedAt: null,
    deactivatedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    user: { id: `u-${id}`, name: `Person ${id}`, email: `${id}@example.com`, image: null, createdAt: '2026-01-01' },
    invitedBy: null,
    activeSessionCount: 0,
});

const MEMBERS = [
    member('m-owner', 'OWNER'),
    member('m-editor', 'EDITOR'),
    member('m-ai', 'AI_ADMIN'),
    // The viewer's own membership (`userId: 'viewer'` in the provider below).
    member('m-self', 'ADMIN', { userId: 'viewer' }),
    member('m-gone-owner', 'OWNER', { status: 'DEACTIVATED' }),
];

function renderAs(role: Extract<Role, 'OWNER' | 'ADMIN'>) {
    global.fetch = jest.fn(async (url: unknown) => {
        const u = String(url);
        const body = u.includes('view=invites') ? [] : u.endsWith('/admin/members') ? MEMBERS : [];
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

/**
 * Let the page's fetches land. Each one that changes state re-derives the column
 * defs and REMOUNTS the cells, so every helper re-queries at the moment it acts.
 */
async function settled() {
    await waitFor(() => expect((global.fetch as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(3));
    await new Promise((r) => setTimeout(r, 50));
}

/** Open a member's three-dot menu and return the ids of the items it offers. */
async function menuItems(memberId: string): Promise<string[]> {
    await settled();
    return waitFor(() => {
        const sessions = byId(`action-view-sessions-${memberId}`);
        if (!sessions) {
            const trigger = byId(`member-menu-${memberId}`);
            if (!trigger) throw new Error(`member-menu-${memberId} never rendered`);
            fireEvent.click(trigger);
            throw new Error('the menu did not open yet');
        }
        return ['change-role', 'view-sessions', 'deactivate', 'remove'].filter((a) => byId(`action-${a}-${memberId}`));
    });
}

describe('members page — ending an OWNER membership', () => {
    it('an ADMIN is not offered Deactivate or Remove on an OWNER, and still sees the rest of the menu', async () => {
        renderAs('ADMIN');
        const items = await menuItems('m-owner');
        expect(items).toContain('view-sessions');
        expect(items).not.toContain('deactivate');
        expect(items).not.toContain('remove');
    });

    it('an ADMIN is still offered both on an EDITOR', async () => {
        renderAs('ADMIN');
        expect(await menuItems('m-editor')).toEqual(expect.arrayContaining(['deactivate', 'remove']));
    });

    it('an OWNER is offered both on another OWNER', async () => {
        renderAs('OWNER');
        expect(await menuItems('m-owner')).toEqual(expect.arrayContaining(['deactivate', 'remove']));
    });
});

describe('members page — ending an AI_ADMIN membership (#4118)', () => {
    it('an ADMIN is not offered Deactivate or Remove on an AI_ADMIN, and still sees the rest of the menu', async () => {
        renderAs('ADMIN');
        const items = await menuItems('m-ai');
        expect(items).toContain('view-sessions');
        expect(items).not.toContain('deactivate');
        expect(items).not.toContain('remove');
    });

    it('an OWNER is offered both on an AI_ADMIN', async () => {
        renderAs('OWNER');
        expect(await menuItems('m-ai')).toEqual(expect.arrayContaining(['deactivate', 'remove']));
    });
});

describe('members page — your own row', () => {
    it.each(['ADMIN', 'OWNER'] as const)('%s: not offered Deactivate or Remove on their own row', async (role) => {
        renderAs(role);
        const items = await menuItems('m-self');
        expect(items).toContain('view-sessions');
        expect(items).not.toContain('deactivate');
        expect(items).not.toContain('remove');
    });
});

describe('members page — a row with no actions has no menu', () => {
    it('an ADMIN gets no three-dot trigger on a DEACTIVATED OWNER, while an EDITOR row keeps its own', async () => {
        renderAs('ADMIN');
        await settled();
        await waitFor(() => expect(byId('member-menu-m-editor')).not.toBeNull());
        expect(byId('member-menu-m-gone-owner')).toBeNull();
    });

    it('an OWNER does get one on that row, offering Remove only', async () => {
        renderAs('OWNER');
        await settled();
        const trigger = await waitFor(() => {
            const el = byId('member-menu-m-gone-owner');
            if (!el) throw new Error('member-menu-m-gone-owner never rendered');
            return el;
        });
        const items = await waitFor(() => {
            const remove = byId('action-remove-m-gone-owner');
            if (!remove) {
                fireEvent.click(byId('member-menu-m-gone-owner') ?? trigger);
                throw new Error('the menu did not open yet');
            }
            return ['change-role', 'view-sessions', 'deactivate', 'remove'].filter((a) =>
                byId(`action-${a}-m-gone-owner`),
            );
        });
        expect(items).toEqual(['remove']);
    });
});
