/**
 * "Change role" in a member's row menu opens the same editor as the role
 * badge: seeded from the member's current custom role, and offered only on a
 * row whose role the viewer may change.
 *
 * The menu used to set the editing row and the built-in role but not the
 * pending custom role, so the editor opened on whatever the last edit left
 * there — null on a fresh page, or another member's. `handleRoleChange` sends
 * any difference from the member's stored `customRoleId`, so pressing Save
 * without touching anything cleared the member's custom role, or gave them
 * someone else's. The menu also skipped the badge's `editable` rule, so an
 * ADMIN was offered an OWNER's role change that the server refuses
 * (`OWNER_MANAGED_ROLES`).
 */
import type { Role } from '@prisma/client';
import * as React from 'react';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';

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

const CUSTOM_ROLES = [
    { id: 'cr-analyst', name: 'Risk analyst', baseRole: 'EDITOR', isActive: true },
    { id: 'cr-reviewer', name: 'Policy reviewer', baseRole: 'EDITOR', isActive: true },
];

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
    member('m-owner', 'OWNER'),
    member('m-analyst', 'EDITOR', { id: 'cr-analyst', name: 'Risk analyst' }),
    member('m-reviewer', 'EDITOR', { id: 'cr-reviewer', name: 'Policy reviewer' }),
];

function renderAs(role: Extract<Role, 'OWNER' | 'ADMIN'>) {
    global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (init?.method === 'PATCH') return { ok: true, json: async () => ({}) } as unknown as Response;
        const body = u.includes('view=invites')
            ? []
            : u.endsWith('/admin/members')
              ? MEMBERS
              : u.endsWith('/admin/roles')
                ? CUSTOM_ROLES
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

/**
 * Let the page's fetches land. Each one that changes state re-derives the column
 * defs and REMOUNTS the cells, so every helper re-queries at the moment it acts.
 */
async function settled() {
    await waitFor(() => expect((global.fetch as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(3));
    await waitFor(() => {
        if (!byId('member-menu-m-analyst')) throw new Error('member rows not rendered yet');
    });
    await new Promise((r) => setTimeout(r, 50));
}

/** Open a member's three-dot menu; resolves once its always-present item shows. */
async function openMenu(memberId: string) {
    await waitFor(() => {
        if (!byId(`action-view-sessions-${memberId}`)) {
            const trigger = byId(`member-menu-${memberId}`);
            if (!trigger) throw new Error(`member-menu-${memberId} never rendered`);
            fireEvent.click(trigger);
            throw new Error('the menu did not open yet');
        }
    });
}

/** Open the role editor from the row menu; resolves to the custom-role picker. */
async function changeRoleFromMenu(memberId: string): Promise<HTMLElement> {
    await openMenu(memberId);
    fireEvent.click(byId(`action-change-role-${memberId}`) as HTMLElement);
    return waitFor(() => {
        const picker = byId(`custom-role-select-${memberId}`);
        if (!picker) throw new Error('the role editor did not open');
        return picker;
    });
}

const patches = () => (global.fetch as jest.Mock).mock.calls.filter(([, init]) => init?.method === 'PATCH');

describe('members page — Change role from the row menu', () => {
    it("opens on the member's current custom role, and Save with no change writes nothing", async () => {
        renderAs('ADMIN');
        await settled();

        const picker = await changeRoleFromMenu('m-analyst');
        expect(picker).toHaveAccessibleName('Risk analyst');

        fireEvent.click(byId('role-save-m-analyst') as HTMLElement);
        await waitFor(() => expect(byId('role-save-m-analyst')).toBeNull());
        expect(patches()).toHaveLength(0);
    });

    it("does not carry one member's custom role into another member's editor", async () => {
        renderAs('ADMIN');
        await settled();

        // The badge seeds the editor with m-analyst's custom role; cancel it,
        // finding Cancel by its name: an icon-only button with no name is a
        // button a screen reader announces only as "button".
        fireEvent.click(byId('role-badge-m-analyst') as HTMLElement);
        await waitFor(() => expect(byId('custom-role-select-m-analyst')).toHaveAccessibleName('Risk analyst'));
        fireEvent.click(screen.getByRole('button', { name: 'Cancel role change' }));
        await waitFor(() => expect(byId('custom-role-select-m-analyst')).toBeNull());

        const picker = await changeRoleFromMenu('m-reviewer');
        expect(picker).toHaveAccessibleName('Policy reviewer');

        fireEvent.click(byId('role-save-m-reviewer') as HTMLElement);
        await waitFor(() => expect(byId('role-save-m-reviewer')).toBeNull());
        expect(patches()).toHaveLength(0);
    });

    it("is not offered to an ADMIN on an OWNER's row, and is on an EDITOR's", async () => {
        renderAs('ADMIN');
        await settled();

        await openMenu('m-owner');
        expect(byId('action-change-role-m-owner')).toBeNull();
        expect(byId('action-view-sessions-m-owner')).not.toBeNull();
        fireEvent.click(byId('member-menu-m-owner') as HTMLElement);

        await openMenu('m-analyst');
        expect(byId('action-change-role-m-analyst')).not.toBeNull();
    });

    it("is offered to an OWNER on another OWNER's row", async () => {
        renderAs('OWNER');
        await settled();

        await openMenu('m-owner');
        expect(byId('action-change-role-m-owner')).not.toBeNull();
    });
});
