/**
 * The members page and a custom role only an ADMIN membership may carry
 * (owner decision, 2026-10-30): one built on ADMIN, or one granting an admin
 * key consumed only behind the admin API.
 *
 * The picker asks the server's own predicate (`customRoleCarriageRefusal`), so
 * on the page:
 *
 *   - such a custom role is offered to an EDITOR, but not choosable, with the
 *     reason; choosing ADMIN as the role makes it choosable;
 *   - moving an ADMIN who carries one to another role shows why Save is held,
 *     until the custom role is changed — and then both are sent together;
 *   - a member who already carries one (data from before the rule) is held back
 *     from nothing that adds nothing;
 *   - the server's refusal is re-said with the permission grid's labels.
 *
 * Every "not choosable" assertion is paired with a "choosable" one on the same
 * render path.
 */
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
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';

const en = require('../../messages/en.json');
const M = en.admin.members;

function blob(base: 'ADMIN' | 'READER', admin: Partial<PermissionSet['admin']> = {}) {
    const d = getPermissionsForRole(base);
    return { ...d, admin: { ...d.admin, ...admin } };
}

const ROLES = [
    { id: 'cr-plain', name: 'Plain readers', baseRole: 'READER', permissionsJson: blob('READER'), isActive: true },
    {
        id: 'cr-card',
        name: 'Card editors',
        baseRole: 'READER',
        permissionsJson: blob('READER', { agent_policy_card: true }),
        isActive: true,
    },
    { id: 'cr-admin', name: 'Admin built', baseRole: 'ADMIN', permissionsJson: blob('ADMIN'), isActive: true },
];

const member = (id: string, role: string, customRoleId: string | null = null) => ({
    id,
    userId: `u-${id}`,
    role,
    customRoleId,
    customRole: customRoleId ? { id: customRoleId, name: ROLES.find((r) => r.id === customRoleId)!.name } : null,
    status: 'ACTIVE',
    invitedAt: null,
    deactivatedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    user: { id: `u-${id}`, name: `Person ${id}`, email: `${id}@example.com`, image: null, createdAt: '2026-01-01' },
    invitedBy: null,
    activeSessionCount: 0,
});

const MEMBERS = [
    member('m-editor', 'EDITOR'),
    member('m-admin', 'ADMIN', 'cr-admin'),
    member('m-admin-2', 'ADMIN'),
    member('m-legacy', 'EDITOR', 'cr-card'),
];

function mount(patch: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: {} }) {
    global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (init?.method === 'PATCH') return { ok: patch.ok, status: patch.status, json: async () => patch.body } as unknown as Response;
        const body = u.includes('view=invites')
            ? []
            : u.endsWith('/admin/roles')
              ? ROLES
              : u.endsWith('/admin/members')
                ? MEMBERS
                : [];
        return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    render(
        <TooltipProvider>
            <TenantProvider
                value={{
                    userId: 'viewer',
                    tenantId: 'tenant-1',
                    tenantSlug: 'acme',
                    tenantName: 'Acme',
                    role: 'OWNER',
                    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
                    appPermissions: getPermissionsForRole('OWNER'),
                    membershipRole: 'OWNER',
                    modules: { processCanvas: false },
                }}
            >
                <MembersAdminPage />
            </TenantProvider>
        </TooltipProvider>,
    );
}

const byId = (id: string) => document.getElementById(id);

async function settled() {
    await waitFor(() => expect((global.fetch as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(3));
    await new Promise((r) => setTimeout(r, 50));
}

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

const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
const optionNamed = (label: string) => options().find((o) => o.textContent?.trim() === label);

/** Open a picker and read, per option label, whether it can be chosen. */
async function choosable(triggerId: string): Promise<Record<string, boolean>> {
    return waitFor(() => {
        const el = byId(triggerId);
        if (!el) throw new Error(`${triggerId} never rendered`);
        if (options().length === 0) fireEvent.click(el);
        const shown = options();
        if (shown.length === 0) throw new Error('no options rendered');
        return Object.fromEntries(
            shown.map((o) => [o.textContent?.trim() ?? '', o.getAttribute('aria-disabled') !== 'true']),
        );
    });
}

/**
 * Choose `label` in the picker `triggerId`, reopening it if a remount closed
 * it, until `done()` holds. The clicks are bounded: each one re-renders the
 * page, and an unbounded loop of them starves the timer that would end the
 * wait, so a page that never reaches `done()` would hang instead of failing.
 */
async function choose(triggerId: string, label: string, done: () => boolean) {
    let clicks = 0;
    await waitFor(
        () => {
            if (done()) return;
            if (clicks < 20) {
                clicks += 1;
                const option = optionNamed(label);
                if (option) fireEvent.click(option);
                else fireEvent.click(byId(triggerId)!);
            }
            if (!done()) throw new Error(`chose ${label} in ${triggerId}, and the page never reached the expected state`);
        },
        { timeout: 3000 },
    );
}

const patches = () =>
    (global.fetch as jest.Mock).mock.calls
        .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
        .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) }));

