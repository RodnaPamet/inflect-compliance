/**
 * The members page and the AI_ADMIN role (#3699 deploy 2).
 *
 * An OWNER assigns the role to an EXISTING member, here; nobody is invited
 * straight into it. So the page has two pickers that must disagree: the
 * role-CHANGE picker offers "AI admin" to an OWNER only, and the invite picker
 * never does. An AI_ADMIN member's row reads its label, and is not editable by
 * anyone who could not change it (an ADMIN). A member carrying a custom role is
 * not promoted until that custom role is gone, because an AI_ADMIN never
 * carries one.
 *
 * Every "not offered" assertion is paired with an "offered" one on the same
 * render path, so a picker that rendered nothing at all would fail here.
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
    member('m-ai', 'AI_ADMIN'),
    member('m-custom', 'EDITOR', { id: 'cr-1', name: 'Reviewers' }),
];

function renderAs(role: Extract<Role, 'OWNER' | 'ADMIN'>) {
    global.fetch = jest.fn(async (url: unknown) => {
        const u = String(url);
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

/**
 * Let the page's three fetches land. Each one that changes state re-derives the
 * column defs, and TanStack renders each `cell` function as its own component,
 * so a cell's DOM is REMOUNTED rather than updated: a node held across a
 * re-render is detached and a click on it does nothing. Every helper below
 * re-queries at the moment it acts.
 */
async function settled() {
    await waitFor(() => expect((global.fetch as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(3));
    // A plain timer, not `act`: the remounting cells keep React's queue busy
    // long enough that an `act` scope waits on all of it.
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

/** Open the inline role editor for a member. */
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

const optionLabels = () =>
    Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).map((o) => o.textContent?.trim() ?? '');

/** Open a Combobox trigger by id and list its option labels (the selected one floats first). */
async function openPicker(triggerId: string): Promise<string[]> {
    // Read the options in the same tick they are seen: a remount closes the list.
    return waitFor(() => {
        const el = byId(triggerId);
        if (!el) throw new Error(`${triggerId} never rendered`);
        if (optionLabels().length === 0) fireEvent.click(el);
        const labels = optionLabels();
        if (labels.length === 0) throw new Error('no options rendered');
        return labels;
    });
}

async function roleChangeOptions(id: string): Promise<string[]> {
    await openEditor(id);
    return openPicker(`role-select-${id}`);
}

describe('members page — AI_ADMIN', () => {
    it('an AI_ADMIN member reads its label, not the enum value', async () => {
        renderAs('OWNER');
        expect((await badge('m-ai')).textContent).toContain('AI admin');
        expect((await badge('m-ai')).textContent).not.toContain('AI_ADMIN');
    });

    it('an OWNER is offered "AI admin" when changing an existing member’s role', async () => {
        renderAs('OWNER');
        expect((await roleChangeOptions('m-reader')).sort()).toEqual(['AI admin', 'Admin', 'Auditor', 'Editor', 'Reader']);
    });

    it('an ADMIN is offered the same picker without it', async () => {
        renderAs('ADMIN');
        expect((await roleChangeOptions('m-reader')).sort()).toEqual(['Admin', 'Auditor', 'Editor', 'Reader']);
    });

    it('the invite picker never offers it, even to an OWNER', async () => {
        renderAs('OWNER');
        await settled();
        await waitFor(() => {
            if (byId('invite-role-select')) return;
            const btn = byId('invite-member-btn');
            if (!btn) throw new Error('invite-member-btn never rendered');
            fireEvent.click(btn);
            if (!byId('invite-role-select')) throw new Error('the invite form did not open');
        });
        expect((await openPicker('invite-role-select')).sort()).toEqual(['Admin', 'Auditor', 'Editor', 'Reader']);
    });

    it('an ADMIN cannot open the editor on an AI_ADMIN row, while the same click opens a READER row', async () => {
        renderAs('ADMIN');
        expect(await badge('m-ai')).toHaveAttribute('aria-disabled', 'true');
        for (let i = 0; i < 3; i++) {
            fireEvent.click(byId('role-badge-m-ai')!);
            await new Promise((r) => setTimeout(r, 30));
        }
        expect(byId('role-select-m-ai')).toBeNull();
        // The same gesture on a row the ADMIN may change does open it.
        await openEditor('m-reader');
        expect(byId('role-select-m-reader')).not.toBeNull();
    });

    it('an OWNER opens the editor on an AI_ADMIN row, and it offers no custom role', async () => {
        renderAs('OWNER');
        expect(await badge('m-ai')).not.toHaveAttribute('aria-disabled');
        await openEditor('m-ai');
        // The positive half — an EDITOR row's editor does offer a custom role —
        // is the first assertion of the next test, on the same render path.
        expect(byId('custom-role-select-m-ai')).toBeNull();
    });

    it('promoting a member who carries a custom role is blocked until it is removed', async () => {
        renderAs('OWNER');
        const options = await roleChangeOptions('m-custom');
        expect(options).toContain('AI admin');
        // Before choosing AI admin: the custom-role picker is there, Save is live.
        expect(byId('custom-role-select-m-custom')).not.toBeNull();
        expect(byId('role-save-m-custom')).not.toBeDisabled();

        // Choose "AI admin" — reopening the list if a remount closed it.
        await waitFor(() => {
            const shown = byId('role-custom-role-conflict-m-custom');
            if (shown) return shown;
            const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
                (o) => o.textContent?.trim() === 'AI admin',
            );
            if (option) fireEvent.click(option);
            else fireEvent.click(byId('role-select-m-custom')!);
            const el = byId('role-custom-role-conflict-m-custom');
            if (!el) throw new Error('conflict notice never rendered');
            return el;
        });
        expect(byId('role-custom-role-conflict-m-custom')?.textContent).toContain(
            'AI admin cannot carry a custom role',
        );
        expect(byId('role-save-m-custom')).toBeDisabled();
        expect(byId('custom-role-select-m-custom')).toBeNull();
    });
});