describe('members page — a custom role only an ADMIN membership may carry', () => {
    it('is offered to an EDITOR but not choosable; a harmless one is', async () => {
        mount();
        await openEditor('m-editor');
        const picks = await choosable('custom-role-select-m-editor');
        expect(picks).toMatchObject({ 'Plain readers': true, 'Card editors': false, 'Admin built': false });
    });

    it('becomes choosable once ADMIN is chosen as the role', async () => {
        mount();
        await openEditor('m-editor');
        await choose('role-select-m-editor', en.roles.ADMIN, () => byId('role-select-m-editor')?.textContent?.includes(en.roles.ADMIN) ?? false);
        const picks = await choosable('custom-role-select-m-editor');
        expect(picks).toMatchObject({ 'Plain readers': true, 'Card editors': true, 'Admin built': true });
    });

    it('moving an ADMIN who carries one to EDITOR holds Save and says why, until the custom role changes', async () => {
        mount();
        await openEditor('m-admin');
        expect(byId('role-save-m-admin')).not.toBeDisabled();
        expect(byId('role-custom-role-admin-only-m-admin')).toBeNull();

        await choose('role-select-m-admin', en.roles.EDITOR, () => byId('role-custom-role-admin-only-m-admin') !== null);
        expect(byId('role-custom-role-admin-only-m-admin')).toHaveTextContent(
            M.customRoleNeedsAdminMembership.replace('{customRole}', 'Admin built'),
        );
        expect(byId('role-save-m-admin')).toBeDisabled();

        await choose('custom-role-select-m-admin', 'Plain readers', () => byId('role-custom-role-admin-only-m-admin') === null);
        expect(byId('role-save-m-admin')).not.toBeDisabled();
        fireEvent.click(byId('role-save-m-admin')!);
        await waitFor(() => expect(patches()).toHaveLength(1));
        expect(patches()[0]).toEqual({
            url: '/api/t/acme/admin/members/m-admin',
            body: { role: 'EDITOR', customRoleId: 'cr-plain' },
        });
    });

    it('a legacy carrier is held back from nothing that adds nothing: moved to READER, its own role still choosable', async () => {
        mount();
        await openEditor('m-legacy');
        await choose('role-select-m-legacy', en.roles.READER, () => byId('role-select-m-legacy')?.textContent?.includes(en.roles.READER) ?? false);
        expect(byId('role-custom-role-admin-only-m-legacy')).toBeNull();
        expect(byId('role-save-m-legacy')).not.toBeDisabled();
        const picks = await choosable('custom-role-select-m-legacy');
        expect(picks).toMatchObject({ 'Card editors': true, 'Admin built': false });
    });

    it("the server's refusal is re-said with the grid's labels, not keys", async () => {
        mount({
            ok: false,
            status: 409,
            body: {
                error: {
                    code: 'CONFLICT',
                    message: 'A custom role granting admin.agent_policy_card can only be carried by an ADMIN membership.',
                    details: { reason: 'CUSTOM_ROLE_ADMIN_KEYS_NEED_ADMIN_MEMBERSHIP', keys: ['admin.agent_policy_card'] },
                },
            },
        });
        await openEditor('m-editor');
        await choose('custom-role-select-m-editor', 'Plain readers', () =>
            byId('custom-role-select-m-editor')?.textContent?.includes('Plain readers') ?? false,
        );
        fireEvent.click(byId('role-save-m-editor')!);
        const notice = await waitFor(() => {
            const el = byId('members-error');
            if (!el) throw new Error('no refusal shown');
            return el;
        });
        expect(notice).toHaveTextContent(
            M.carriageRefusedKeys.replace(
                '{permissions}',
                `${en.admin.resourceLabels.admin}: ${en.admin.roles.actions.agent_policy_card}`,
            ),
        );
        expect(notice).not.toHaveTextContent('admin.agent_policy_card');
    });
});
